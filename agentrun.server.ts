/**
 * 内容生成的执行者 = 用户已经在 Paseo 里配好的 agent。
 *
 * 原来的 Rumen 自己 spawn `claude -p` / `codex exec`，要管超时、管进程、管解析。
 * 做成 Paseo 插件之后这一整层可以扔掉：`paseo.agents.create` 已经把 provider、
 * 凭据、流式输出、结构化输出都办好了，而且用的就是用户自己的订阅 ——
 * 不管 API key、不管计费。
 *
 * ## 三条护栏，一条都不能少
 *
 * 1. **airgapped 项目一个字都不发。** 由调用方在进来之前拦掉。
 * 2. **用户的 agent 在跑时降为 0 并发。** 你正在被 agent 服务时，
 *    后台分析不该跟你抢配额，也不该把你推到限流线上。这是礼貌，也是自保。
 * 3. **输出必须能校验。** 校验不过就重试，重试完还不过就**丢弃** ——
 *    落一条没法校验的内容进库，比没有内容糟得多。
 */

import type { PaseoApi } from "@getpaseo/client";

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
 * 一个都没有就抛 —— 这时候 UI 该说"去 Paseo 设置里配一个"，
 * 而不是默默什么都不做。
 */
export async function resolveProvider(paseo: PaseoApi, preferred: string | null): Promise<string> {
  if (preferred?.includes("/")) return preferred;
  const snapshot = await paseo.providers.snapshot().catch(() => null);
  const entries = (snapshot?.entries ?? []) as Array<{
    provider: string;
    enabled?: boolean;
    status?: unknown;
    models?: Array<{ id: string; isDefault?: boolean; isSelectable?: boolean }>;
  }>;
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const models = entry.models ?? [];
    const selectable = models.filter((model) => model.isSelectable !== false);
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
 * 从 agent 的最后一条消息里抠出 JSON。
 *
 * `outputSchema` 已经让绝大多数 provider 直接吐纯 JSON，但不是每家都保证。
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
  throw new GenerationInvalidError("no parsable JSON in the agent's final message");
}

export interface RunOptions<T> {
  paseo: PaseoApi;
  /** 任务标识，进 label 和标题，方便用户在 Paseo 里认出这是 Rumen 起的。 */
  task: string;
  prompt: string;
  /** JSON Schema，直接交给 provider 做结构化输出。 */
  schema: Record<string, unknown>;
  cwd: string;
  provider: string | null;
  timeoutMs: number;
  /** 校验 + 回指校验。抛错就重试。 */
  validate: (value: unknown) => T;
  /** 用户的 agent 在跑时是否让路。 */
  deferToUserAgents: boolean;
  /** 最多重试几次。输出格式不稳是已知问题，给两次。 */
  retries?: number;
}

export async function runStructured<T>(options: RunOptions<T>): Promise<T> {
  if (options.deferToUserAgents && await userAgentsBusy(options.paseo)) {
    throw new GenerationBusyError();
  }
  const provider = await resolveProvider(options.paseo, options.provider);
  const release = await acquire();
  try {
    let lastError: unknown = null;
    const attempts = (options.retries ?? 2) + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const prompt = attempt === 0
        ? options.prompt
        : `${options.prompt}\n\nThe previous attempt produced output that failed validation (${
          lastError instanceof Error ? lastError.message : String(lastError)
        }). Return only a single JSON object matching the schema, with no prose and no code fence.`;
      let handle;
      try {
        handle = await options.paseo.agents.create({
          config: { provider },
          cwd: options.cwd,
          prompt,
          outputSchema: options.schema,
          title: `Rumen · ${options.task}`,
          labels: { "rumen.task": options.task },
          autoArchive: true,
        });
      } catch (error) {
        // 起不来就没得重试了 —— 这是配置问题，不是输出格式问题
        throw error;
      }
      try {
        const result = await handle.waitForFinish(options.timeoutMs);
        if (result.status === "timeout") {
          lastError = new Error(`agent did not finish within ${Math.round(options.timeoutMs / 1000)}s`);
          continue;
        }
        if (result.status === "error") {
          lastError = new Error(result.error ?? "agent reported an error");
          continue;
        }
        if (!result.lastMessage?.trim()) {
          lastError = new Error("agent returned an empty message");
          continue;
        }
        return options.validate(extractJson(result.lastMessage));
      } catch (error) {
        lastError = error;
      } finally {
        // autoArchive 一般已经收了；收不掉也不该让它阻断结果
        await handle.archive().catch(() => {});
      }
    }
    throw new GenerationInvalidError(
      lastError instanceof Error ? lastError.message : String(lastError),
    );
  } finally {
    release();
  }
}
