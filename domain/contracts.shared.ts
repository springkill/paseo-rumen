/**
 * RPC 契约。
 *
 * ⭐ **答案在类型上就到不了展示层。** {@link QuizSchema} 里**根本没有 rubric
 * 字段** —— 评分要点只在 {@link StoredQuestion} 里，只被评分路径读。
 * 靠类型让"答案泄漏"写不出来，比靠自觉可靠。
 *
 * ⭐ **每个面向用户的 RPC 都带 `locale`。** 服务端产生的文案（错误、
 * 降级说明）要用同一份 catalog 本地化 —— 界面是中文而错误弹英文，
 * 是同一个 bug 的两种表现。
 */

import { defineAttachmentSource, defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";
import { LOCALES } from "./i18n.shared";
import { TECH_CATEGORIES } from "./techmap.shared";

export const LocaleSchema = z.enum(LOCALES);
export const PrivacySchema = z.enum(["public", "private", "airgapped"]);
export const AuthorshipSchema = z.enum(["human", "agent", "mixed", "unknown"]);
export const BucketSchema = z.enum([
  "needs_input",
  "new_knowledge",
  "failed",
  "running",
  "attention",
  "done",
]);
export const EvidenceKindSchema = z.enum([
  "agent_wrote_unreviewed",
  "agent_wrote_reviewed",
  "human_wrote",
  "wiki_read",
  "quiz_passed",
  "debugged",
]);

export const EvidenceAnchorSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative(),
  snippet: z.string(),
  layer: z.enum(["manifest", "config", "source"]),
});

export const MasterySchema = z.object({
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  debt: z.number().int().nonnegative(),
  grasped: z.boolean(),
});

export const KnowledgeNodeSchema = z.object({
  groupId: z.string(),
  techId: z.string(),
  techName: z.string(),
  lang: LocaleSchema,
  title: z.string(),
  summary: z.string(),
  difficulty: z.number().int().min(1).max(5),
  prerequisites: z.array(z.string()),
  /** 前置知识点里还没掌握的个数。>0 = 这个知识点现在学不了。 */
  blockedBy: z.number().int().nonnegative(),
  /** `fallback` = 占位内容，UI 必须明说"生成一次才有真内容"。 */
  origin: z.enum(["generated", "fallback"]),
  mastery: MasterySchema,
});

export const TechnologySchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(TECH_CATEGORIES as unknown as [string, ...string[]]),
  version: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  worthLearning: z.boolean(),
  packages: z.array(z.string()),
  evidence: z.array(EvidenceAnchorSchema),
  mastery: MasterySchema,
  nodes: z.array(KnowledgeNodeSchema),
  /** 有没有生成过 Wiki。没有的话知识点是占位的。 */
  hasWiki: z.boolean(),
});

export const PendingPackageSchema = z.object({
  pkg: z.string(),
  ecosystem: z.string(),
  version: z.string().nullable(),
  occurrences: z.number().int().nonnegative(),
});

export const ProjectSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  root: z.string(),
  /** 身份色，只回答"这是哪个项目"，不参与排序。 */
  color: z.string(),
  privacy: PrivacySchema,
  isGit: z.boolean(),
  /** `path:` 身份的项目移动目录会丢历史，UI 要提示。 */
  identityKind: z.enum(["git", "root", "path"]),
  lastScanAt: z.number().int().nullable(),
  truncated: z.boolean(),
  techCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  averageMastery: z.number().min(0).max(100),
  totalDebt: z.number().int().nonnegative(),
  unreviewedCount: z.number().int().nonnegative(),
  bucket: BucketSchema,
});

export const CommitInsightSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  authoredAt: z.number().int(),
  authorship: AuthorshipSchema,
  confidence: z.number().min(0).max(1),
  /** 可审计的判据。归因错了得能查出为什么。 */
  signals: z.array(z.string()),
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  touchedTechs: z.array(z.string()),
  knowledgeDebt: z.number().int().nonnegative(),
});

export const ReviewItemSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  file: z.string(),
  observedAt: z.number().int(),
  reviewedAt: z.number().int().nullable(),
  nodes: z.array(KnowledgeNodeSchema),
});

export const LiveAgentSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  bucket: BucketSchema,
  /** L0：这一轮里出现的、项目从没见过的依赖。 */
  newKnowledge: z.array(z.string()),
});

export const DashboardSchema = z.object({
  project: ProjectSchema,
  technologies: z.array(TechnologySchema),
  pending: z.array(PendingPackageSchema),
  readyNodes: z.array(KnowledgeNodeSchema),
  commits: z.array(CommitInsightSchema),
  reviews: z.array(ReviewItemSchema),
  liveAgents: z.array(LiveAgentSchema),
  /** 生成能力是否可用，以及为什么不可用。UI 必须明说，不能静默降级。 */
  generation: z.object({
    available: z.boolean(),
    reason: z.enum(["ok", "airgapped", "no_provider"]),
    codeQuizAllowed: z.boolean(),
  }),
});

export const WikiSectionSchema = z.object({
  heading: z.string(),
  body: z.string(),
  sourceRefs: z.array(z.number().int().nonnegative()),
});

export const SourceSchema = z.object({
  url: z.string(),
  title: z.string(),
  authority: z.number().int().min(1).max(4),
});

export const WikiSchema = z.object({
  techId: z.string(),
  title: z.string(),
  lang: LocaleSchema,
  summary: z.string(),
  sections: z.array(WikiSectionSchema),
  sources: z.array(SourceSchema),
  generatedAt: z.number().int(),
  sourcedRatio: z.number().min(0).max(1),
  /** 低于阈值时 UI 必须明说这篇不可信。 */
  trustworthy: z.boolean(),
  anchors: z.array(EvidenceAnchorSchema),
  /** 有没有别的语言的版本，用来提示"可以生成中文版"。 */
  availableLangs: z.array(LocaleSchema),
});

/**
 * 下发给客户端的题目。
 *
 * ⭐ **没有 rubric，没有 answer。** 这不是遗漏，是这个类型存在的理由。
 */
export const QuizSchema = z.object({
  id: z.string(),
  techId: z.string(),
  nodeGroupId: z.string(),
  nodeTitle: z.string(),
  prompt: z.string(),
  kind: z.enum(["code", "concept"]),
  /** 概念题是不是因为隐私级别降级来的。降级要明说，否则用户会高估通过的含金量。 */
  degraded: z.boolean(),
});

export const QuizResultSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  feedback: z.string(),
  /** 判分是不是走的本地降级路径（比 agent 判分弱）。 */
  gradedLocally: z.boolean(),
  mastery: MasterySchema,
});

export const AgentImpactSchema = z.object({
  agentId: z.string(),
  projectName: z.string(),
  bucket: BucketSchema,
  touchedFiles: z.array(z.string()),
  touchedTechs: z.array(z.string()),
  weakNodes: z.array(KnowledgeNodeSchema),
  newKnowledge: z.array(z.string()),
  totalDebt: z.number().int().nonnegative(),
  reviews: z.array(ReviewItemSchema),
});

export const JobSchema = z.object({
  id: z.string(),
  kind: z.enum(["wiki", "classify"]),
  projectId: z.string(),
  techId: z.string().nullable(),
  status: z.enum(["running", "done", "failed"]),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  error: z.string().nullable(),
  /** Rumen 起的那个会话。失败时用户要能点进去看它到底答了什么。 */
  agentId: z.string().nullable(),
});

export const SettingsSchema = z.object({
  locale: z.enum(["auto", ...LOCALES]),
  /** `auto` 解析出来的实际语言，设置页要显示。 */
  resolvedLocale: LocaleSchema,
  /** RUMEN_LANG 锁死时设置项无效，UI 要说明。 */
  lockedByEnv: z.boolean(),
  provider: z.string().nullable(),
  availableProviders: z.array(z.object({ id: z.string(), label: z.string() })),
  deferToUserAgents: z.boolean(),
});

// ── 输入 ────────────────────────────────────────────────────────────

const LocaleInput = z.object({
  /** 客户端检测到的语言，作为 `auto` 的一个来源。 */
  clientLocale: z.string().max(35).optional(),
});

/**
 * 目标项目的两种寻址方式。
 *
 * - `workspaceId + cwd`：从 workspace 面板来。会校验目录确实是这个 Paseo
 *   workspace 的，并且允许扫描（首次绑定就走这条）。
 * - `projectId`：从全局 Rumen 界面来。项目根在绑定时已经校验过了，
 *   这里直接用存下来的那个 —— 全局界面上并不存在"当前 workspace"这个东西。
 *
 * 两个都不给会被服务端拒掉。
 */
const WorkspaceInput = LocaleInput.extend({
  workspaceId: z.string().min(1).max(256).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  projectId: z.string().min(1).max(512).optional(),
});

const TechInput = WorkspaceInput.extend({ techId: z.string().min(1).max(512) });

// ── RPC ─────────────────────────────────────────────────────────────

export const dashboardRpc = defineRpc({
  name: "rumen.dashboard",
  input: WorkspaceInput,
  output: DashboardSchema,
});

export const scanRpc = defineRpc({
  name: "rumen.scan",
  input: WorkspaceInput,
  output: DashboardSchema,
});

export const classifyRpc = defineRpc({
  name: "rumen.classify",
  input: WorkspaceInput,
  output: z.object({ job: JobSchema.nullable() }),
});

export const privacyRpc = defineRpc({
  name: "rumen.privacy",
  input: WorkspaceInput.extend({ privacy: PrivacySchema }),
  output: ProjectSchema,
});

export const evidenceRpc = defineRpc({
  name: "rumen.evidence",
  input: WorkspaceInput.extend({
    nodeGroupId: z.string().min(1).max(512),
    kind: EvidenceKindSchema,
    reference: z.string().max(4096).optional(),
  }),
  output: MasterySchema,
});

export const wikiRpc = defineRpc({
  name: "rumen.wiki",
  input: TechInput.extend({ lang: LocaleSchema.optional() }),
  output: WikiSchema.nullable(),
});

/**
 * 起一个 wiki 生成任务。**立刻返回**，不等生成完。
 *
 * 生成要几分钟，长在请求-响应上会把界面转死，传输层也会先超时。
 * 拿到 job 之后用 {@link jobsRpc} 轮询。
 */
export const generateWikiRpc = defineRpc({
  name: "rumen.generate-wiki",
  input: TechInput.extend({ lang: LocaleSchema, force: z.boolean().default(false) }),
  output: z.object({ job: JobSchema.nullable(), wiki: WikiSchema.nullable() }),
});

export const jobsRpc = defineRpc({
  name: "rumen.jobs",
  input: WorkspaceInput,
  output: z.object({ jobs: z.array(JobSchema) }),
});

export const quizNextRpc = defineRpc({
  name: "rumen.quiz-next",
  input: TechInput.extend({ nodeGroupId: z.string().max(512).optional() }),
  output: QuizSchema,
});

export const quizAnswerRpc = defineRpc({
  name: "rumen.quiz-answer",
  input: WorkspaceInput.extend({
    questionId: z.string().min(1).max(512),
    answer: z.string().min(1).max(8000),
  }),
  output: QuizResultSchema,
});

export const commitsRpc = defineRpc({
  name: "rumen.commits",
  input: WorkspaceInput.extend({ limit: z.number().int().min(1).max(200).default(50) }),
  output: z.object({ commits: z.array(CommitInsightSchema) }),
});

export const reviewsRpc = defineRpc({
  name: "rumen.reviews",
  input: WorkspaceInput,
  output: z.object({ reviews: z.array(ReviewItemSchema) }),
});

/** 取一处待审阅改动的当前文件内容。**只读本地文件，不外发。** */
export const reviewSourceRpc = defineRpc({
  name: "rumen.review-source",
  input: WorkspaceInput.extend({ reviewId: z.string().min(1).max(512) }),
  output: z.object({
    file: z.string(),
    available: z.boolean(),
    lines: z.array(z.object({ line: z.number().int().positive(), text: z.string() })),
    anchorLines: z.array(z.number().int().positive()),
  }),
});

export const markReviewedRpc = defineRpc({
  name: "rumen.mark-reviewed",
  input: WorkspaceInput.extend({ reviewId: z.string().min(1).max(512) }),
  output: z.object({ reviews: z.array(ReviewItemSchema), paid: z.number().int().nonnegative() }),
});

export const agentImpactRpc = defineRpc({
  name: "rumen.agent-impact",
  input: WorkspaceInput.extend({ agentId: z.string().min(1).max(256) }),
  output: AgentImpactSchema,
});

export const overviewRpc = defineRpc({
  name: "rumen.overview",
  input: LocaleInput,
  output: z.object({
    projects: z.array(ProjectSchema),
    totalTechnologies: z.number().int().nonnegative(),
    totalNodes: z.number().int().nonnegative(),
    graspedNodes: z.number().int().nonnegative(),
    totalDebt: z.number().int().nonnegative(),
    unreviewedCount: z.number().int().nonnegative(),
    locale: LocaleSchema,
  }),
});

export const settingsRpc = defineRpc({
  name: "rumen.settings",
  input: LocaleInput,
  output: SettingsSchema,
});

export const updateSettingsRpc = defineRpc({
  name: "rumen.update-settings",
  input: LocaleInput.extend({
    locale: z.enum(["auto", ...LOCALES]).optional(),
    provider: z.string().max(200).nullable().optional(),
    deferToUserAgents: z.boolean().optional(),
  }),
  output: SettingsSchema,
});

export const exportRpc = defineRpc({
  name: "rumen.export",
  input: LocaleInput,
  output: z.object({ path: z.string(), records: z.number().int().nonnegative() }),
});

export const attachmentSearchRpc = defineRpc({
  name: "rumen.attachments",
  input: z.object({ query: z.string().max(500) }),
  output: z.object({
    items: z.array(z.object({
      id: z.string(),
      identifier: z.string(),
      title: z.string(),
      subtitle: z.string().optional(),
      url: z.string().url(),
      text: z.string(),
      resourceType: z.string(),
    })),
  }),
});

export const rumenAttachmentSource = defineAttachmentSource({
  id: "rumen-knowledge",
  title: "Rumen knowledge",
  icon: "BrainCircuit",
  pickerTitle: "Attach Rumen knowledge",
  searchPlaceholder: "Search technologies, concepts, or projects",
  search: attachmentSearchRpc,
});

export const TimelineImpactSchema = z.object({
  tool: z.string(),
  target: z.string(),
  signal: z.enum(["manifest", "source"]),
});

export type Dashboard = z.output<typeof DashboardSchema>;
export type Technology = z.output<typeof TechnologySchema>;
export type KnowledgeNode = z.output<typeof KnowledgeNodeSchema>;
export type ProjectSummary = z.output<typeof ProjectSchema>;
export type CommitInsight = z.output<typeof CommitInsightSchema>;
export type ReviewItem = z.output<typeof ReviewItemSchema>;
export type LiveAgent = z.output<typeof LiveAgentSchema>;
export type AgentImpact = z.output<typeof AgentImpactSchema>;
export type Wiki = z.output<typeof WikiSchema>;
export type Quiz = z.output<typeof QuizSchema>;
export type QuizResult = z.output<typeof QuizResultSchema>;
export type Settings = z.output<typeof SettingsSchema>;
export type Job = z.output<typeof JobSchema>;
export type TimelineImpact = z.output<typeof TimelineImpactSchema>;
export type PendingPackageView = z.output<typeof PendingPackageSchema>;

/** 客户端拼 RPC 入参用。两种寻址方式二选一，类型上就不允许混着传。 */
export type RumenTarget =
  | { workspaceId: string; cwd: string; projectId?: never }
  | { projectId: string; workspaceId?: never; cwd?: never };
