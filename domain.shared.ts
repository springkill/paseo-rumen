/**
 * 领域模型的纯逻辑：掌握度、项目身份、归因。
 *
 * 这里**没有 IO**，全部可单测。前端不许再算一遍任何一个 ——
 * 两边各算一次必然算出不一样的结果。
 */

export type Privacy = "public" | "private" | "airgapped";

export type EvidenceKind =
  | "agent_wrote_unreviewed"
  | "agent_wrote_reviewed"
  | "human_wrote"
  | "wiki_read"
  | "quiz_passed"
  | "debugged";

export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "agent_wrote_unreviewed",
  "agent_wrote_reviewed",
  "human_wrote",
  "wiki_read",
  "quiz_passed",
  "debugged",
];

/**
 * 证据权重。
 *
 * ⭐ **`agent_wrote_unreviewed` 是 0，不是负数。**
 * agent 在你项目里写了 500 行 Redis 代码而你没读，你的 Redis 掌握度应该是
 * **没变** —— 不是变负，你没有因此忘掉你原本会的东西。它真正的影响是另外两条：
 *
 * 1. 记一笔**知识债**（单独计数，不混进分数）
 * 2. **拉低置信度** —— 项目里有大量你可能看不懂的代码，
 *    说明"你掌握了它"这个估计没那么有把握
 *
 * **掌握度 / 置信度 / 知识债是三个量**，混成一个数就什么也说不清。
 * UI 能说"掌握度 20%，但有 5 处知识债"，而不是含混地给个负数。
 */
export const EVIDENCE_WEIGHTS: Record<EvidenceKind, number> = {
  agent_wrote_unreviewed: 0,
  wiki_read: 0.3,
  agent_wrote_reviewed: 0.4,
  human_wrote: 1,
  debugged: 1.2,
  quiz_passed: 1.5,
};

export interface EvidenceInput {
  readonly kind: EvidenceKind;
  readonly createdAt: number;
}

/**
 * 衰减时间常数（天）。
 *
 * 概念类衰减慢，API 细节衰减快 —— 你可能忘掉 `EXPIRE` 的具体签名，
 * 但不会忘掉"缓存要有过期策略"这件事。用难度做代理：
 * 难度低的多是概念，难度高的多是细节与运维经验。
 */
export function decayTau(difficulty: number): number {
  const clamped = Math.max(1, Math.min(5, Math.round(difficulty || 1)));
  return [365, 300, 240, 180, 150][clamped - 1]!;
}

export interface Mastery {
  readonly score: number;
  readonly confidence: number;
  readonly debt: number;
  readonly grasped: boolean;
}

/**
 * 掌握度是**后验估计，不是计数器**。
 *
 * ```
 * S = Σ evidence_i · w(type_i) · decay(Δt_i)
 * mastery = 100 · (1 − exp(−S / 2))
 * ```
 */
export function masteryOf(
  evidence: readonly EvidenceInput[],
  now = Date.now(),
  difficulty = 1,
): Mastery {
  const tau = decayTau(difficulty);
  let sum = 0;
  let debt = 0;
  const positiveKinds = new Set<EvidenceKind>();
  for (const item of evidence) {
    if (item.kind === "agent_wrote_unreviewed") {
      debt += 1;
      continue;
    }
    const ageDays = Math.max(0, now - item.createdAt) / 86_400_000;
    const effective = EVIDENCE_WEIGHTS[item.kind] * Math.exp(-ageDays / tau);
    sum += effective;
    if (effective > 0) positiveKinds.add(item.kind);
  }
  const score = Math.max(0, Math.min(100, 100 * (1 - Math.exp(-sum / 2))));
  const diversity = Math.min(1, positiveKinds.size / 3);
  const quizBonus = positiveKinds.has("quiz_passed") ? 0.2 : 0;
  const debtPenalty = Math.min(0.4, debt * 0.08);
  const confidence = Math.max(0, Math.min(1, diversity + quizBonus - debtPenalty));
  return {
    score: Math.round(score * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    debt,
    /** 分数够 **且** 估计本身够有把握，才算掌握。少一个都不算。 */
    grasped: score >= 60 && confidence >= 0.5,
  };
}

/** 掌握度低于这条线才值得提示。高的说明你懂，再提醒只是噪声。 */
export const REVIEW_BELOW = 60;

export function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export function normalizeRemote(remote: string): string {
  let value = remote.trim().replace(/^git@([^:]+):/, "https://$1/");
  try {
    const url = new URL(value);
    value = `${url.hostname}${url.pathname}`;
  } catch {
    value = value.replace(/^[a-z]+:\/\//i, "").replace(/^[^@]+@/, "");
  }
  return value
    .replace(/:\d+\//, "/")
    // ⚠️ 顺序是承重的：先剥尾斜杠再剥 `.git`。
    // 反过来的话 `…/repo.git/` 的 `.git` 剥不掉，于是它和 `…/repo` 会得到两个
    // 不同的身份 —— 同一个项目被记成两个，历史一分为二。
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * 项目身份的强度。
 *
 * ⭐ **身份会随时间变强，绑定逻辑必须原地升级**：
 *
 * ```
 * git init（尚无 commit）  → path:      强度 0
 *     ↓ 首个 commit 落地
 * 认得根提交               → root:<sha> 强度 1
 *     ↓ git remote add origin
 * 认得远端                 → git:<host/path> 强度 2
 * ```
 *
 * 同一路径下身份变强时必须**原地升级**既有记录，而不是新建项目 ——
 * 否则同一个项目在生命周期里会被记成三个，历史三分。
 * 反向**永不降级**：用户删掉 remote 后仍保留 `git:` 身份，
 * 否则此前挂在旧身份上的全部分析结果会失联。
 */
export function identityStrength(id: string): number {
  if (id.startsWith("git:")) return 2;
  if (id.startsWith("root:")) return 1;
  return 0;
}

export function projectIdentity(input: {
  remote?: string | null;
  firstCommit?: string | null;
  path: string;
}): string {
  if (input.remote?.trim()) return `git:${normalizeRemote(input.remote)}`;
  if (input.firstCommit?.trim()) return `root:${input.firstCommit.trim().toLowerCase()}`;
  return `path:${input.path}`;
}

export function confidenceForLayers(maxConfidence: number, distinctLayers: number): number {
  return Math.min(0.99, maxConfidence + 0.5 * (1 - maxConfidence) * Math.max(0, distinctLayers - 1));
}

/**
 * 证据的幂等键 = `(node, kind, ref, 天)`。
 *
 * "今天翻了五遍同一页 wiki"不该算成学了五次，但明天再翻是新的复习，该算。
 */
export function evidenceKey(
  nodeId: string,
  kind: EvidenceKind,
  reference: string | undefined,
  createdAt: number,
): string {
  const day = new Date(createdAt).toISOString().slice(0, 10);
  return stableHash(`${nodeId}\0${kind}\0${reference ?? ""}\0${day}`);
}

// ── 归因 ────────────────────────────────────────────────────────────

export type Authorship = "human" | "agent" | "mixed" | "unknown";

export interface Attribution {
  readonly authorship: Authorship;
  readonly confidence: number;
  /** 可审计的判据。归因错了得能查出为什么。 */
  readonly signals: readonly string[];
}

/**
 * 低于这条线不产生任何证据。
 *
 * 宁可少记，不能瞎记 —— 把没学过的算成学过，比漏记一次严重得多。
 */
export const ATTRIBUTION_FLOOR = 0.55;

/**
 * agent 痕迹的识别。
 *
 * ⭐ 匹配**域名**而不是模型名 —— 模型名一直在变（Opus 4.6 → 4.8 → 5），域名不变。
 * 实机扫四个仓库 600+ 个 commit，agent 痕迹只有 `noreply@anthropic.com` 这一种形态。
 */
const AGENT_TRAILERS: readonly RegExp[] = [
  /co-authored-by:[^\n]*<[^\n>]*@(?:noreply\.)?anthropic\.com>/i,
  /co-authored-by:[^\n]*<[^\n>]*@(?:users\.noreply\.github\.com)>[^\n]*copilot/i,
  /(?:generated|written|implemented|authored)-by:\s*(?:ai|agent|claude|codex|copilot)/i,
  /🤖\s*generated with/i,
];

export interface CommitFacts {
  readonly subject: string;
  readonly body: string;
  readonly authorEmail: string;
  readonly committerEmail: string;
  /** 本仓库配置的身份（`git config user.email`）。取不到就是 null。 */
  readonly repoIdentityEmail: string | null;
}

/**
 * 第一层：确定性信号。
 *
 * | 情形 | 判定 | 置信度 |
 * |---|---|---|
 * | 有 agent 标记 | `agent` | 0.95（多类信号同时命中 0.98） |
 * | 有 agent 标记 且 author≠committer | `mixed` | 上述 −0.15 |
 * | 无标记，作者是本仓库配置身份 | `human` | **0.6** ⚠️ |
 * | 无标记，作者不是本仓库身份 | `unknown` | 0.3（不产生任何证据） |
 * | 无标记，取不到仓库身份 | `unknown` | 0.2 |
 *
 * ⚠️ **那个 0.6 是硬伤**：codex 默认不留 trailer，在你自己的身份下提交的
 * agent commit 会落进这一档，和真人写的混在一起。{@link refineAttribution}
 * 用观测记录把它拆开。
 */
export function attributeFromCommit(facts: CommitFacts): Attribution {
  const haystack = `${facts.subject}\n${facts.body}`;
  const hits = AGENT_TRAILERS.filter((pattern) => pattern.test(haystack));
  if (hits.length > 0) {
    const base = hits.length >= 2 ? 0.98 : 0.95;
    const split = facts.authorEmail !== "" && facts.authorEmail !== facts.committerEmail;
    return {
      authorship: split ? "mixed" : "agent",
      confidence: Math.round((split ? base - 0.15 : base) * 100) / 100,
      signals: [
        `commit message 带 agent 标记（${hits.length} 类信号）`,
        ...(split ? ["author 与 committer 不同"] : []),
      ],
    };
  }
  if (!facts.repoIdentityEmail) {
    return { authorship: "unknown", confidence: 0.2, signals: ["无 agent 标记，取不到本仓库配置身份"] };
  }
  if (facts.authorEmail.toLowerCase() === facts.repoIdentityEmail.toLowerCase()) {
    return { authorship: "human", confidence: 0.6, signals: ["无 agent 标记，作者是本仓库配置身份"] };
  }
  return { authorship: "unknown", confidence: 0.3, signals: ["无 agent 标记，作者不是本仓库配置身份"] };
}

export interface ObservationWindow {
  /** 这个 commit 的时间窗内，Rumen 是否真的在观测。 */
  readonly observing: boolean;
  /** 窗内被 agent 改过的文件（相对项目根）。 */
  readonly agentTouched: ReadonlySet<string>;
}

/**
 * 第二层：观测修正。用观测记录把第一层 0.6 那一档拆开。
 *
 * | 观测 | 判定 | 置信度 |
 * |---|---|---|
 * | **当时没在观测** | **一个字都不改** | 保持第一层 |
 * | agent 碰过 ≥ 半数改动文件 | `agent` | 0.95 |
 * | agent 碰过部分文件 | `mixed` | 0.85 |
 * | 在观测中，且**没有**任何 agent 碰过 | `human` | **0.9** |
 *
 * 刻意**不做**第四条：**显式 trailer 永不下调**。trailer 是作者自己写进 commit
 * 的声明，比我们的旁证权威 —— 用户手动补一条 `Co-Authored-By: Claude`
 * 就是在告诉我们这是 agent 写的。
 *
 * 第一条同样重要：**没在观测就连信号都不加**。加了会让审计记录里出现
 * 一句无依据的话 —— 这和"扫不到进程 ≠ 没有进程"是同一条原则。
 */
export function refineAttribution(
  first: Attribution,
  files: readonly string[],
  window: ObservationWindow,
): Attribution {
  if (!window.observing) return first;
  // 显式 trailer 永不下调
  if (first.authorship === "agent" || first.authorship === "mixed") return first;
  if (files.length === 0) return first;

  const touched = files.filter((file) => window.agentTouched.has(file));
  if (touched.length === 0) {
    return {
      authorship: "human",
      confidence: 0.9,
      signals: [...first.signals, `Rumen 观测窗口内：没有 agent 碰过这 ${files.length} 个文件`],
    };
  }
  const ratio = touched.length / files.length;
  if (ratio >= 0.5) {
    return {
      authorship: "agent",
      confidence: 0.95,
      signals: [...first.signals, `Rumen 观测窗口内：agent 改过 ${touched.length}/${files.length} 个文件`],
    };
  }
  return {
    authorship: "mixed",
    confidence: 0.85,
    signals: [...first.signals, `Rumen 观测窗口内：agent 改过 ${touched.length}/${files.length} 个文件`],
  };
}

/**
 * 归因 → 该记哪种证据。
 *
 * `unknown` 不产生任何证据，这是刻意的。
 */
export function evidenceKindFor(
  attribution: Attribution,
  isFix: boolean,
): EvidenceKind | null {
  if (attribution.confidence < ATTRIBUTION_FLOOR) return null;
  switch (attribution.authorship) {
    case "agent":
      return "agent_wrote_unreviewed";
    case "human":
      return isFix ? "debugged" : "human_wrote";
    case "mixed":
      // 混合的算 agent 写 —— 保守：宁可记成债，也不要算成你学过了
      return "agent_wrote_unreviewed";
    case "unknown":
      return null;
  }
}

/** `fix` 类 commit 的判定。改过 bug 的代码，理解深度高于新写。 */
export function isFixCommit(subject: string): boolean {
  return /^\s*(?:fix|bugfix|hotfix|patch)\b|^\s*fix[(:]|\bfixes?\s+#\d+/i.test(subject);
}
