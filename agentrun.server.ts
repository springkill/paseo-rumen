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
  /** 会话建好之后回调一次，让调用方把 agentId 记进任务状态。 */
  onAgent?: (agentId: string) => void;
}

export interface RunResult<T> {
  value: T;
  agentId: string | null;
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

export async function runStructured<T>(options: RunOptions<T>): Promise<RunResult<T>> {
  const shouldYield = options.initiator === "background" && options.deferToUserAgents;
  if (shouldYield && await userAgentsBusy(options.paseo)) {
    throw new GenerationBusyError();
  }
  const provider = await resolveProvider(options.paseo, options.provider);
  const release = await acquire();
  const outputPath = outputPathFor(options.runId);
  await mkdir(runsDirectory(), { recursive: true, mode: 0o700 });
  await rm(outputPath, { force: true }).catch(() => {});

  try {
    // ⚠️ **不要在 create 里带 prompt。**
    //
    // `create({prompt})` 之后紧接着 `waitForFinish()` 有竞态：那一轮还没在
    // daemon 里建立起来，`waitForFinish` 就直接返回 idle。实机上的后果是
    // 8 秒内烧光三次重试 —— 第一次"没产出"，第二次撞上 "already has an active
    // run"，第三次把正在搜索的 agent 强杀（transcript 里留下
    // "[Request interrupted by user for tool use]"）。
    //
    // `run(text)` 是 `sendAgentMessage` + `waitForFinish`：send 先把这一轮
    // 建立起来，然后才等。用它就没有这个窗口。
    //
    // 同理不设 `autoArchive` —— 实机上它在第 11 秒就把会话收走了，
    // 而 agent 还在干活。收尾我们自己按结果决定。
    const handle = await options.paseo.agents.create({
      config: { provider },
      cwd: options.cwd,
      outputSchema: options.schema,
      title: `Rumen · ${options.task}`,
      labels: { "rumen.task": options.task },
    });
    options.onAgent?.(handle.id);

    let lastError: unknown = null;
    const attempts = (options.retries ?? 2) + 1;
    const firstPrompt = `${options.prompt}${deliveryInstruction(outputPath)}`;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const text = attempt === 0
        ? firstPrompt
        // ⭐ 重试在**同一个会话**里追加，不新开 agent
        : `That attempt did not produce a usable result (${
          lastError instanceof Error ? lastError.message : String(lastError)
        }). Write the corrected JSON object to ${outputPath} and reply with just \`DONE\`.`;

      let finished;
      try {
        finished = await handle.run(text, { timeoutMs: options.timeoutMs });
      } catch (error) {
        // 上一轮其实还在跑（send 撞上活动轮次）—— 等它，而不是把这次重试烧掉
        if (error instanceof Error && /already has an active run/i.test(error.message)) {
          try {
            finished = await handle.waitForFinish(options.timeoutMs);
          } catch (waitError) {
            lastError = waitError;
            continue;
          }
        } else {
          lastError = error;
          continue;
        }
      }

      if (finished.status === "timeout") {
        lastError = new Error(`agent did not finish within ${Math.round(options.timeoutMs / 1000)}s`);
        continue;
      }
      if (finished.status === "error") {
        lastError = new Error(finished.error ?? "agent reported an error");
        continue;
      }

      // ① 约定的产物文件
      const fromFile = await readOutputFile(outputPath);
      if (fromFile !== null) {
        try {
          const value = options.validate(fromFile);
          // 成功了就把会话和产物都收掉 —— 内容已经进 Rumen 了。
          // 失败的**都留着**：会话给用户看 agent 做了什么，
          // 产物文件给排查用（"它到底写了什么才校验不过"）
          await handle.archive().catch(() => {});
          await rm(outputPath, { force: true }).catch(() => {});
          return { value, agentId: handle.id };
        } catch (error) {
          lastError = error;
          continue;
        }
      }
      // ② 退回去解析最后一条消息 —— provider 真的照 outputSchema 吐了 JSON 时走这条
      if (finished.lastMessage?.trim()) {
        try {
          const value = options.validate(extractJson(finished.lastMessage));
          await handle.archive().catch(() => {});
          await rm(outputPath, { force: true }).catch(() => {});
          return { value, agentId: handle.id };
        } catch (error) {
          lastError = error;
          continue;
        }
      }
      lastError = new Error(`agent produced neither ${outputPath} nor a parsable final message`);
    }

    throw new GenerationInvalidError(
      lastError instanceof Error ? lastError.message : String(lastError),
    );
  } finally {
    release();
  }
}
