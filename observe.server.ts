/**
 * Agent 观测：agent 正在改什么，涉不涉及你没见过的东西。
 *
 * ## 做成插件之后，这一层几乎全省了
 *
 * 原来的 Rumen 为了知道"agent 在跑什么"写了两条通道：hook shim（改用户的
 * agent 配置、装卸载、幂等、备份回滚）和被动监听（transcript tail + 进程扫描 +
 * 活性状态机 + 双通道去重），近三千行，还带着"transcript 格式无契约、
 * 随版本升级失效"这个长期风险。
 *
 * **Paseo 本身就是那个观测者。** 它已经拥有 agent 的规范时间线，
 * 而且是它自己起的进程，没有格式契约风险。所以这里只剩下一件事：
 * 把 Paseo 的时间线翻译成 Rumen 的证据。
 *
 * ⚠️ 代价要说清楚：**观测只在 Paseo 开着的时候进行。** 关掉 Paseo 期间
 * agent 的改动看不见 —— 但那些改动最终会落进 commit，被 commit 分析兜住。
 * UI 上要明说这一点，不能假装是全覆盖的。
 */

import { readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { evidenceKey, stableHash } from "./domain.shared";
import type {
  StoredEvidence,
  StoredNode,
  StoredObservation,
  StoredProject,
  StoredReview,
} from "./store.server";
import { learnedKey, resolveTech, type LearnedAlias } from "./techmap.shared";

/** 一次被观测到的文件改动。 */
export interface Mutation {
  callId: string;
  /** 相对项目根。 */
  file: string;
  at: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * 从一条 Paseo 时间线条目里提取文件改动。
 *
 * **只认已完成的写类工具**。进行中的不算 —— agent 可能改到一半被打断，
 * 那不是一次改动。
 *
 * ⚠️ **一条真实盲区：走 shell 的改动看不见。** agent 通过 `sed -i`、
 * `cat > file`、重定向做的改动记不到，这类只能退回 commit 分析。
 * 文件工具（Edit/Write）覆盖了绝大多数真实场景，但这个盲区确实存在，
 * 不该假装没有。
 */
export function mutationFrom(item: unknown, timestamp: unknown, root: string): Mutation | null {
  const value = record(item);
  if (!value || value.type !== "tool_call" || value.status !== "completed") return null;
  const detail = record(value.detail);
  if (!detail || (detail.type !== "edit" && detail.type !== "write")) return null;
  const filePath = text(detail.filePath);
  const callId = text(value.callId);
  if (!filePath || !callId) return null;

  const absolute = filePath.startsWith(sep) ? resolve(filePath) : resolve(root, filePath);
  const file = relative(root, absolute);
  // 项目外的改动不算这个项目的知识债
  if (!file || file.startsWith("..") || file.startsWith(sep)) return null;

  const parsed = typeof timestamp === "string" || typeof timestamp === "number"
    ? new Date(timestamp).getTime()
    : Number.NaN;
  return { callId, file, at: Number.isFinite(parsed) ? parsed : Date.now() };
}

export function observationId(projectId: string, agentId: string, callId: string, file: string): string {
  return stableHash(`${projectId}\0${agentId}\0${callId}\0${file}`);
}

export interface IngestResult {
  observations: StoredObservation[];
  reviews: StoredReview[];
  evidence: StoredEvidence[];
}

/**
 * 把一批观测到的改动变成观测记录、还债队列和知识债证据。
 *
 * ⭐ 这里是 `agent_wrote_unreviewed` 的产生点，而
 * {@link markReviewed} 是 `agent_wrote_reviewed` 的产生点。两个合起来才是
 * 这个产品的核心闭环：**agent 写的代码要你真的读过才算还债。**
 */
export function ingestMutations(input: {
  project: StoredProject;
  nodes: readonly StoredNode[];
  agentId: string;
  mutations: readonly Mutation[];
  /** 已掌握的知识点 groupId —— 掌握好的不再记债，再提醒只是噪声。 */
  grasped: ReadonlySet<string>;
  existingObservationIds: ReadonlySet<string>;
  existingReviewIds: ReadonlySet<string>;
}): IngestResult {
  const observations: StoredObservation[] = [];
  const reviews: StoredReview[] = [];
  const evidence: StoredEvidence[] = [];

  // file → 该文件是哪些技术的证据锚点
  const techByFile = new Map<string, Set<string>>();
  for (const usage of input.project.technologies) {
    for (const anchor of usage.evidence) {
      const set = techByFile.get(anchor.file) ?? new Set<string>();
      set.add(usage.techId);
      techByFile.set(anchor.file, set);
    }
  }
  const nodesByTech = new Map<string, StoredNode[]>();
  for (const node of input.nodes) {
    nodesByTech.set(node.techId, [...(nodesByTech.get(node.techId) ?? []), node]);
  }

  for (const mutation of input.mutations) {
    const observationKey = observationId(input.project.id, input.agentId, mutation.callId, mutation.file);
    if (!input.existingObservationIds.has(observationKey)) {
      observations.push({
        id: observationKey,
        projectId: input.project.id,
        agentId: input.agentId,
        file: mutation.file,
        observedAt: mutation.at,
      });
    }

    const techIds = techByFile.get(mutation.file);
    if (!techIds?.size) continue;

    const affected = [...techIds]
      .flatMap((techId) => nodesByTech.get(techId) ?? [])
      .filter((node) => !input.grasped.has(node.groupId));
    if (affected.length === 0) continue;

    const groupIds = [...new Set(affected.map((node) => node.groupId))];
    const reviewKey = `review:${observationKey}`;
    if (!input.existingReviewIds.has(reviewKey)) {
      reviews.push({
        id: reviewKey,
        projectId: input.project.id,
        agentId: input.agentId,
        file: mutation.file,
        nodeGroupIds: groupIds,
        observedAt: mutation.at,
        reviewedAt: null,
      });
    }
    for (const groupId of groupIds) {
      const reference = `agent:${input.agentId}:call:${mutation.callId}`;
      evidence.push({
        id: evidenceKey(groupId, "agent_wrote_unreviewed", reference, mutation.at),
        nodeGroupId: groupId,
        projectId: input.project.id,
        kind: "agent_wrote_unreviewed",
        reference,
        createdAt: mutation.at,
      });
    }
  }

  return { observations, reviews, evidence };
}

/**
 * 还一笔知识债。
 *
 * 产出 `agent_wrote_reviewed` 证据（权重 0.4）。它的引用键刻意用
 * **review 的 id** 而不是当天 —— 同一处改动只该还一次债，
 * 而不是每天点一遍就涨一次分。
 */
export function markReviewed(review: StoredReview, at: number): StoredEvidence[] {
  return review.nodeGroupIds.map((groupId) => ({
    id: evidenceKey(groupId, "agent_wrote_reviewed", review.id, at),
    nodeGroupId: groupId,
    projectId: review.projectId,
    kind: "agent_wrote_reviewed" as const,
    reference: review.id,
    createdAt: at,
  }));
}

// ── L0 快路径 ───────────────────────────────────────────────────────

/**
 * L0 的判定结果。
 *
 * 全程确定性、零 agent 调用、零网络 —— 它要在 agent 改完文件的下一帧就能出结论。
 */
export interface Verdict {
  /** 命中的已有技术。 */
  techIds: string[];
  /** ⭐ 候选新知识点：项目里**从没见过**的依赖。 */
  candidates: string[];
  manifestTouched: boolean;
}

/**
 * ## 这条路径的成本不对称
 *
 * `new_knowledge` 是本产品**唯一有资格打断你的信号**，折叠优先级压过 `failed`。
 * 所以误报的代价远高于漏报：一个隔三差五乱亮的信号，用户三天就学会无视它，
 * 那时真有新知识点也叫不动他。
 *
 * 于是判据刻意收得很紧：
 *
 * - **只有"引入了项目里没见过的依赖"才算候选新知识点。**
 *   任意未知标识符不算 —— 本地函数名、变量名满天飞，拿它们当知识点会让信号一直亮着。
 * - **改到已知技术的文件只算 `attention`，不打断。**
 *   那是"你可能该复习"，不是"出现了你没见过的东西"。
 * - **已经掌握好的知识点不产生任何信号。**
 *
 * 只读本地文件，一个字都不外发。
 */
export async function fastPath(input: {
  project: StoredProject;
  mutations: readonly Mutation[];
  learned: readonly LearnedAlias[];
  /** 本项目已知的包名（小写），来自上一次扫描。 */
  knownPackages: ReadonlySet<string>;
}): Promise<Verdict> {
  const MANIFEST_NAMES = new Set([
    "package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod",
    "Gemfile", "pom.xml", "composer.json", "build.gradle", "build.gradle.kts",
  ]);

  const techByFile = new Map<string, string>();
  for (const usage of input.project.technologies) {
    for (const anchor of usage.evidence) techByFile.set(anchor.file, usage.techId);
  }

  const techIds = new Set<string>();
  const candidates = new Set<string>();
  let manifestTouched = false;

  const learnedMap = new Map(input.learned.map((item) => [learnedKey(item.pkg, item.ecosystem), item]));

  for (const mutation of input.mutations) {
    const hit = techByFile.get(mutation.file);
    if (hit) techIds.add(hit);

    if (!MANIFEST_NAMES.has(basename(mutation.file))) continue;
    manifestTouched = true;

    // 重新读一遍这个 manifest，看有没有出现项目里从没见过的包
    let content: string;
    try {
      content = await readFile(join(input.project.root, mutation.file), "utf8");
    } catch {
      continue;
    }
    for (const pkg of packageNames(basename(mutation.file), content)) {
      const lower = pkg.toLowerCase();
      if (input.knownPackages.has(lower)) continue;
      // 已经归类过并被压住的（judged not worth listing）不算新知识点
      const learned = learnedMap.get(`*:${lower}`) ?? learnedMap.get(learnedKey(lower, "npm"));
      if (learned && !learned.techId) continue;
      // 已经是项目里已有技术的另一个包名，也不算"没见过"
      const resolved = resolveTech(pkg, "npm", learnedMap);
      if (resolved && input.project.technologies.some((item) => item.techId === resolved.techId)) continue;
      candidates.add(pkg);
    }
  }

  return {
    techIds: [...techIds],
    candidates: [...candidates].slice(0, 20),
    manifestTouched,
  };
}

/** 从 manifest 里抠包名。只要名字，不要版本 —— L0 不关心版本。 */
function packageNames(fileName: string, content: string): string[] {
  const out: string[] = [];
  try {
    if (fileName === "package.json" || fileName === "composer.json") {
      const json = JSON.parse(content) as Record<string, unknown>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "require", "require-dev"]) {
        const section = json[field];
        if (section && typeof section === "object" && !Array.isArray(section)) {
          out.push(...Object.keys(section as Record<string, unknown>));
        }
      }
      return out;
    }
  } catch {
    return out;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    const patterns = [
      /^([A-Za-z0-9_.-]+)\s*[=<>~!]/, // requirements.txt / pyproject / Cargo
      /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)\s+v/, // go.mod
      /^gem\s+['"]([^'"]+)['"]/, // Gemfile
      /<artifactId>([^<]+)<\/artifactId>/, // pom.xml
    ];
    for (const pattern of patterns) {
      const match = trimmed.match(pattern);
      if (match?.[1]) {
        out.push(match[1]);
        break;
      }
    }
  }
  return out;
}

/**
 * 值不值得打断用户，以及用哪个桶。
 *
 * 这个映射是整个 L0 的产品判断所在，逐条对应上面那条"成本不对称"。
 */
export function verdictBucket(verdict: Verdict, hasDebt: boolean):
  "new_knowledge" | "attention" | "done" {
  // ⭐ 唯一有资格打断：出现了项目里从没见过的东西
  if (verdict.candidates.length > 0) return "new_knowledge";
  if (verdict.techIds.length > 0 || hasDebt) return "attention";
  return "done";
}
