import { defineAttachmentSource, defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const PrivacySchema = z.enum(["public", "private", "airgapped"]);
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
  id: z.string(),
  techId: z.string(),
  title: z.string(),
  summary: z.string(),
  difficulty: z.number().int().min(1).max(5),
  prerequisites: z.array(z.string()),
  mastery: MasterySchema,
});

export const TechnologySchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  version: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  worthLearning: z.boolean().nullable(),
  curated: z.boolean(),
  evidence: z.array(EvidenceAnchorSchema),
  mastery: MasterySchema,
  nodes: z.array(KnowledgeNodeSchema),
});

export const ProjectSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  root: z.string(),
  privacy: PrivacySchema,
  lastScanAt: z.number().int().nullable(),
  truncated: z.boolean(),
  techCount: z.number().int().nonnegative(),
  averageMastery: z.number().min(0).max(100),
  totalDebt: z.number().int().nonnegative(),
});

export const CommitInsightSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  authoredAt: z.number().int(),
  authorship: z.enum(["human", "agent", "mixed", "unknown"]),
  confidence: z.number().min(0).max(1),
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  touchedTechs: z.array(z.string()),
  knowledgeDebt: z.number().int().nonnegative(),
});

export const DashboardSchema = z.object({
  project: ProjectSchema,
  technologies: z.array(TechnologySchema),
  readyNodes: z.array(KnowledgeNodeSchema),
  commits: z.array(CommitInsightSchema),
});

export const WikiSchema = z.object({
  techId: z.string(),
  title: z.string(),
  body: z.string(),
  generatedAt: z.number().int(),
  sourceCount: z.number().int().nonnegative(),
  sourcedRatio: z.number().min(0).max(1),
  anchors: z.array(EvidenceAnchorSchema),
});

export const QuizSchema = z.object({
  id: z.string(),
  techId: z.string(),
  nodeId: z.string(),
  nodeTitle: z.string(),
  prompt: z.string(),
});

export const QuizResultSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  feedback: z.string(),
  mastery: MasterySchema,
});

export const AgentImpactSchema = z.object({
  agentId: z.string(),
  projectName: z.string(),
  active: z.boolean(),
  touchedFiles: z.array(z.string()),
  touchedTechs: z.array(z.string()),
  weakNodes: z.array(KnowledgeNodeSchema),
  newKnowledge: z.array(z.string()),
  totalDebt: z.number().int().nonnegative(),
});

const WorkspaceInput = z.object({
  workspaceId: z.string().min(1).max(256),
  cwd: z.string().min(1).max(4096),
});

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

export const privacyRpc = defineRpc({
  name: "rumen.privacy",
  input: WorkspaceInput.extend({ privacy: PrivacySchema }),
  output: ProjectSchema,
});

export const evidenceRpc = defineRpc({
  name: "rumen.evidence",
  input: WorkspaceInput.extend({
    nodeId: z.string().min(1).max(512),
    kind: EvidenceKindSchema,
    reference: z.string().max(4096).optional(),
  }),
  output: MasterySchema,
});

export const wikiRpc = defineRpc({
  name: "rumen.wiki",
  input: WorkspaceInput.extend({ techId: z.string().min(1).max(512), force: z.boolean().default(false) }),
  output: WikiSchema,
});

export const quizNextRpc = defineRpc({
  name: "rumen.quiz-next",
  input: WorkspaceInput.extend({ techId: z.string().min(1).max(512) }),
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

export const agentImpactRpc = defineRpc({
  name: "rumen.agent-impact",
  input: WorkspaceInput.extend({ agentId: z.string().min(1).max(256) }),
  output: AgentImpactSchema,
});

export const overviewRpc = defineRpc({
  name: "rumen.overview",
  input: z.object({}),
  output: z.object({
    projects: z.array(ProjectSchema),
    totalTechnologies: z.number().int().nonnegative(),
    totalNodes: z.number().int().nonnegative(),
    graspedNodes: z.number().int().nonnegative(),
    totalDebt: z.number().int().nonnegative(),
  }),
});

export const exportRpc = defineRpc({
  name: "rumen.export",
  input: z.object({}),
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
  searchPlaceholder: "Search technologies, nodes, or projects",
  search: attachmentSearchRpc,
});

export const TimelineImpactSchema = z.object({
  tool: z.string(),
  target: z.string(),
  signal: z.enum(["manifest", "source"]),
  label: z.string(),
});

export type Dashboard = z.output<typeof DashboardSchema>;
export type Technology = z.output<typeof TechnologySchema>;
export type KnowledgeNode = z.output<typeof KnowledgeNodeSchema>;
export type ProjectSummary = z.output<typeof ProjectSchema>;
export type CommitInsight = z.output<typeof CommitInsightSchema>;
export type AgentImpact = z.output<typeof AgentImpactSchema>;
export type Wiki = z.output<typeof WikiSchema>;
export type Quiz = z.output<typeof QuizSchema>;
export type TimelineImpact = z.output<typeof TimelineImpactSchema>;
