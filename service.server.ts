/**
 * RPC 处理器：把扫描、生成、观测、归因接成一个产品。
 */

import type { PluginHandlerContext } from "@getpaseo/plugin";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { output as ZodOutput } from "zod";
import {
  GenerationBusyError,
  listGenerationProviders,
  NoProviderError,
  resolveProvider,
} from "./agentrun.server";
import { collapse, identityColor, type StatusBucket } from "./buckets.shared";
import { analyzeCommits, headSha, type CommitInsight } from "./commits.server";
import { classifyPending } from "./classify.server";
import type {
  agentImpactRpc,
  attachmentSearchRpc,
  classifyRpc,
  commitsRpc,
  dashboardRpc,
  evidenceRpc,
  exportRpc,
  generateWikiRpc,
  markReviewedRpc,
  overviewRpc,
  privacyRpc,
  quizAnswerRpc,
  quizNextRpc,
  reviewSourceRpc,
  reviewsRpc,
  scanRpc,
  settingsRpc,
  updateSettingsRpc,
  wikiRpc,
} from "./contracts.shared";
import type {
  AgentImpact,
  Dashboard,
  KnowledgeNode,
  ProjectSummary,
  ReviewItem,
  Settings,
  Technology,
  Wiki,
} from "./contracts.shared";
import {
  evidenceKey,
  identityStrength,
  masteryOf,
  stableHash,
  type EvidenceKind,
  type Mastery,
} from "./domain.shared";
import {
  fallbackNodes,
  generateQuestion,
  generateWiki,
  gradeAnswer,
  gradeLocally,
  majorVersionOf,
  MIN_SOURCED_RATIO,
  questionId,
  WIKI_SCHEMA_VERSION,
} from "./generate.server";
import {
  LOCALES,
  resolveLocale,
  translator,
  type Locale,
  type Translator,
} from "./i18n.shared";
import { fastPath, ingestMutations, markReviewed, mutationFrom, verdictBucket, type Mutation } from "./observe.server";
import { allowsGeneration, allowsProjectCode } from "./privacy.shared";
import { identifyProject, resolveProjectRoot, ScanBoundaryError, scanWorkspace } from "./scanner.server";
import {
  dataDirectory,
  readState,
  updateState,
  type RumenState,
  type StoredNode,
  type StoredProject,
  type StoredQuestion,
} from "./store.server";
import { learnedKey } from "./techmap.shared";

type LocaleInput = { clientLocale?: string };
type WorkspaceInput = LocaleInput & { workspaceId: string; cwd: string };

// ── 语言 ────────────────────────────────────────────────────────────

function localeOf(state: RumenState, input: LocaleInput): Locale {
  return resolveLocale({
    env: process.env,
    saved: state.settings.locale === "auto" ? null : state.settings.locale,
    clientHint: input.clientLocale ?? null,
  });
}

async function tFor(input: LocaleInput): Promise<Translator> {
  return translator(localeOf(await readState(), input));
}

// ── workspace 校验 ──────────────────────────────────────────────────

async function validateWorkspace(
  input: WorkspaceInput,
  context: PluginHandlerContext,
  t: Translator,
): Promise<{ root: string; isGit: boolean; name: string }> {
  if (!input.cwd.startsWith("/")) throw new Error(t.err_path_not_absolute);
  const snapshot = await context.paseo.workspaces.ref(input.workspaceId).refresh();
  if (!snapshot || snapshot.id !== input.workspaceId || !snapshot.workspaceDirectory) {
    throw new Error(t.err_workspace_unavailable);
  }
  const supplied = await resolveProjectRoot(input.cwd);
  const actual = await resolveProjectRoot(snapshot.workspaceDirectory);
  if (supplied.root !== actual.root) throw new Error(t.err_workspace_mismatch);
  return { ...actual, name: snapshot.title ?? snapshot.name ?? basename(actual.root) };
}

function identityKind(id: string): "git" | "root" | "path" {
  return id.startsWith("git:") ? "git" : id.startsWith("root:") ? "root" : "path";
}

/**
 * 找到或建立项目记录，必要时**原地升级身份**。
 *
 * ⭐ 绑定时若"这个身份没绑过、但**这个路径**已被一个**更弱**的身份绑过"，
 * 必须把既有记录的 id 原地升级（连同挂在它上面的证据、观测、还债队列一起带走），
 * **而不是新建项目**。否则同一个项目在生命周期里会被记成三个，历史三分 ——
 * 而这恰恰是新项目最常见的路径（git init → 首个 commit → git remote add）。
 *
 * 反向**永不降级**：用户删掉 remote 后仍保留 `git:` 身份，
 * 否则此前挂在旧身份上的全部分析结果会失联。
 */
function bindProject(
  state: RumenState,
  identity: { id: string; name: string },
  workspace: { root: string; isGit: boolean; name: string },
  workspaceId: string,
): StoredProject {
  let project = state.projects.find((item) => item.id === identity.id);
  if (!project) {
    const byPath = state.projects.find((item) => item.root === workspace.root);
    if (byPath && identityStrength(identity.id) > identityStrength(byPath.id)) {
      const from = byPath.id;
      byPath.id = identity.id;
      for (const item of state.evidence) if (item.projectId === from) item.projectId = identity.id;
      for (const item of state.observations) if (item.projectId === from) item.projectId = identity.id;
      for (const item of state.reviews) if (item.projectId === from) item.projectId = identity.id;
      project = byPath;
    } else if (byPath && identityStrength(identity.id) <= identityStrength(byPath.id)) {
      // 永不降级
      project = byPath;
    }
  }
  if (!project) {
    project = {
      id: identity.id,
      workspaceIds: [workspaceId],
      name: workspace.name || identity.name,
      root: workspace.root,
      privacy: "private",
      isGit: workspace.isGit,
      lastScanAt: null,
      truncated: false,
      technologies: [],
      pending: [],
      lastAnalyzedSha: null,
    };
    state.projects.push(project);
  }
  project.root = workspace.root;
  project.isGit = workspace.isGit;
  project.name = workspace.name || identity.name;
  if (!project.workspaceIds.includes(workspaceId)) project.workspaceIds.push(workspaceId);
  return project;
}

async function ensureProject(
  input: WorkspaceInput,
  context: PluginHandlerContext,
  t: Translator,
  options: { scan?: boolean } = {},
): Promise<StoredProject> {
  const workspace = await validateWorkspace(input, context, t);
  const identity = await identifyProject(workspace.root);
  const state = await readState();
  const needsScan = options.scan
    || !state.projects.find((item) => item.id === identity.id || item.root === workspace.root)?.lastScanAt;

  let scanned: Awaited<ReturnType<typeof scanWorkspace>> | null = null;
  if (needsScan) {
    try {
      scanned = await scanWorkspace(workspace.root, workspace.isGit, state.aliases);
    } catch (error) {
      if (error instanceof ScanBoundaryError) {
        throw new Error(
          error.reason === "home_or_root"
            ? t.err_scan_home_directory(error.path)
            : t.err_scan_too_broad(error.fileCount, error.path),
        );
      }
      throw error;
    }
  }

  return updateState((current) => {
    const project = bindProject(current, identity, workspace, input.workspaceId);
    if (scanned) {
      project.technologies = scanned.technologies;
      project.pending = scanned.pending;
      project.truncated = scanned.truncated;
      project.lastScanAt = Date.now();
      const known = new Set(current.techs.map((item) => item.id));
      for (const tech of scanned.techs) {
        if (known.has(tech.id)) continue;
        current.techs.push(tech);
        known.add(tech.id);
      }
      ensureFallbackNodes(current, project, localeOf(current, input));
    }
    return structuredClone(project);
  });
}

/**
 * 给还没生成过 Wiki 的技术补占位知识点。
 *
 * 它们标 `origin: "fallback"`，UI 会明说"这是占位的" —— 静默用模板顶替，
 * 用户会以为"Redis 的知识点就这三条"，那比没有知识点更糟。
 */
function ensureFallbackNodes(state: RumenState, project: StoredProject, lang: Locale): void {
  const generated = new Set(state.nodes.filter((node) => node.origin === "generated").map((node) => node.techId));
  const existing = new Set(state.nodes.map((node) => node.id));
  for (const usage of project.technologies) {
    if (generated.has(usage.techId)) continue;
    const entity = state.techs.find((item) => item.id === usage.techId);
    if (!entity) continue;
    for (const node of fallbackNodes(entity.id, entity.name, lang)) {
      if (!existing.has(node.id)) {
        state.nodes.push(node);
        existing.add(node.id);
      }
    }
  }
}

// ── 投影：存储 → 对外类型 ───────────────────────────────────────────

function masteryFor(state: RumenState, groupId: string, difficulty: number, now: number): Mastery {
  return masteryOf(
    state.evidence.filter((item) => item.nodeGroupId === groupId),
    now,
    difficulty,
  );
}

/** 一个技术在某语言下的知识点。没有该语言的就退回任意已有语言 —— 有内容比语言一致重要。 */
function nodesFor(state: RumenState, techId: string, lang: Locale): StoredNode[] {
  const all = state.nodes.filter((node) => node.techId === techId);
  const preferred = all.filter((node) => node.lang === lang);
  if (preferred.length > 0) return preferred;
  const generated = all.filter((node) => node.origin === "generated");
  return generated.length > 0 ? generated : all;
}

function graspedSet(state: RumenState, now: number): Set<string> {
  const byGroup = new Map<string, number>();
  for (const node of state.nodes) byGroup.set(node.groupId, node.difficulty);
  const out = new Set<string>();
  for (const [groupId, difficulty] of byGroup) {
    if (masteryFor(state, groupId, difficulty, now).grasped) out.add(groupId);
  }
  return out;
}

function publicNode(
  state: RumenState,
  node: StoredNode,
  techName: string,
  grasped: ReadonlySet<string>,
  now: number,
): KnowledgeNode {
  return {
    groupId: node.groupId,
    techId: node.techId,
    techName,
    lang: node.lang,
    title: node.title,
    summary: node.summary,
    difficulty: node.difficulty,
    prerequisites: node.prerequisites,
    blockedBy: node.prerequisites.filter((id) => !grasped.has(id)).length,
    origin: node.origin,
    mastery: masteryFor(state, node.groupId, node.difficulty, now),
  };
}

function publicTechnology(
  state: RumenState,
  project: StoredProject,
  techId: string,
  lang: Locale,
  grasped: ReadonlySet<string>,
  now: number,
): Technology | null {
  const entity = state.techs.find((item) => item.id === techId);
  const usage = project.technologies.find((item) => item.techId === techId);
  if (!entity || !usage) return null;
  const stored = nodesFor(state, techId, lang);
  const nodes = stored.map((node) => publicNode(state, node, entity.name, grasped, now));
  const groupIds = new Set(stored.map((node) => node.groupId));
  const mastery = masteryOf(
    state.evidence.filter((item) => groupIds.has(item.nodeGroupId)),
    now,
    Math.max(1, ...stored.map((node) => node.difficulty)),
  );
  return {
    id: entity.id,
    name: entity.name,
    category: entity.category,
    version: usage.version,
    confidence: usage.confidence,
    worthLearning: entity.worthLearning,
    packages: usage.packages,
    evidence: usage.evidence,
    mastery,
    nodes,
    hasWiki: state.wikis.some((wiki) => wiki.techId === techId),
  };
}

function projectBucket(unreviewed: number, debt: number): StatusBucket {
  if (unreviewed > 0 || debt > 0) return "attention";
  return "done";
}

function projectSummary(
  state: RumenState,
  project: StoredProject,
  lang: Locale,
  grasped: ReadonlySet<string>,
  now: number,
  workspaceId?: string,
): ProjectSummary {
  const technologies = project.technologies
    .map((usage) => publicTechnology(state, project, usage.techId, lang, grasped, now))
    .filter((item): item is Technology => item !== null);
  const nodes = technologies.flatMap((technology) => technology.nodes);
  const averageMastery = nodes.length
    ? nodes.reduce((sum, node) => sum + node.mastery.score, 0) / nodes.length
    : 0;
  const totalDebt = nodes.reduce((sum, node) => sum + node.mastery.debt, 0);
  const unreviewed = state.reviews.filter(
    (review) => review.projectId === project.id && review.reviewedAt === null,
  ).length;
  return {
    id: project.id,
    workspaceId: workspaceId ?? project.workspaceIds[0] ?? "",
    name: project.name,
    root: project.root,
    color: identityColor(project.id),
    privacy: project.privacy,
    isGit: project.isGit,
    identityKind: identityKind(project.id),
    lastScanAt: project.lastScanAt,
    truncated: project.truncated,
    techCount: project.technologies.length,
    pendingCount: project.pending.length,
    averageMastery: Math.round(averageMastery * 10) / 10,
    totalDebt,
    unreviewedCount: unreviewed,
    bucket: projectBucket(unreviewed, totalDebt),
  };
}

function publicReviews(
  state: RumenState,
  project: StoredProject,
  lang: Locale,
  grasped: ReadonlySet<string>,
  now: number,
  includeDone: boolean,
): ReviewItem[] {
  const techName = new Map(state.techs.map((item) => [item.id, item.name]));
  const byGroup = new Map<string, StoredNode>();
  for (const node of state.nodes) {
    const existing = byGroup.get(node.groupId);
    if (!existing || (node.lang === lang && existing.lang !== lang)) byGroup.set(node.groupId, node);
  }
  return state.reviews
    .filter((review) => review.projectId === project.id && (includeDone || review.reviewedAt === null))
    .sort((left, right) => right.observedAt - left.observedAt)
    .slice(0, 100)
    .map((review) => ({
      id: review.id,
      agentId: review.agentId,
      file: review.file,
      observedAt: review.observedAt,
      reviewedAt: review.reviewedAt,
      nodes: review.nodeGroupIds
        .map((groupId) => byGroup.get(groupId))
        .filter((node): node is StoredNode => Boolean(node))
        .map((node) => publicNode(state, node, techName.get(node.techId) ?? node.techId, grasped, now)),
    }));
}

// ── 观测：从 Paseo 时间线摄取 ───────────────────────────────────────

async function collectMutations(
  context: PluginHandlerContext,
  agentId: string,
  root: string,
  limit = 300,
): Promise<{ mutations: Mutation[]; status: string | null; provider: string; title: string | null }> {
  const page = await context.paseo.agents.ref(agentId).timeline.refetch({
    direction: "tail",
    limit,
    projection: "canonical",
  });
  const mutations: Mutation[] = [];
  for (const entry of page.entries) {
    const mutation = mutationFrom(entry.item, entry.timestamp, root);
    if (mutation) mutations.push(mutation);
  }
  return {
    mutations,
    status: page.agent?.status ?? null,
    provider: page.agent?.provider ?? "",
    title: page.agent?.title ?? null,
  };
}

function agentBucket(status: string | null, requiresAttention: boolean, candidates: number): StatusBucket {
  if (requiresAttention) return "needs_input";
  if (candidates > 0) return "new_knowledge";
  if (status === "error") return "failed";
  if (status === "running") return "running";
  return "done";
}

/** 把这个项目下所有活着的 agent 的改动摄取进来。 */
async function ingestLiveAgents(
  context: PluginHandlerContext,
  project: StoredProject,
  workspaceId: string,
): Promise<Dashboard["liveAgents"]> {
  let page;
  try {
    page = await context.paseo.agents.list({ scope: "active", page: { limit: 50 } });
  } catch {
    return [];
  }
  const state = await readState();
  const grasped = graspedSet(state, Date.now());
  const knownPackages = new Set(
    project.technologies.flatMap((usage) => usage.packages.map((pkg) => pkg.toLowerCase())),
  );
  for (const item of project.pending) knownPackages.add(item.pkg.toLowerCase());

  const live: Dashboard["liveAgents"] = [];
  for (const entry of page.entries) {
    const agent = entry.agent;
    if (!agent?.id || agent.workspaceId !== workspaceId) continue;
    // 我们自己起的生成会话不算用户的 agent
    if (agent.labels?.["rumen.task"]) continue;
    const agentId = agent.id;

    const observed = await collectMutations(context, agentId, project.root, 200).catch(() => null);
    if (!observed) continue;

    const nodes = state.nodes;
    const ingest = ingestMutations({
      project,
      nodes,
      agentId,
      mutations: observed.mutations,
      grasped,
      existingObservationIds: new Set(state.observations.map((item) => item.id)),
      existingReviewIds: new Set(state.reviews.map((item) => item.id)),
    });
    if (ingest.observations.length || ingest.reviews.length || ingest.evidence.length) {
      await updateState((current) => {
        const observationIds = new Set(current.observations.map((item) => item.id));
        for (const item of ingest.observations) {
          if (!observationIds.has(item.id)) current.observations.push(item);
        }
        const reviewIds = new Set(current.reviews.map((item) => item.id));
        for (const item of ingest.reviews) if (!reviewIds.has(item.id)) current.reviews.push(item);
        const evidenceIds = new Set(current.evidence.map((item) => item.id));
        for (const item of ingest.evidence) if (!evidenceIds.has(item.id)) current.evidence.push(item);
      });
    }

    const verdict = await fastPath({
      project,
      mutations: observed.mutations,
      learned: state.aliases,
      knownPackages,
    });
    live.push({
      agentId,
      title: observed.title,
      provider: observed.provider,
      bucket: agentBucket(observed.status, Boolean(agent.requiresAttention), verdict.candidates.length),
      newKnowledge: verdict.candidates,
    });
  }
  return live;
}

// ── 生成能力的可用性 ────────────────────────────────────────────────

async function generationStatus(
  context: PluginHandlerContext,
  project: StoredProject,
  provider: string | null,
): Promise<Dashboard["generation"]> {
  if (!allowsGeneration(project.privacy)) {
    return { available: false, reason: "airgapped", codeQuizAllowed: false };
  }
  try {
    await resolveProvider(context.paseo, provider);
  } catch {
    return { available: false, reason: "no_provider", codeQuizAllowed: false };
  }
  return { available: true, reason: "ok", codeQuizAllowed: allowsProjectCode(project.privacy) };
}

// ── Dashboard ───────────────────────────────────────────────────────

async function dashboardFor(
  context: PluginHandlerContext,
  project: StoredProject,
  input: WorkspaceInput,
): Promise<Dashboard> {
  const liveAgents = await ingestLiveAgents(context, project, input.workspaceId).catch(() => []);
  const state = await readState();
  const lang = localeOf(state, input);
  const now = Date.now();
  const stored = state.projects.find((item) => item.id === project.id) ?? project;
  const grasped = graspedSet(state, now);

  const technologies = stored.technologies
    .map((usage) => publicTechnology(state, stored, usage.techId, lang, grasped, now))
    .filter((item): item is Technology => item !== null)
    .sort((left, right) =>
      Number(right.worthLearning) - Number(left.worthLearning)
      || right.confidence - left.confidence
      || left.name.localeCompare(right.name));

  const readyNodes = technologies
    .filter((technology) => technology.worthLearning)
    .flatMap((technology) => technology.nodes)
    .filter((node) => !node.mastery.grasped && node.blockedBy === 0)
    .sort((left, right) =>
      right.mastery.debt - left.mastery.debt
      || left.difficulty - right.difficulty
      || left.mastery.score - right.mastery.score)
    .slice(0, 30);

  const commits = await analyzeAndRecord(stored, state, 40);

  return {
    project: projectSummary(state, stored, lang, grasped, now, input.workspaceId),
    technologies,
    pending: stored.pending.slice(0, 60),
    readyNodes,
    commits,
    reviews: publicReviews(state, stored, lang, grasped, now, false),
    liveAgents,
    generation: await generationStatus(context, stored, state.settings.provider),
  };
}

/**
 * commit 分析的结果缓存。
 *
 * dashboard 面板每 45 秒轮询一次，而一次分析要为每个 commit 跑一次 `git show`
 * 拿 diff —— 实测一个中等仓库 1.7 秒、40 个 git 子进程。**HEAD 没动的时候
 * 结果不可能变**，所以按 `(项目, HEAD, 条数)` 缓存住。
 *
 * 掌握度会随证据变化，但那只影响 `knowledgeDebt` 的计数；
 * 拿到新证据的路径（还债、检验题）都会自己触发 dashboard 重取，
 * 那时 HEAD 一般也没变，所以这里额外挂一个证据条数做失效判据。
 */
const commitCache = new Map<string, { key: string; insights: CommitInsight[] }>();

/** 跑一次 commit 分析并把新证据落库（幂等）。 */
async function analyzeAndRecord(
  project: StoredProject,
  state: RumenState,
  limit: number,
): Promise<CommitInsight[]> {
  if (!project.isGit) return [];
  const head = await headSha(project.root);
  const cacheKey = `${head ?? "-"}|${limit}|${state.evidence.length}|${state.nodes.length}`;
  const cached = commitCache.get(project.id);
  if (cached?.key === cacheKey) return cached.insights;
  const now = Date.now();
  const result = await analyzeCommits({
    project,
    techs: new Map(state.techs.map((item) => [item.id, item])),
    nodes: state.nodes,
    observations: state.observations,
    grasped: graspedSet(state, now),
    limit,
  });
  if (result.evidence.length > 0) {
    await updateState((current) => {
      const seen = new Set(current.evidence.map((item) => item.id));
      for (const item of result.evidence) {
        if (!seen.has(item.id)) {
          current.evidence.push(item);
          seen.add(item.id);
        }
      }
    });
  }
  commitCache.set(project.id, { key: cacheKey, insights: result.insights });
  return result.insights;
}

/** 测试要能把缓存清掉，否则跨用例互相污染。 */
export function resetCommitCacheForTests(): void {
  commitCache.clear();
}

// ── Handlers ────────────────────────────────────────────────────────

export async function getDashboard(
  input: ZodOutput<typeof dashboardRpc.input>,
  context: PluginHandlerContext,
): Promise<Dashboard> {
  const t = await tFor(input);
  return dashboardFor(context, await ensureProject(input, context, t), input);
}

export async function scan(
  input: ZodOutput<typeof scanRpc.input>,
  context: PluginHandlerContext,
): Promise<Dashboard> {
  const t = await tFor(input);
  return dashboardFor(context, await ensureProject(input, context, t, { scan: true }), input);
}

export async function classify(
  input: ZodOutput<typeof classifyRpc.input>,
  context: PluginHandlerContext,
) {
  const t = await tFor(input);
  const project = await ensureProject(input, context, t);
  if (!allowsGeneration(project.privacy)) throw new Error(t.err_airgapped);
  const state = await readState();
  if (project.pending.length === 0) return { classified: 0, merged: 0 };

  let learned;
  try {
    learned = await classifyPending({
      paseo: context.paseo,
      cwd: project.root,
      provider: state.settings.provider,
      deferToUserAgents: state.settings.deferToUserAgents,
      pending: project.pending,
    });
  } catch (error) {
    throw new Error(describeGenerationError(error, t));
  }

  return updateState((current) => {
    const index = new Map(current.aliases.map((item) => [learnedKey(item.pkg, item.ecosystem), item]));
    for (const alias of learned) index.set(learnedKey(alias.pkg, alias.ecosystem), alias);
    current.aliases = [...index.values()];
    const merged = learned.filter((item) => item.techId !== null).length;
    // 重扫在下一次 dashboard 请求里发生 —— 这里只清掉待归类池，让用户看到进展
    const stored = current.projects.find((item) => item.id === project.id);
    if (stored) {
      const resolved = new Set(learned.map((item) => item.pkg));
      stored.pending = stored.pending.filter((item) => !resolved.has(item.pkg.toLowerCase()));
      stored.lastScanAt = null; // 下次 dashboard 会重扫，把新 alias 用上
    }
    return { classified: learned.length, merged };
  });
}

export async function setPrivacy(
  input: ZodOutput<typeof privacyRpc.input>,
  context: PluginHandlerContext,
): Promise<ProjectSummary> {
  const t = await tFor(input);
  const project = await ensureProject(input, context, t);
  return updateState((current) => {
    const stored = current.projects.find((item) => item.id === project.id);
    if (!stored) throw new Error(t.err_workspace_unavailable);
    stored.privacy = input.privacy;
    const now = Date.now();
    return projectSummary(current, stored, localeOf(current, input), graspedSet(current, now), now, input.workspaceId);
  });
}

export async function recordEvidence(
  input: ZodOutput<typeof evidenceRpc.input>,
  context: PluginHandlerContext,
): Promise<Mastery> {
  const t = await tFor(input);
  const project = await ensureProject(input, context, t);
  return updateState((current) => {
    const node = current.nodes.find((item) => item.groupId === input.nodeGroupId);
    if (!node) throw new Error(t.err_unknown_node);
    if (!project.technologies.some((item) => item.techId === node.techId)) {
      throw new Error(t.err_node_foreign);
    }
    const createdAt = Date.now();
    const id = evidenceKey(input.nodeGroupId, input.kind as EvidenceKind, input.reference, createdAt);
    if (!current.evidence.some((item) => item.id === id)) {
      current.evidence.push({
        id,
        nodeGroupId: input.nodeGroupId,
        projectId: project.id,
        kind: input.kind as EvidenceKind,
        reference: input.reference,
        createdAt,
      });
    }
    return masteryFor(current, input.nodeGroupId, node.difficulty, createdAt);
  });
}

// ── Wiki ────────────────────────────────────────────────────────────

function projectWiki(
  state: RumenState,
  project: StoredProject,
  techId: string,
  lang: Locale,
): Wiki | null {
  const usage = project.technologies.find((item) => item.techId === techId);
  const entity = state.techs.find((item) => item.id === techId);
  if (!usage || !entity) return null;
  const major = majorVersionOf(usage.version);
  const candidates = state.wikis.filter(
    (wiki) => wiki.techId === techId && wiki.schemaVersion === WIKI_SCHEMA_VERSION,
  );
  if (candidates.length === 0) return null;
  const exact = candidates.find((wiki) => wiki.lang === lang && wiki.majorVersion === major)
    ?? candidates.find((wiki) => wiki.lang === lang)
    ?? candidates.find((wiki) => wiki.majorVersion === major)
    ?? candidates[0]!;
  return {
    techId,
    title: entity.name,
    lang: exact.lang,
    summary: exact.summary,
    sections: exact.sections,
    sources: exact.sources,
    generatedAt: exact.generatedAt,
    sourcedRatio: exact.sourcedRatio,
    trustworthy: exact.sourcedRatio >= MIN_SOURCED_RATIO,
    anchors: usage.evidence,
    availableLangs: [...new Set(candidates.map((wiki) => wiki.lang))],
  };
}

export async function getWiki(
  input: ZodOutput<typeof wikiRpc.input>,
  context: PluginHandlerContext,
): Promise<Wiki | null> {
  const t = await tFor(input);
  const project = await ensureProject(input, context, t);
  const state = await readState();
  return projectWiki(state, project, input.techId, input.lang ?? localeOf(state, input));
}

export async function generateWikiFor(
  input: ZodOutput<typeof generateWikiRpc.input>,
  context: PluginHandlerContext,
): Promise<Wiki> {
  const t = await tFor(input);
  const project = await ensureProject(input, context, t);
  if (!allowsGeneration(project.privacy)) throw new Error(t.err_airgapped);

  const state = await readState();
  const usage = project.technologies.find((item) => item.techId === input.techId);
  const entity = state.techs.find((item) => item.id === input.techId);
  if (!usage || !entity) throw new Error(t.err_tech_absent);

  const major = majorVersionOf(usage.version);
  const cached = state.wikis.find(
    (wiki) => wiki.techId === input.techId
      && wiki.lang === input.lang
      && wiki.majorVersion === major
      && wiki.schemaVersion === WIKI_SCHEMA_VERSION,
  );
  // ⭐ Shared 层的缓存命中是跨项目的：第 100 个用 Express 的项目零成本
  if (cached && !input.force) {
    const existing = projectWiki(state, project, input.techId, input.lang);
    if (existing) return existing;
  }

  let generated;
  try {
    generated = await generateWiki({
      paseo: context.paseo,
      cwd: project.root,
      provider: state.settings.provider,
      deferToUserAgents: state.settings.deferToUserAgents,
      privacy: project.privacy,
      techId: entity.id,
      techName: entity.name,
      majorVersion: major,
      lang: input.lang,
    });
  } catch (error) {
    throw new Error(describeGenerationError(error, t));
  }

  return updateState((current) => {
    current.wikis = [
      ...current.wikis.filter(
        (wiki) => !(wiki.techId === entity.id && wiki.lang === input.lang && wiki.majorVersion === major),
      ),
      generated.wiki,
    ];
    // ⭐ 按 id upsert，只删掉**没有证据**的陈旧占位知识点。
    // 整体删除再重建会级联删掉用户几个月的掌握度和证据 —— 换个语言看文档
    // 就丢掉学习记录，这是绝对不能有的。
    const withEvidence = new Set(current.evidence.map((item) => item.nodeGroupId));
    current.nodes = current.nodes.filter((node) =>
      node.techId !== entity.id
      || node.origin === "generated"
      || withEvidence.has(node.groupId));
    const byId = new Map(current.nodes.map((node) => [node.id, node]));
    for (const node of generated.nodes) byId.set(node.id, node);
    current.nodes = [...byId.values()];

    const stored = current.projects.find((item) => item.id === project.id) ?? project;
    return projectWiki(current, stored, entity.id, input.lang)!;
  });
}

// ── 检验题 ──────────────────────────────────────────────────────────

export async function nextQuiz(
  input: ZodOutput<typeof quizNextRpc.input>,
  context: PluginHandlerContext,
) {
  const t = await tFor(input);
  const project = await ensureProject(input, context, t);
  const state = await readState();
  const lang = localeOf(state, input);
  const now = Date.now();

  const usage = project.technologies.find((item) => item.techId === input.techId);
  const entity = state.techs.find((item) => item.id === input.techId);
  if (!usage || !entity) throw new Error(t.err_tech_absent);

  const candidates = nodesFor(state, input.techId, lang);
  if (candidates.length === 0) throw new Error(t.err_no_nodes);

  // ⭐ 答对过的题不再推送 —— 否则答对一次就能无限刷 QUIZ_PASSED
  const passed = new Set(state.questions.filter((item) => item.passed).map((item) => item.nodeGroupId));
  const pool = candidates.filter((node) => !passed.has(node.groupId));
  const target = input.nodeGroupId
    ? candidates.find((node) => node.groupId === input.nodeGroupId)
    : undefined;
  const node = target
    ?? pool
      .slice()
      .sort((left, right) =>
        masteryFor(state, left.groupId, left.difficulty, now).score
        - masteryFor(state, right.groupId, right.difficulty, now).score)[0]
    ?? candidates[0]!;

  const codeAllowed = allowsProjectCode(project.privacy);
  const kind: "code" | "concept" = codeAllowed && usage.evidence.length > 0 ? "code" : "concept";
  const id = questionId(node.groupId, kind, lang);

  const existing = state.questions.find((item) => item.id === id && !item.passed);
  if (existing) {
    return {
      id: existing.id,
      techId: existing.techId,
      nodeGroupId: existing.nodeGroupId,
      nodeTitle: node.title,
      prompt: existing.prompt,
      kind: existing.kind,
      degraded: existing.kind === "concept" && !codeAllowed,
    };
  }

  if (!allowsGeneration(project.privacy)) throw new Error(t.err_airgapped);
  let generated;
  try {
    generated = await generateQuestion({
      paseo: context.paseo,
      cwd: project.root,
      provider: state.settings.provider,
      deferToUserAgents: state.settings.deferToUserAgents,
      privacy: project.privacy,
      techName: entity.name,
      nodeTitle: node.title,
      nodeSummary: node.summary,
      anchors: usage.evidence,
      lang,
    });
  } catch (error) {
    throw new Error(describeGenerationError(error, t));
  }

  const question: StoredQuestion = {
    id,
    techId: input.techId,
    nodeGroupId: node.groupId,
    lang,
    kind: generated.kind,
    prompt: generated.prompt,
    rubric: generated.rubric,
    anchors: generated.kind === "code" ? usage.evidence.slice(0, 8) : [],
    createdAt: now,
    passed: false,
    attempts: 0,
  };
  await updateState((current) => {
    current.questions = [...current.questions.filter((item) => item.id !== id), question];
  });

  return {
    id: question.id,
    techId: question.techId,
    nodeGroupId: question.nodeGroupId,
    nodeTitle: node.title,
    prompt: question.prompt,
    kind: question.kind,
    degraded: question.kind === "concept" && !codeAllowed,
  };
}

export async function answerQuiz(
  input: ZodOutput<typeof quizAnswerRpc.input>,
  context: PluginHandlerContext,
) {
  const t = await tFor(input);
  const project = await ensureProject(input, context, t);
  const state = await readState();
  const lang = localeOf(state, input);

  const question = state.questions.find((item) => item.id === input.questionId);
  if (!question) throw new Error(t.err_unknown_question);
  if (!project.technologies.some((item) => item.techId === question.techId)) {
    throw new Error(t.err_quiz_foreign);
  }

  let grade;
  let gradedLocally = false;
  if (allowsGeneration(project.privacy)) {
    try {
      grade = await gradeAnswer({
        paseo: context.paseo,
        cwd: project.root,
        provider: state.settings.provider,
        deferToUserAgents: state.settings.deferToUserAgents,
        privacy: project.privacy,
        question: question.prompt,
        rubric: question.rubric,
        answer: input.answer,
        lang,
      });
    } catch {
      grade = gradeLocally(question.rubric, input.answer);
      gradedLocally = true;
    }
  } else {
    grade = gradeLocally(question.rubric, input.answer);
    gradedLocally = true;
  }

  return updateState((current) => {
    const stored = current.questions.find((item) => item.id === input.questionId);
    if (!stored) throw new Error(t.err_unknown_question);
    stored.attempts += 1;
    const node = current.nodes.find((item) => item.groupId === stored.nodeGroupId);
    // ⭐ 只有答对才写证据。答错什么都不记 —— 否则反复乱答也能刷出"我学过"
    if (grade.passed) {
      stored.passed = true;
      const createdAt = Date.now();
      const id = evidenceKey(stored.nodeGroupId, "quiz_passed", stored.id, createdAt);
      if (!current.evidence.some((item) => item.id === id)) {
        current.evidence.push({
          id,
          nodeGroupId: stored.nodeGroupId,
          projectId: project.id,
          kind: "quiz_passed",
          reference: stored.id,
          createdAt,
        });
      }
    }
    return {
      passed: grade.passed,
      score: grade.score,
      feedback: grade.feedback,
      gradedLocally,
      mastery: masteryFor(current, stored.nodeGroupId, node?.difficulty ?? 1, Date.now()),
    };
  });
}

// ── Commits ─────────────────────────────────────────────────────────

export async function listCommits(
  input: ZodOutput<typeof commitsRpc.input>,
  context: PluginHandlerContext,
) {
  const t = await tFor(input);
  const project = await ensureProject(input, context, t);
  return { commits: await analyzeAndRecord(project, await readState(), input.limit) };
}

// ── 还债 ────────────────────────────────────────────────────────────

export async function listReviews(
  input: ZodOutput<typeof reviewsRpc.input>,
  context: PluginHandlerContext,
) {
  const t = await tFor(input);
  const project = await ensureProject(input, context, t);
  await ingestLiveAgents(context, project, input.workspaceId).catch(() => []);
  const state = await readState();
  const now = Date.now();
  return {
    reviews: publicReviews(state, project, localeOf(state, input), graspedSet(state, now), now, false),
  };
}

/**
 * 读一处待审阅改动的当前文件内容。
 *
 * **只读本地文件，一个字都不外发。** 这是"还债"的主场景：
 * 用户要真的看到 agent 写了什么才能说自己读懂了。
 */
export async function getReviewSource(
  input: ZodOutput<typeof reviewSourceRpc.input>,
  context: PluginHandlerContext,
) {
  const t = await tFor(input);
  const project = await ensureProject(input, context, t);
  const state = await readState();
  const review = state.reviews.find(
    (item) => item.id === input.reviewId && item.projectId === project.id,
  );
  if (!review) return { file: "", available: false, lines: [], anchorLines: [] };

  let content: string;
  try {
    content = await readFile(join(project.root, review.file), "utf8");
  } catch {
    return { file: review.file, available: false, lines: [], anchorLines: [] };
  }
  const anchorLines = project.technologies
    .flatMap((usage) => usage.evidence)
    .filter((anchor) => anchor.file === review.file)
    .map((anchor) => anchor.line);
  const lines = content.split(/\r?\n/).slice(0, 600).map((text, index) => ({
    line: index + 1,
    text: text.slice(0, 400),
  }));
  return { file: review.file, available: true, lines, anchorLines };
}

export async function markReviewDone(
  input: ZodOutput<typeof markReviewedRpc.input>,
  context: PluginHandlerContext,
) {
  const t = await tFor(input);
  const project = await ensureProject(input, context, t);
  const now = Date.now();
  const paid = await updateState((current) => {
    const review = current.reviews.find(
      (item) => item.id === input.reviewId && item.projectId === project.id,
    );
    if (!review || review.reviewedAt !== null) return 0;
    review.reviewedAt = now;
    const seen = new Set(current.evidence.map((item) => item.id));
    let count = 0;
    for (const item of markReviewed(review, now)) {
      if (seen.has(item.id)) continue;
      current.evidence.push(item);
      seen.add(item.id);
      count += 1;
    }
    return count;
  });
  const state = await readState();
  return {
    reviews: publicReviews(state, project, localeOf(state, input), graspedSet(state, now), now, false),
    paid,
  };
}

// ── Agent 面板 ──────────────────────────────────────────────────────

export async function getAgentImpact(
  input: ZodOutput<typeof agentImpactRpc.input>,
  context: PluginHandlerContext,
): Promise<AgentImpact> {
  const t = await tFor(input);
  const project = await ensureProject(input, context, t);
  const handle = context.paseo.agents.ref(input.agentId);
  const page = await handle.timeline.refetch({ direction: "tail", limit: 300, projection: "canonical" });
  if (page.agent?.id !== input.agentId || page.agent.workspaceId !== input.workspaceId) {
    throw new Error(t.err_agent_foreign);
  }

  const mutations: Mutation[] = [];
  for (const entry of page.entries) {
    const mutation = mutationFrom(entry.item, entry.timestamp, project.root);
    if (mutation) mutations.push(mutation);
  }

  let state = await readState();
  const grasped = graspedSet(state, Date.now());
  const ingest = ingestMutations({
    project,
    nodes: state.nodes,
    agentId: input.agentId,
    mutations,
    grasped,
    existingObservationIds: new Set(state.observations.map((item) => item.id)),
    existingReviewIds: new Set(state.reviews.map((item) => item.id)),
  });
  if (ingest.observations.length || ingest.reviews.length || ingest.evidence.length) {
    await updateState((current) => {
      const observationIds = new Set(current.observations.map((item) => item.id));
      for (const item of ingest.observations) if (!observationIds.has(item.id)) current.observations.push(item);
      const reviewIds = new Set(current.reviews.map((item) => item.id));
      for (const item of ingest.reviews) if (!reviewIds.has(item.id)) current.reviews.push(item);
      const evidenceIds = new Set(current.evidence.map((item) => item.id));
      for (const item of ingest.evidence) if (!evidenceIds.has(item.id)) current.evidence.push(item);
    });
    state = await readState();
  }

  const now = Date.now();
  const lang = localeOf(state, input);
  const refreshedGrasp = graspedSet(state, now);
  const files = new Set(mutations.map((item) => item.file));
  const techName = new Map(state.techs.map((item) => [item.id, item.name]));
  const touchedTechIds = project.technologies
    .filter((usage) => usage.evidence.some((anchor) => files.has(anchor.file)))
    .map((usage) => usage.techId);

  const weakNodes = touchedTechIds
    .flatMap((techId) => nodesFor(state, techId, lang))
    .map((node) => publicNode(state, node, techName.get(node.techId) ?? node.techId, refreshedGrasp, now))
    .filter((node) => !node.mastery.grasped)
    .slice(0, 30);

  const knownPackages = new Set(
    project.technologies.flatMap((usage) => usage.packages.map((pkg) => pkg.toLowerCase())),
  );
  const verdict = await fastPath({ project, mutations, learned: state.aliases, knownPackages });

  return {
    agentId: input.agentId,
    projectName: project.name,
    bucket: agentBucket(
      page.agent?.status ?? null,
      Boolean(page.agent?.requiresAttention),
      verdict.candidates.length,
    ),
    touchedFiles: [...files].slice(-80),
    touchedTechs: touchedTechIds.map((techId) => techName.get(techId) ?? techId),
    weakNodes,
    newKnowledge: verdict.candidates,
    totalDebt: weakNodes.reduce((sum, node) => sum + node.mastery.debt, 0),
    reviews: publicReviews(state, project, lang, refreshedGrasp, now, false)
      .filter((review) => review.agentId === input.agentId),
  };
}

// ── 全局 ────────────────────────────────────────────────────────────

export async function overview(input: ZodOutput<typeof overviewRpc.input>) {
  const state = await readState();
  const lang = localeOf(state, input);
  const now = Date.now();
  const grasped = graspedSet(state, now);
  const techName = new Map(state.techs.map((item) => [item.id, item.name]));
  const allNodes = state.nodes
    .filter((node) => node.lang === lang || !state.nodes.some((other) => other.groupId === node.groupId && other.lang === lang))
    .map((node) => publicNode(state, node, techName.get(node.techId) ?? node.techId, grasped, now));
  const uniqueTech = new Set(state.projects.flatMap((project) => project.technologies.map((item) => item.techId)));
  return {
    projects: state.projects.map((project) => projectSummary(state, project, lang, grasped, now)),
    totalTechnologies: uniqueTech.size,
    totalNodes: allNodes.length,
    graspedNodes: allNodes.filter((node) => node.mastery.grasped).length,
    totalDebt: allNodes.reduce((sum, node) => sum + node.mastery.debt, 0),
    unreviewedCount: state.reviews.filter((review) => review.reviewedAt === null).length,
    locale: lang,
  };
}

// ── 设置 ────────────────────────────────────────────────────────────

async function settingsView(
  state: RumenState,
  input: LocaleInput,
  context: PluginHandlerContext,
): Promise<Settings> {
  const providers = await listGenerationProviders(context.paseo).catch(() => []);
  return {
    locale: state.settings.locale,
    resolvedLocale: localeOf(state, input),
    lockedByEnv: LOCALES.some(
      (locale) => (process.env.RUMEN_LANG ?? "").toLowerCase().startsWith(locale),
    ),
    provider: state.settings.provider,
    availableProviders: providers,
    deferToUserAgents: state.settings.deferToUserAgents,
  };
}

export async function getSettings(
  input: ZodOutput<typeof settingsRpc.input>,
  context: PluginHandlerContext,
): Promise<Settings> {
  return settingsView(await readState(), input, context);
}

export async function updateSettings(
  input: ZodOutput<typeof updateSettingsRpc.input>,
  context: PluginHandlerContext,
): Promise<Settings> {
  const state = await updateState((current) => {
    if (input.locale !== undefined) current.settings.locale = input.locale;
    if (input.provider !== undefined) current.settings.provider = input.provider;
    if (input.deferToUserAgents !== undefined) current.settings.deferToUserAgents = input.deferToUserAgents;
    return structuredClone(current);
  });
  return settingsView(state, input, context);
}

// ── 导出 ────────────────────────────────────────────────────────────

export async function exportKnowledge(_input: ZodOutput<typeof exportRpc.input>) {
  const state = await readState();
  const now = Date.now();
  const { mkdir, writeFile } = await import("node:fs/promises");
  const directory = join(dataDirectory(), "export");
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const records: unknown[] = [];
  for (const node of state.nodes) {
    records.push({
      type: "node",
      groupId: node.groupId,
      techId: node.techId,
      lang: node.lang,
      title: node.title,
      summary: node.summary,
      difficulty: node.difficulty,
      prerequisites: node.prerequisites,
      origin: node.origin,
      mastery: masteryFor(state, node.groupId, node.difficulty, now),
    });
  }
  for (const item of state.evidence) {
    records.push({
      type: "evidence",
      id: item.id,
      nodeGroupId: item.nodeGroupId,
      // ⭐ 项目身份哈希掉：导出里不该出现项目名、路径或 remote
      project: item.projectId ? stableHash(item.projectId) : null,
      kind: item.kind,
      createdAt: item.createdAt,
    });
  }
  for (const wiki of state.wikis) {
    records.push({
      type: "wiki",
      techId: wiki.techId,
      majorVersion: wiki.majorVersion,
      lang: wiki.lang,
      title: wiki.title,
      summary: wiki.summary,
      sections: wiki.sections,
      sources: wiki.sources,
      generatedAt: wiki.generatedAt,
      sourcedRatio: wiki.sourcedRatio,
    });
  }
  records.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const path = join(directory, "rumen.jsonl");
  await writeFile(path, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { path, records: records.length };
}

// ── 附件源 ──────────────────────────────────────────────────────────

export async function searchAttachments(input: ZodOutput<typeof attachmentSearchRpc.input>) {
  const state = await readState();
  const now = Date.now();
  const query = input.query.trim().toLowerCase();
  const techName = new Map(state.techs.map((item) => [item.id, item.name]));
  const items: Array<{
    id: string;
    identifier: string;
    title: string;
    subtitle?: string;
    url: string;
    text: string;
    resourceType: string;
  }> = [];

  for (const node of state.nodes) {
    const name = techName.get(node.techId) ?? node.techId;
    const haystack = `${name} ${node.title} ${node.summary}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;
    const mastery = masteryFor(state, node.groupId, node.difficulty, now);
    items.push({
      id: node.id,
      identifier: node.groupId,
      title: node.title,
      subtitle: `${name} · ${Math.round(mastery.score)}/100 · debt ${mastery.debt}`,
      url: `rumen://knowledge/${encodeURIComponent(node.groupId)}`,
      text: `# ${node.title}\n\n${node.summary}\n\nCurrent mastery: ${
        Math.round(mastery.score)
      }/100; confidence ${Math.round(mastery.confidence * 100)}%; knowledge debt ${mastery.debt}.\n\nUse this as learning context. Do not claim the user understands concepts without positive evidence.`,
      resourceType: "rumen-knowledge",
    });
    if (items.length >= 50) break;
  }
  return { items };
}

// ── 错误文案 ────────────────────────────────────────────────────────

function describeGenerationError(error: unknown, t: Translator): string {
  if (error instanceof GenerationBusyError) return t.err_generation_busy;
  if (error instanceof NoProviderError) return t.err_no_provider;
  if (error instanceof Error && error.name === "GenerationInvalidError") return t.err_generation_invalid;
  return t.err_generation_failed(error instanceof Error ? error.message : String(error));
}
