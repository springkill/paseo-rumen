/**
 * 本地状态的持久化。
 *
 * 只有插件后端进程写这个文件，所以并发被收敛到一条队列里，
 * 不会出现两个写者互相覆盖。写是「临时文件 + rename」，中途断电不会留半个文件。
 *
 * ## 损坏时绝不覆盖
 *
 * 读不出来 / 解析不了的时候**抛错**，不静默换成空状态。
 * 一个把用户三个月学习记录悄悄清零的 bug，比一个报错难查一百倍。
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EvidenceKind, Privacy } from "./domain.shared";
import type { Locale } from "./i18n.shared";
import { forbiddenRoot } from "./roots.server";
import type { LearnedAlias, PendingPackage, TechCategory } from "./techmap.shared";

export interface StoredAnchor {
  file: string;
  line: number;
  snippet: string;
  layer: "manifest" | "config" | "source";
}

/**
 * 全局 TechEntity。
 *
 * ⭐ **它不挂项目。** 「A 项目的 Redis == B 项目的 Redis」在标识层天然成立，
 * 而不是靠后期同步。项目侧只存"本项目怎么用它"（{@link StoredProjectTech}）。
 */
export interface StoredTechEntity {
  id: string;
  name: string;
  category: TechCategory;
  worthLearning: boolean;
  /** `builtin` = 内置 alias 表；`learned` = agent 归类过并落库 */
  origin: "builtin" | "learned";
}

/** 「项目 × 技术」的用法边：本项目怎么用它、凭什么说用了它。 */
export interface StoredProjectTech {
  techId: string;
  version: string | null;
  confidence: number;
  evidence: StoredAnchor[];
  /** 哪些包在这个项目里指向了这个 TechEntity，排障和"凭什么"面板要用。 */
  packages: string[];
}

export interface StoredProject {
  id: string;
  workspaceIds: string[];
  name: string;
  root: string;
  privacy: Privacy;
  isGit: boolean;
  lastScanAt: number | null;
  truncated: boolean;
  technologies: StoredProjectTech[];
  /** 待归类的包。**它们不是技术栈**，归类之前不进技术栈列表。 */
  pending: PendingPackage[];
  /** 上次 commit 分析扫到的最新 sha，增量分析用。 */
  lastAnalyzedSha: string | null;
}

export interface StoredNode {
  id: string;
  techId: string;
  /** ⭐ 内容语言。同一个知识点可以有多语言版本，掌握度挂在 `groupId` 上而不是这里。 */
  lang: Locale;
  /**
   * 跨语言的稳定身份。
   *
   * ⭐ **掌握度和证据挂 `groupId`，不挂 `id`。**
   * 否则用户把界面从中文换成英文、重新生成一遍内容，
   * 三个月的学习记录就跟着旧的 `id` 一起失联了。
   */
  groupId: string;
  title: string;
  summary: string;
  difficulty: number;
  /** 前置知识点的 `groupId`。 */
  prerequisites: string[];
  keywords: string[];
  /** 用于 FQN 级匹配的符号名。短名只许做文件级粗筛，不许做链路判定。 */
  symbols: string[];
  origin: "generated" | "fallback";
}

export interface StoredEvidence {
  id: string;
  /** 知识点的 `groupId`（不是 `id`）。 */
  nodeGroupId: string;
  projectId: string | null;
  kind: EvidenceKind;
  reference?: string;
  createdAt: number;
}

export interface StoredSource {
  url: string;
  title: string;
  /** 1 官方文档 / 2 官方 blog、RFC / 3 上游源码与 issue / 4 其它 */
  authority: number;
}

export interface StoredWikiSection {
  heading: string;
  body: string;
  /** 指向 `sources` 的下标（0 起）。**空数组 = 无出处，UI 必须灰化并标角标。** */
  sourceRefs: number[];
}

/**
 * Shared 层 wiki —— 全局生成一次，所有项目复用。
 *
 * `(techId, majorVersion, lang)` 是缓存键。第 100 个 Node 项目绑进来时，
 * Express 的 Shared 层是零成本的。
 */
export interface StoredWiki {
  techId: string;
  majorVersion: string;
  lang: Locale;
  title: string;
  summary: string;
  sections: StoredWikiSection[];
  sources: StoredSource[];
  generatedAt: number;
  /** 有出处的段落占比。低于阈值要在 UI 上明说不可信 —— 不是删掉。 */
  sourcedRatio: number;
  schemaVersion: number;
}

export interface StoredQuestion {
  id: string;
  techId: string;
  nodeGroupId: string;
  lang: Locale;
  kind: "code" | "concept";
  prompt: string;
  /** 评分要点。**不下发给客户端。** */
  rubric: string[];
  /** 代码题引用的锚点，作答后展示。 */
  anchors: StoredAnchor[];
  createdAt: number;
  passed: boolean;
  attempts: number;
}

/**
 * 一次 agent 改动的观测记录。
 *
 * 两个用途：
 * 1. 回补 commit 归因里 0.6 那一档（"当时 agent 到底碰没碰这些文件"）
 * 2. 生成还债队列（{@link StoredReview}）
 */
export interface StoredObservation {
  id: string;
  projectId: string;
  agentId: string;
  /** 相对项目根。 */
  file: string;
  observedAt: number;
}

/**
 * 待审阅的 agent 改动 —— **还债队列**。
 *
 * 这是 `agent_wrote_reviewed` 唯一的产生路径，也是整个产品的核心闭环：
 * agent 写的代码要你真的读过才算还债。
 */
export interface StoredReview {
  id: string;
  projectId: string;
  agentId: string;
  file: string;
  /** 受影响的知识点 `groupId`。 */
  nodeGroupIds: string[];
  observedAt: number;
  /** 已还债的时间。null = 还欠着。 */
  reviewedAt: number | null;
}

export interface StoredSettings {
  /** `auto` = 按环境判定。用户的显式选择压过环境推断。 */
  locale: "auto" | Locale;
  /** 生成内容用哪个 provider（`provider/model` 格式）。null = 用 Paseo 的默认。 */
  provider: string | null;
  /** 你的 agent 在跑时让路，不跟你抢配额。 */
  deferToUserAgents: boolean;
}

export interface RumenState {
  version: 2;
  settings: StoredSettings;
  projects: StoredProject[];
  /** 全局 TechEntity 注册表。 */
  techs: StoredTechEntity[];
  nodes: StoredNode[];
  evidence: StoredEvidence[];
  wikis: StoredWiki[];
  questions: StoredQuestion[];
  aliases: LearnedAlias[];
  observations: StoredObservation[];
  reviews: StoredReview[];
}

export const DEFAULT_SETTINGS: StoredSettings = {
  locale: "auto",
  provider: null,
  deferToUserAgents: true,
};

const EMPTY: RumenState = {
  version: 2,
  settings: DEFAULT_SETTINGS,
  projects: [],
  techs: [],
  nodes: [],
  evidence: [],
  wikis: [],
  questions: [],
  aliases: [],
  observations: [],
  reviews: [],
};

/** 观测记录的保留期。只用来回补归因窗口，留太久没有意义还占地方。 */
export const OBSERVATION_RETENTION_MS = 45 * 86_400_000;

export function dataDirectory(): string {
  return process.env.RUMEN_DATA_DIR
    ?? join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "paseo-rumen");
}

export function statePath(): string {
  return join(dataDirectory(), "state.json");
}

let cached: RumenState | null = null;
let queue: Promise<unknown> = Promise.resolve();

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * v1 → v2 迁移。
 *
 * ⚠️ **v1 的技术栈、知识点、证据全部丢弃，只留项目身份和隐私级别。**
 *
 * 不是偷懒。v1 让每个未命中的包各自成一个 TechEntity，实测一个 workspace
 * 扫出 2293 个「技术栈」和 6945 个模板知识点；挂在这些伪知识点上的证据
 * 指向的东西根本不存在。把它们迁过来等于把坏数据带进新 schema，
 * 之后每一个"为什么掌握度是这个数"的问题都要先排查一遍这批遗留。
 *
 * 原文件不删 —— 另存一份，用户想捞随时能捞。
 */
function migrateV1(value: Record<string, unknown>): RumenState {
  const projects = list<Record<string, unknown>>(value.projects).flatMap((project) => {
    const id = typeof project.id === "string" ? project.id : null;
    const root = typeof project.root === "string" ? project.root : null;
    if (!id || !root) return [];
    // 家目录那类根本扫不了的目录，留着只会在总览里挂一个永远 0 技术栈、
    // 一点扫描就报错的空项目。它从来没有过有效数据，丢掉不是丢数据
    if (forbiddenRoot(root)) return [];
    return [{
      id,
      workspaceIds: list<string>(project.workspaceIds).filter((item) => typeof item === "string"),
      name: typeof project.name === "string" ? project.name : root,
      root,
      privacy: (["public", "private", "airgapped"] as const).includes(project.privacy as Privacy)
        ? (project.privacy as Privacy)
        : "private",
      isGit: id.startsWith("git:") || id.startsWith("root:"),
      // 强制重扫：v1 的检出结果不可用
      lastScanAt: null,
      truncated: false,
      technologies: [],
      pending: [],
      lastAnalyzedSha: null,
    } satisfies StoredProject];
  });
  return { ...structuredClone(EMPTY), projects };
}

function normalize(value: unknown): RumenState | { migrateFrom: 1; state: RumenState } {
  if (!value || typeof value !== "object") return structuredClone(EMPTY);
  const candidate = value as Record<string, unknown>;
  if (candidate.version === 1) return { migrateFrom: 1, state: migrateV1(candidate) };
  if (candidate.version !== 2) return structuredClone(EMPTY);
  const settings = (candidate.settings ?? {}) as Partial<StoredSettings>;
  return {
    version: 2,
    settings: {
      locale: settings.locale === "zh" || settings.locale === "en" ? settings.locale : "auto",
      provider: typeof settings.provider === "string" ? settings.provider : null,
      deferToUserAgents: settings.deferToUserAgents !== false,
    },
    projects: list<StoredProject>(candidate.projects),
    techs: list<StoredTechEntity>(candidate.techs),
    nodes: list<StoredNode>(candidate.nodes),
    evidence: list<StoredEvidence>(candidate.evidence),
    wikis: list<StoredWiki>(candidate.wikis),
    questions: list<StoredQuestion>(candidate.questions),
    aliases: list<LearnedAlias>(candidate.aliases),
    observations: list<StoredObservation>(candidate.observations),
    reviews: list<StoredReview>(candidate.reviews),
  };
}

async function loadUnqueued(): Promise<RumenState> {
  if (cached) return cached;
  const path = statePath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      cached = structuredClone(EMPTY);
      return cached;
    }
    console.error("[rumen] state is unreadable; refusing to replace it", error);
    throw new Error(`Rumen state is unreadable at ${path}; fix permissions or restore the file before writing`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const quarantine = `${path}.corrupt-${Date.now()}`;
    await writeFile(quarantine, raw, { encoding: "utf8", mode: 0o600 }).catch(() => {});
    console.error(`[rumen] state is malformed; preserved a recovery copy at ${quarantine}`, error);
    throw new Error(`Rumen state is malformed at ${path}; it was not overwritten`);
  }
  const result = normalize(parsed);
  if ("migrateFrom" in result) {
    const backup = `${path}.v1-${Date.now()}`;
    await writeFile(backup, raw, { encoding: "utf8", mode: 0o600 }).catch(() => {});
    cached = result.state;
    // ⚠️ 迁移必须**立刻落盘**，不能只改内存。
    // 只改内存的话磁盘上仍是 v1，下次加载又迁移一遍 —— 每次 reload 多留一份
    // 全量备份。实机上两次 reload 就把这个目录从 7.8MB 堆到 23MB。
    await persist(result.state);
    console.warn(
      `[rumen] migrated state v1 → v2. v1's technology and concept data came from a scanner that turned every package into its own technology, so it was dropped; projects and privacy levels were kept. The original file is at ${backup}. Re-scan each workspace to rebuild.`,
    );
    return cached;
  }
  cached = result;
  return cached;
}

/** 写之前剪掉过期的观测记录 —— 它是唯一会无界增长的表。 */
function prune(state: RumenState, now: number): void {
  const cutoff = now - OBSERVATION_RETENTION_MS;
  if (state.observations.some((item) => item.observedAt < cutoff)) {
    state.observations = state.observations.filter((item) => item.observedAt >= cutoff);
  }
  // 已还的债保留一段时间供回看，再久就没意义了
  if (state.reviews.some((item) => item.reviewedAt !== null && item.reviewedAt < cutoff)) {
    state.reviews = state.reviews.filter((item) => item.reviewedAt === null || item.reviewedAt >= cutoff);
  }
}

async function persist(state: RumenState): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temp, 0o600).catch(() => {});
  await rename(temp, path);
}

export async function readState(): Promise<RumenState> {
  await queue;
  return structuredClone(await loadUnqueued());
}

export async function updateState<T>(mutator: (state: RumenState) => T | Promise<T>): Promise<T> {
  const operation = queue.then(async () => {
    const state = await loadUnqueued();
    const result = await mutator(state);
    prune(state, Date.now());
    await persist(state);
    return result;
  });
  queue = operation.catch(() => {});
  return operation;
}

export function resetStoreForTests(): void {
  cached = null;
  queue = Promise.resolve();
}
