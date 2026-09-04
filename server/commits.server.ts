/**
 * Commit 分析：这段代码是人写的还是 agent 写的，涉及哪些知识点。
 *
 * 这是整个产品最核心的判断 —— **agent 写的代码 = 你的知识债**。
 * 判错了，要么把你没学过的东西算成学过（危险），要么把你自己写的算成
 * agent 写的（打击人）。
 *
 * ## 流水线
 *
 * ```
 * ① 确定性提取   diff stat / 变更文件 / manifest diff / commit 类型
 * ② 确定性预筛   这个技术的名字真的出现在 diff 正文里，或改到了它证据锚点所在的文件
 * ③ 知识点匹配   FQN-exact 优先；短名/模糊只做文件级粗筛，不做链路判定
 * ④ 归因         第一层确定性信号 + 第二层观测修正
 * ```
 *
 * ⚠️ **② 是承重的。** 没有预筛就把每个 commit 喂给模型问"涉及哪些技术"，
 * 原版实机第一次回填烧掉 $2.28 换来零条证据。
 *
 * 曾经有第三条预筛规则"改了依赖清单就一律放行"，是**错的**：真实项目的 commit
 * 经常顺手动 `package.json`，于是每个都被放行，又每个都答"不涉及"。
 * 改依赖清单本身不说明碰了**哪个**技术。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  attributeFromCommit,
  evidenceKey,
  evidenceKindFor,
  isFixCommit,
  refineAttribution,
  type Attribution,
  type ObservationWindow,
} from "../domain/domain.shared";
import type {
  StoredEvidence,
  StoredNode,
  StoredObservation,
  StoredProject,
  StoredTechEntity,
} from "./store.server";

const exec = promisify(execFile);

/** 观测窗口的宽容度。commit 时间与观测时间之间总有几分钟的漂移。 */
const OBSERVATION_SLACK_MS = 6 * 3_600_000;

async function git(root: string, args: string[], maxBuffer = 20 * 1024 * 1024): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", root, ...args], { maxBuffer });
    return stdout;
  } catch {
    return null;
  }
}

export interface CommitRecord {
  sha: string;
  subject: string;
  body: string;
  authoredAt: number;
  authorEmail: string;
  committerEmail: string;
  files: string[];
  insertions: number;
  deletions: number;
}

/** 字段/记录分隔符用 ASCII 的 US / RS —— commit message 里不会出现它们。 */
const FIELD = "\u001f";
const RECORD = "\u001e";

export async function readCommits(root: string, limit: number): Promise<CommitRecord[]> {
  const format = [RECORD, "%H", "%ct", "%ae", "%ce", "%s", "%b"].join(FIELD);
  const output = await git(root, ["log", `-${limit}`, `--pretty=format:${format}`, "--numstat", "--no-merges"], 40 * 1024 * 1024);
  if (!output?.trim()) return [];

  const commits: CommitRecord[] = [];
  for (const chunk of output.split(RECORD).filter((part) => part.trim())) {
    const lines = chunk.split(/\r?\n/);
    const header = (lines.shift() ?? "").split(FIELD);
    // 首字段是 split 掉 RECORD 之后的空串
    const [, sha, timestamp, authorEmail, committerEmail, subject, ...bodyParts] = header;
    if (!sha || !timestamp) continue;
    let insertions = 0;
    let deletions = 0;
    const files: string[] = [];
    for (const line of lines) {
      const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!match) continue;
      insertions += match[1] === "-" ? 0 : Number(match[1]);
      deletions += match[2] === "-" ? 0 : Number(match[2]);
      // 处理 rename 的 `old => new` 形态，取新名
      const path = match[3]!.replace(/^.*\{.*=> (.*)\}.*$/, "$1").replace(/^.* => /, "");
      files.push(path);
    }
    commits.push({
      sha,
      subject: subject ?? "",
      body: bodyParts.join(FIELD),
      authoredAt: Number(timestamp) * 1000,
      authorEmail: authorEmail ?? "",
      committerEmail: committerEmail ?? "",
      files,
      insertions,
      deletions,
    });
  }
  return commits;
}

/** 当前 HEAD。用来判断上次分析结果还算不算数。 */
export async function headSha(root: string): Promise<string | null> {
  const value = await git(root, ["rev-parse", "HEAD"]);
  return value?.trim() || null;
}

export async function repoIdentityEmail(root: string): Promise<string | null> {
  const value = await git(root, ["config", "user.email"]);
  return value?.trim() || null;
}

/** 取一个 commit 的 diff 正文，用于②的预筛和③的符号匹配。 */
export async function commitDiff(root: string, sha: string): Promise<string> {
  const output = await git(root, ["show", "--format=", "--unified=0", "--no-color", sha], 8 * 1024 * 1024);
  return output ?? "";
}

export interface CommitInsight {
  sha: string;
  subject: string;
  authoredAt: number;
  authorship: Attribution["authorship"];
  confidence: number;
  signals: string[];
  filesChanged: number;
  insertions: number;
  deletions: number;
  touchedTechs: string[];
  touchedNodeGroupIds: string[];
  /** 这次 commit 产生的知识债数量（agent 写的 × 你还没掌握的知识点）。 */
  knowledgeDebt: number;
}

function observationWindow(
  observations: readonly StoredObservation[],
  projectId: string,
  from: number,
  to: number,
): ObservationWindow {
  // ⭐ "没在观测"和"观测到没有 agent"是两回事。
  // 这个项目在这段时间里一条观测记录都没有 → observing = false → 归因一个字都不改。
  const inWindow = observations.filter(
    (item) => item.projectId === projectId && item.observedAt >= from && item.observedAt <= to,
  );
  return {
    observing: inWindow.length > 0,
    agentTouched: new Set(inWindow.map((item) => item.file)),
  };
}

/**
 * ② 确定性预筛 + ③ 知识点匹配。
 *
 * - 技术命中：改到了它证据锚点所在的文件，**或**它的名字出现在 diff 正文里
 * - 知识点命中分两档：
 *   - `exactNodeGroupIds`：`symbols` 做 **FQN-exact** 匹配（全词边界）
 *   - `coarseNodeGroupIds`：命中技术下的全部知识点，**只能做文件级粗筛**
 *
 * ⚠️ **两档的用途不对称，混用会出事。** 粗筛档只配拿去记知识债和做展示；
 * 正面证据（`human_wrote` / `debugged`）**只认精确档**。
 * 理由是代价不对称：把没学过的算成学过，比漏记一次严重得多 ——
 * 改了一个 Redis 文件就给你记上"Redis 集群"的学习证据，那个分数是假的。
 * 而记债的方向相反：不确定时多记一笔债只会拉低置信度，不会虚高掌握度。
 */
export function matchKnowledge(input: {
  project: StoredProject;
  techs: ReadonlyMap<string, StoredTechEntity>;
  nodes: readonly StoredNode[];
  files: readonly string[];
  diff: string;
}): { techIds: string[]; exactNodeGroupIds: string[]; coarseNodeGroupIds: string[] } {
  const changed = new Set(input.files);
  const techIds = new Set<string>();

  for (const usage of input.project.technologies) {
    const entity = input.techs.get(usage.techId);
    if (!entity) continue;
    const anchorHit = usage.evidence.some((anchor) => changed.has(anchor.file));
    if (anchorHit) {
      techIds.add(usage.techId);
      continue;
    }
    // 名字出现在 diff 正文里。用全词边界，避免 `go` 命中 `going`
    const escaped = entity.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:[^A-Za-z0-9_]|$)`, "i").test(input.diff)) {
      techIds.add(usage.techId);
    }
  }

  const exact = new Set<string>();
  const coarse = new Set<string>();
  for (const node of input.nodes) {
    if (!techIds.has(node.techId)) continue;
    // 技术命中了，它下面的知识点都是**粗筛**候选
    coarse.add(node.groupId);
    // FQN-exact：符号必须整词出现在 diff 里。
    // 边界两侧都用 `[^A-Za-z0-9_]` —— `.` 是合法边界，否则 `client.EXPIRE(...)`
    // 这种方法调用形态整个匹配不上，而那是符号最常见的出现方式。
    // 同时 `EXPIREDAT` / `MY_EXPIRE` 仍然不算命中。
    const hit = node.symbols.some((symbol) => {
      if (symbol.length < 3) return false;
      const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:[^A-Za-z0-9_]|$)`).test(input.diff);
    });
    if (hit) exact.add(node.groupId);
  }

  return {
    techIds: [...techIds],
    exactNodeGroupIds: [...exact],
    coarseNodeGroupIds: [...coarse],
  };
}

export interface AnalyzeResult {
  insights: CommitInsight[];
  /** 新产生的证据，调用方负责去重落库。 */
  evidence: StoredEvidence[];
}

export async function analyzeCommits(input: {
  project: StoredProject;
  techs: ReadonlyMap<string, StoredTechEntity>;
  nodes: readonly StoredNode[];
  observations: readonly StoredObservation[];
  /** 已掌握的知识点 groupId，用来算这次 commit 的知识债。 */
  grasped: ReadonlySet<string>;
  limit: number;
  /** 读 diff 正文的 commit 数上限。diff 是 IO 大头，列表页不需要全读。 */
  diffBudget?: number;
}): Promise<AnalyzeResult> {
  const { project } = input;
  if (!project.isGit) return { insights: [], evidence: [] };

  const [commits, identity] = await Promise.all([
    readCommits(project.root, input.limit),
    repoIdentityEmail(project.root),
  ]);
  if (commits.length === 0) return { insights: [], evidence: [] };

  const nodesByGroup = new Map(input.nodes.map((node) => [node.groupId, node]));
  const insights: CommitInsight[] = [];
  const evidence: StoredEvidence[] = [];
  let diffsRead = 0;
  const diffBudget = input.diffBudget ?? 40;

  for (const commit of commits) {
    const first = attributeFromCommit({
      subject: commit.subject,
      body: commit.body,
      authorEmail: commit.authorEmail,
      committerEmail: commit.committerEmail,
      repoIdentityEmail: identity,
    });
    const window = observationWindow(
      input.observations,
      project.id,
      commit.authoredAt - OBSERVATION_SLACK_MS,
      commit.authoredAt + OBSERVATION_SLACK_MS,
    );
    const attribution = refineAttribution(first, commit.files, window);

    const diff = diffsRead < diffBudget ? await commitDiff(project.root, commit.sha) : "";
    if (diff) diffsRead += 1;
    const matched = matchKnowledge({
      project,
      techs: input.techs,
      nodes: input.nodes,
      files: commit.files,
      diff,
    });

    const unGrasped = matched.coarseNodeGroupIds.filter((groupId) => !input.grasped.has(groupId));
    const isAgent = attribution.authorship === "agent" || attribution.authorship === "mixed";

    insights.push({
      sha: commit.sha,
      subject: commit.subject,
      authoredAt: commit.authoredAt,
      authorship: attribution.authorship,
      confidence: attribution.confidence,
      signals: [...attribution.signals],
      filesChanged: commit.files.length,
      insertions: commit.insertions,
      deletions: commit.deletions,
      touchedTechs: matched.techIds
        .map((techId) => input.techs.get(techId)?.name)
        .filter((name): name is string => Boolean(name)),
      touchedNodeGroupIds: matched.coarseNodeGroupIds,
      knowledgeDebt: isAgent ? unGrasped.length : 0,
    });

    // ④ 落证据。`unknown` 一条都不产生 —— 宁可少记，不能瞎记
    const kind = evidenceKindFor(attribution, isFixCommit(commit.subject));
    if (!kind) continue;
    // ⭐ 记债可以走粗筛，涨分只认精确匹配。见 matchKnowledge 的文档注释
    const targets = kind === "agent_wrote_unreviewed"
      ? matched.coarseNodeGroupIds
      : matched.exactNodeGroupIds;
    for (const groupId of targets) {
      if (!nodesByGroup.has(groupId)) continue;
      const reference = `commit:${commit.sha}`;
      evidence.push({
        id: evidenceKey(groupId, kind, reference, commit.authoredAt),
        nodeGroupId: groupId,
        projectId: project.id,
        kind,
        reference,
        createdAt: commit.authoredAt,
      });
    }
  }

  return { insights, evidence };
}
