/**
 * 内容生成的执行者 = 用户已经在 Paseo 里配好的 agent。
 *
 * ## ⚠️ 不能靠 `outputSchema` 拿结构化输出
 *
 * `agents.create({outputSchema})` 看起来是通用能力，**实际上只有 codex 和
 * opencode 两个 provider 消费它**；claude provider 整个忽略。实机上就是这么炸的：
 * 用 Opus 跑一次 wiki 生成，agent 像平常一样又搜又读，最后回一段散文，
 * 于是 "no parsable JSON in the agent's final message"。
 *
 * 所以这里换一个**与 provider 无关**的协议：
 *
 * 1. 告诉 agent 把 JSON **写到一个我们指定的文件**（写文件是所有 coding agent 都有的能力）
 * 2. 一轮结束后我们自己读那个文件
 * 3. 读不到再退回去解析最后一条消息
 *
 * 文件落在 Rumen 自己的数据目录下，不碰用户的仓库。
 *
 * ## 重试复用同一个会话
 *
 * 早先每次重试都 `agents.create` 一个新 agent，结果用户侧栏里出现两条
 * "Write Spring Boot learning guide…"。改成在同一个会话里追加一条纠正消息 ——
 * 既不刷屏，模型也能看到自己上一次错在哪。
 *
 * ## 三条护栏
 *
 * 1. **airgapped 项目一个字都不发**（调用方拦）
 * 2. **用户的 agent 在跑时降为 0 并发** —— 不跟你抢配额，也不把你推到限流线上
 * 3. **输出必须能校验**，校验不过就丢弃：落一条没法校验的内容进库，比没有内容糟得多
 */

import type { PaseoApi } from "@getpaseo/client";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./store.server";

export class GenerationBusyError extends Error {
  constructor() {
    super("Your own agent is running; Rumen generation yielded");
    this.name = "GenerationBusyError";
  }
}

export class NoProviderError extends Error {
  constructor() {
    super("No agent provider is available in Paseo");
    this.name = "NoProviderError";
  }
}

export class GenerationInvalidError extends Error {
  constructor(readonly detail: string) {
    super(`Agent output failed validation: ${detail}`);
    this.name = "GenerationInvalidError";
  }
}

/** 生成任务的落盘目录。**不在用户仓库里** —— 生成不该污染被观察的项目。 */
export function runsDirectory(): string {
  return join(dataDirectory(), "runs");
}

/** 全局并发闸。默认 1 —— 后台学习任务没有理由并行到跟用户抢资源。 */
const MAX_CONCURRENT = 1;
let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<() => void> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolveWaiter) => waiting.push(resolveWaiter));
  }
  active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
    waiting.shift()?.();
  };
}

/**
 * 用户自己的 agent 是不是正在跑。
 *
 * 只看 `running` —— `initializing` 的还没开始烧配额，`idle` 的已经停了。
 * 我们自己起的会话打了 label，不算数，否则第二个生成任务会被第一个挡住。
 */
export async function userAgentsBusy(paseo: PaseoApi): Promise<boolean> {
  try {
    const page = await paseo.agents.list({
      scope: "active",
      filter: { statuses: ["running"] },
      page: { limit: 50 },
    });
    return page.entries.some((entry) => entry.agent?.labels?.["rumen.task"] === undefined);
  } catch {
    // 问不出来就当没在跑。宁可多跑一次，也不要因为一次 RPC 失败就永远不生成
    return false;
  }
}

/**
 * 选一个 provider。
 *
 * 优先用用户在 Rumen 设置里指定的；没指定就挑 Paseo 里第一个可用的默认模型。
 */
export async function resolveProvider(paseo: PaseoApi, preferred: string | null): Promise<string> {
  if (preferred?.includes("/")) return preferred;
  const snapshot = await paseo.providers.snapshot().catch(() => null);
  const entries = (snapshot?.entries ?? []) as Array<{
    provider: string;
    enabled?: boolean;
    models?: Array<{ id: string; isDefault?: boolean; isSelectable?: boolean }>;
  }>;
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const selectable = (entry.models ?? []).filter((model) => model.isSelectable !== false);
    const chosen = selectable.find((model) => model.isDefault) ?? selectable[0];
    if (chosen) return `${entry.provider}/${chosen.id}`;
  }
  throw new NoProviderError();
}

/** 列出可选的 provider/model，给设置页用。 */
export async function listGenerationProviders(
  paseo: PaseoApi,
): Promise<Array<{ id: string; label: string }>> {
  const snapshot = await paseo.providers.snapshot().catch(() => null);
  const entries = (snapshot?.entries ?? []) as Array<{
    provider: string;
    enabled?: boolean;
    models?: Array<{ id: string; label?: string; isSelectable?: boolean }>;
  }>;
  const out: Array<{ id: string; label: string }> = [];
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    for (const model of entry.models ?? []) {
      if (model.isSelectable === false) continue;
      out.push({ id: `${entry.provider}/${model.id}`, label: `${entry.provider} · ${model.label ?? model.id}` });
    }
  }
  return out.slice(0, 60);
}

/**
 * 从一段文本里抠出 JSON。
 *
 * 三种形态都认：裸 JSON、```json 围栏、正文里夹着一个对象。
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  if (fenced?.[1]) candidates.push(fenced[1]);
  candidates.push(trimmed);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  throw new GenerationInvalidError("no parsable JSON");
}

/** 让 agent 把结果写到哪。绝对路径，且在 Rumen 自己的目录下。 */
export function outputPathFor(runId: string): string {
  return join(runsDirectory(), `${runId}.json`);
}

/**
 * 插在每个生成 prompt 末尾的交付协议。
 *
 * 写文件而不是"回一段 JSON"：coding agent 的最后一条消息几乎总是给人看的总结，
 * 而文件是它必须精确产出的工件。
 */
export function deliveryInstruction(outputPath: string): string {
  return `\n\n## How to deliver the result

Write the JSON object to this exact absolute path, using your file-writing tool:

    ${outputPath}

The file must contain **only** the JSON object — no prose, no markdown fence, no commentary.
Create parent directories if needed. After the file is written, reply with just \`DONE\`.

Do not print the JSON in your reply; the file is the deliverable.`;
}

export interface RunOptions<T> {
  paseo: PaseoApi;
  /** 任务标识，进 label 和标题，方便用户在 Paseo 里认出这是 Rumen 起的。 */
  task: string;
  /** 已经拼好的 prompt，**不含**交付协议 —— 交付协议由这里统一追加。 */
  prompt: string;
  /** JSON Schema。codex / opencode 认，claude 忽略 —— 所以它只是锦上添花。 */
  schema: Record<string, unknown>;
  cwd: string;
  provider: string | null;
  timeoutMs: number;
  /** 校验 + 回指校验。抛错就重试。 */
  validate: (value: unknown) => T;
  /**
   * 谁发起的。
   *
   * ⭐ **只有 `background` 才给用户的 agent 让路。**
   *
   * 原则是"你正在被 agent 服务时，后台分析不该跟你抢配额"。但用户**刚点下去的
   * 按钮**不是后台分析 —— 他正是为了这件事才点的，给它让路等于永远不干活。
   *
   * 实机上这条判错了会直接废掉整个功能：Paseo 的常态就是有 agent 在跑
   * （用户往往就是从一个 agent 会话里切过来点的按钮），于是每次点生成都收到
   * "你的 agent 正在跑，生成已让路"，而且怎么归档都没用 —— 挡路的是别的会话。
   */
  initiator: "user" | "background";
  deferToUserAgents: boolean;
  retries?: number;
  /** 用来生成落盘路径，同时也是这次运行的 id。 */
  runId: string;
  /** 重新生成时置 true —— 否则会直接捡起上次留下的产物。 */
  ignoreExistingArtifact?: boolean;
  /** 会话建好之后回调一次，让调用方把 agentId 记进任务状态。 */
  onAgent?: (agentId: string) => void;
}

export interface RunResult<T> {
  value: T;
  agentId: string | null;
}

/** 一轮的结果。`null` = 那一轮我们没等到（超时或出错）。 */
type TurnOutcome = { status: string; error: string | null; lastMessage: string | null } | null;
interface Settled {
  file: unknown | null;
  turn: TurnOutcome;
}

function asOutcome(result: {
  status: string;
  error: string | null;
  lastMessage: string | null;
}): TurnOutcome {
  return result;
}

async function readOutputFile(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return null;
    return extractJson(raw);
  } catch {
    return null;
  }
}

/**
 * 等产物文件出现。每 3 秒看一眼 —— 它是 agent 唯一必须精确产出的东西。
 *
 * ⚠️ **必须可取消。** 它常和"等轮次结束"一起 `Promise.race`，输的那一边
 * 如果继续轮询，就会留一串定时器挂到 deadline（wiki 是 45 分钟）——
 * 进程退不掉，测试直接卡死。
 */
async function waitForArtifact(
  path: string,
  deadline: number,
  cancelled: { value: boolean },
): Promise<unknown | null> {
  for (;;) {
    if (cancelled.value) return null;
    const value = await readOutputFile(path);
    if (value !== null) return value;
    const remaining = deadline - Date.now();
    if (remaining <= 0 || cancelled.value) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(3_000, remaining)));
  }
}

export async function runStructured<T>(options: RunOptions<T>): Promise<RunResult<T>> {
  const shouldYield = options.initiator === "background" && options.deferToUserAgents;
  if (shouldYield && await userAgentsBusy(options.paseo)) {
    throw new GenerationBusyError();
  }
  const outputPath = outputPathFor(options.runId);
  await mkdir(runsDirectory(), { recursive: true, mode: 0o700 });

  // ⭐ 上一次可能是我们先放弃、agent 后写完 —— 产物还躺在那儿。
  // 先捡一次：这让"再点一下重试"能零成本命中，而不是重新烧一遍配额。
  if (!options.ignoreExistingArtifact) {
    const existing = await readOutputFile(outputPath);
    if (existing !== null) {
      try {
        const value = options.validate(existing);
        await rm(outputPath, { force: true }).catch(() => {});
        return { value, agentId: null };
      } catch {
        // 存着的那份本来就不合格，删掉重来
        await rm(outputPath, { force: true }).catch(() => {});
      }
    }
  } else {
    await rm(outputPath, { force: true }).catch(() => {});
  }

  const provider = await resolveProvider(options.paseo, options.provider);
  const release = await acquire();

  try {
    // ⚠️ **不要在 create 里带 prompt。**
    //
    // `create({prompt})` 之后紧接着 `waitForFinish()` 有竞态：那一轮还没在
    // daemon 里建立起来，`waitForFinish` 就直接返回 idle。实机上的后果是
    // 8 秒内烧光三次重试，最后把正在搜索的 agent 强杀。
    //
    // 同理不设 `autoArchive` —— 实机上它在第 11 秒就把会话收走了。
    const handle = await options.paseo.agents.create({
      config: { provider },
      cwd: options.cwd,
      outputSchema: options.schema,
      title: `Rumen · ${options.task}`,
      labels: { "rumen.task": options.task },
    });
    options.onAgent?.(handle.id);

    const deadline = Date.now() + options.timeoutMs;
    let lastError: unknown = null;
    const attempts = (options.retries ?? 2) + 1;
    const firstPrompt = `${options.prompt}${deliveryInstruction(outputPath)}`;

    for (let attempt = 0; attempt < attempts && Date.now() < deadline; attempt += 1) {
      const text = attempt === 0
        ? firstPrompt
        // ⭐ 重试在**同一个会话**里追加，不新开 agent
        : `That attempt did not produce a usable result (${
          lastError instanceof Error ? lastError.message : String(lastError)
        }). Write the corrected JSON object to ${outputPath} and reply with just \`DONE\`.`;

      // ⭐ **盯产物文件，不是盯轮次。**
      //
      // 交付物是那个文件；轮次结束只是"该停止等待了"的其中一个信号。
      // 实机踩过：一次 Spring Boot wiki 跑了 20 分钟，我按 15 分钟的轮次超时
      // 判了失败，而 agent 五分钟后才把文件写完 —— 内容是好的，被我丢了。
      const raceArtifact = async (turn: Promise<TurnOutcome>): Promise<Settled> => {
        const cancelled = { value: false };
        try {
          const first = await Promise.race([
            turn.then((result) => ({ kind: "turn" as const, result })),
            waitForArtifact(outputPath, deadline, cancelled).then((value) => ({ kind: "file" as const, value })),
          ]);
          if (first.kind === "file" && first.value !== null) return { file: first.value, turn: null };
          // 轮次先结束：再看一眼文件，它可能刚落地
          const settledTurn = first.kind === "turn" ? first.result : await turn;
          return { file: await readOutputFile(outputPath), turn: settledTurn };
        } finally {
          // 不管谁先到，都把轮询停掉 —— 否则定时器挂到 deadline
          cancelled.value = true;
        }
      };

      const finish = (value: unknown): Promise<T> => Promise.resolve(options.validate(value));
      const succeed = async (value: unknown): Promise<RunResult<T>> => {
        const parsed = await finish(value);
        await handle.archive().catch(() => {});
        await rm(outputPath, { force: true }).catch(() => {});
        return { value: parsed, agentId: handle.id };
      };

      let settled: Settled;
      try {
        settled = await raceArtifact(
          handle.run(text, { timeoutMs: Math.max(1, deadline - Date.now()) }).then(asOutcome),
        );
      } catch (error) {
        // send 撞上活动轮次说明上一轮其实还在跑 —— 去等那一轮，别烧重试次数
        if (error instanceof Error && /already has an active run/i.test(error.message)) {
          settled = await raceArtifact(
            handle.waitForFinish(Math.max(1, deadline - Date.now())).then(asOutcome).catch(() => null),
          );
        } else {
          lastError = error;
          continue;
        }
      }

      if (settled.file !== null) {
        try {
          return await succeed(settled.file);
        } catch (error) {
          lastError = error;
          continue;
        }
      }
      if (settled.turn?.status === "error") {
        lastError = new Error(settled.turn.error ?? "agent reported an error");
        continue;
      }
      // provider 真的照 outputSchema 吐了 JSON 时走这条
      if (settled.turn?.lastMessage?.trim()) {
        try {
          return await succeed(extractJson(settled.turn.lastMessage));
        } catch (error) {
          lastError = error;
          continue;
        }
      }
      lastError = new Error(`agent produced neither ${outputPath} nor a parsable final message`);
    }

    // ⚠️ 失败时**不删产物、不归档会话**：agent 可能还在跑，等它写完，
    // 下次点重试就能零成本捡起来（见函数开头那段）
    throw new GenerationInvalidError(
      lastError instanceof Error ? lastError.message : String(lastError),
    );
  } finally {
    release();
  }
}
