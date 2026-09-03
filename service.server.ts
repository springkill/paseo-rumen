import type { PluginHandlerContext } from "@getpaseo/plugin";
import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { output as ZodOutput } from "zod";
import {
  agentImpactRpc,
  attachmentSearchRpc,
  commitsRpc,
  dashboardRpc,
  evidenceRpc,
  exportRpc,
  overviewRpc,
  privacyRpc,
  quizAnswerRpc,
  quizNextRpc,
  scanRpc,
  wikiRpc,
  type AgentImpact,
  type CommitInsight,
  type Dashboard,
  type KnowledgeNode,
  type ProjectSummary,
  type Technology,
} from "./contracts.shared";
import { evidenceKey, masteryOf, stableHash, type EvidenceKind } from "./domain.shared";
import { identifyProject, resolveProjectRoot, scanWorkspace } from "./scanner.server";
import {
  dataDirectory,
  readState,
  updateState,
  type RumenState,
  type StoredNode,
  type StoredProject,
  type StoredQuestion,
  type StoredTechnology,
} from "./store.server";

const exec = promisify(execFile);

type WorkspaceInput = { workspaceId: string; cwd: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function validateWorkspace(input: WorkspaceInput, context: PluginHandlerContext): Promise<{ root: string; name: string }> {
  if (!input.cwd.startsWith(sep)) throw new Error("Workspace directory must be absolute");
  const snapshot = await context.paseo.workspaces.ref(input.workspaceId).refresh();
  if (!snapshot || snapshot.id !== input.workspaceId || !snapshot.workspaceDirectory) throw new Error("Workspace is unavailable on this Paseo host");
  const [supplied, actual] = await Promise.all([realpath(resolve(input.cwd)), realpath(resolve(snapshot.workspaceDirectory))]);
  if (supplied !== actual) throw new Error("Workspace directory does not match the selected Paseo workspace");
  const root = await resolveProjectRoot(actual);
  return { root, name: snapshot.title ?? snapshot.name ?? basename(root) };
}

function genericNodes(tech: StoredTechnology): StoredNode[] {
  const prefix = `${tech.id}:`;
  const basics = `${prefix}fundamentals`;
  const integration = `${prefix}integration`;
  return [
    {
      id: basics,
      techId: tech.id,
      title: `${tech.name} fundamentals`,
      summary: `Understand the core abstractions, execution model, and vocabulary of ${tech.name}.`,
      difficulty: 1,
      prerequisites: [],
      keywords: [tech.name, "core", "fundamentals", "abstractions"],
    },
    {
      id: integration,
      techId: tech.id,
      title: `${tech.name} integration`,
      summary: `Apply ${tech.name} safely in a real project, including configuration, boundaries, and tests.`,
      difficulty: 2,
      prerequisites: [basics],
      keywords: [tech.name, "configuration", "integration", "tests"],
    },
    {
      id: `${prefix}operations`,
      techId: tech.id,
      title: `${tech.name} production and debugging`,
      summary: `Diagnose failures, performance limits, security concerns, and operational trade-offs in ${tech.name}.`,
      difficulty: 3,
      prerequisites: [integration],
      keywords: [tech.name, "debugging", "performance", "security", "production"],
    },
  ];
}

function ensureNodes(state: RumenState, technologies: StoredTechnology[]) {
  const known = new Set(state.nodes.map((node) => node.id));
  for (const technology of technologies) {
    for (const node of genericNodes(technology)) {
      if (!known.has(node.id)) {
        state.nodes.push(node);
        known.add(node.id);
      }
    }
  }
}

function masteryForNode(state: RumenState, nodeId: string) {
  return masteryOf(state.evidence.filter((item) => item.nodeId === nodeId));
}

function publicNode(state: RumenState, node: StoredNode): KnowledgeNode {
  return { ...node, mastery: masteryForNode(state, node.id) };
}

function publicTechnology(state: RumenState, technology: StoredTechnology): Technology {
  const nodes = state.nodes.filter((node) => node.techId === technology.id).map((node) => publicNode(state, node));
  const mastery = masteryOf(state.evidence.filter((item) => nodes.some((node) => node.id === item.nodeId)));
  return { ...technology, mastery, nodes };
}

function projectSummary(state: RumenState, project: StoredProject, workspaceId?: string): ProjectSummary {
  const technologies = project.technologies.map((technology) => publicTechnology(state, technology));
  const nodes = technologies.flatMap((technology) => technology.nodes);
  const averageMastery = nodes.length ? nodes.reduce((sum, node) => sum + node.mastery.score, 0) / nodes.length : 0;
  return {
    id: project.id,
    workspaceId: workspaceId ?? project.workspaceIds[0] ?? "",
    name: project.name,
    root: project.root,
    privacy: project.privacy,
    lastScanAt: project.lastScanAt,
    truncated: project.truncated,
    techCount: project.technologies.length,
    averageMastery: Math.round(averageMastery * 10) / 10,
    totalDebt: nodes.reduce((sum, node) => sum + node.mastery.debt, 0),
  };
}

async function ensureProject(input: WorkspaceInput, context: PluginHandlerContext, scan = false): Promise<StoredProject> {
  const workspace = await validateWorkspace(input, context);
  const identity = await identifyProject(workspace.root);
  return updateState(async (state) => {
    let project = state.projects.find((item) => item.id === identity.id || item.root === workspace.root);
    if (!project) {
      project = {
        id: identity.id,
        workspaceIds: [input.workspaceId],
        name: workspace.name || identity.name,
        root: workspace.root,
        privacy: "private",
        lastScanAt: null,
        truncated: false,
        technologies: [],
      };
      state.projects.push(project);
    }
    project.id = identity.id;
    project.root = workspace.root;
    project.name = workspace.name || identity.name;
    if (!project.workspaceIds.includes(input.workspaceId)) project.workspaceIds.push(input.workspaceId);
    if (scan || project.lastScanAt === null) {
      const result = await scanWorkspace(workspace.root);
      project.technologies = result.technologies;
      project.truncated = result.truncated;
      project.lastScanAt = Date.now();
      ensureNodes(state, result.technologies);
    }
    return structuredClone(project);
  });
}

async function git(root: string, args: string[], maxBuffer = 10 * 1024 * 1024): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", root, ...args], { maxBuffer });
    return stdout;
  } catch {
    return "";
  }
}

function authorship(subject: string, body: string) {
  const value = `${subject}\n${body}`;
  const markers = [/(co-authored-by:.*(?:claude|codex|copilot|agent))/i, /(?:generated|written|implemented)-by:\s*(?:ai|agent|claude|codex)/i, /\[agent\]|🤖/i];
  const hits = markers.filter((pattern) => pattern.test(value)).length;
  if (hits >= 2) return { authorship: "agent" as const, confidence: 0.98 };
  if (hits === 1) return { authorship: "agent" as const, confidence: 0.95 };
  return { authorship: "unknown" as const, confidence: 0.3 };
}

async function analyzeCommits(project: StoredProject, state: RumenState, limit: number): Promise<CommitInsight[]> {
  const format = "%x1e%H%x1f%ct%x1f%s%x1f%b";
  const output = await git(project.root, ["log", `-${limit}`, `--pretty=format:${format}`, "--numstat"], 30 * 1024 * 1024);
  if (!output.trim()) return [];
  const technologies = project.technologies.map((technology) => publicTechnology(state, technology));
  const commits: CommitInsight[] = [];
  for (const chunk of output.split("\x1e").filter(Boolean)) {
    const lines = chunk.split(/\r?\n/);
    const header = lines.shift()?.split("\x1f") ?? [];
    if (header.length < 4) continue;
    const [sha, timestamp, subject, ...bodyParts] = header;
    const body = bodyParts.join("\x1f");
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    const files: string[] = [];
    for (const line of lines) {
      const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (!match) continue;
      filesChanged += 1;
      insertions += match[1] === "-" ? 0 : Number(match[1]);
      deletions += match[2] === "-" ? 0 : Number(match[2]);
      files.push(match[3]);
    }
    const touched = technologies.filter((technology) => technology.evidence.some((item) => files.includes(item.file)));
    const debt = touched.flatMap((technology) => technology.nodes).filter((node) => !node.mastery.grasped).length;
    const attribution = authorship(subject, body);
    commits.push({
      sha,
      subject,
      authoredAt: Number(timestamp) * 1000,
      ...attribution,
      filesChanged,
      insertions,
      deletions,
      touchedTechs: touched.map((item) => item.name),
      knowledgeDebt: debt,
    });
  }
  return commits;
}

async function dashboardFor(project: StoredProject, workspaceId: string): Promise<Dashboard> {
  const state = await readState();
  const stored = state.projects.find((item) => item.id === project.id) ?? project;
  ensureNodes(state, stored.technologies);
  const technologies = stored.technologies.map((technology) => publicTechnology(state, technology));
  const readyNodes = technologies.flatMap((technology) => technology.nodes).filter((node) => {
    if (node.mastery.grasped) return false;
    return node.prerequisites.every((id) => masteryForNode(state, id).grasped);
  }).sort((left, right) => left.difficulty - right.difficulty || left.mastery.score - right.mastery.score).slice(0, 30);
  return {
    project: projectSummary(state, stored, workspaceId),
    technologies,
    readyNodes,
    commits: await analyzeCommits(stored, state, 30),
  };
}

export async function getDashboard(input: ZodOutput<typeof dashboardRpc.input>, context: PluginHandlerContext) {
  return dashboardFor(await ensureProject(input, context), input.workspaceId);
}

export async function scan(input: ZodOutput<typeof scanRpc.input>, context: PluginHandlerContext) {
  return dashboardFor(await ensureProject(input, context, true), input.workspaceId);
}

export async function setPrivacy(input: ZodOutput<typeof privacyRpc.input>, context: PluginHandlerContext) {
  const project = await ensureProject(input, context);
  return updateState((state) => {
    const stored = state.projects.find((item) => item.id === project.id)!;
    stored.privacy = input.privacy;
    return projectSummary(state, stored, input.workspaceId);
  });
}

export async function recordEvidence(input: ZodOutput<typeof evidenceRpc.input>, context: PluginHandlerContext) {
  const project = await ensureProject(input, context);
  return updateState((state) => {
    const node = state.nodes.find((item) => item.id === input.nodeId);
    if (!node) throw new Error("Unknown knowledge node");
    if (!project.technologies.some((item) => item.id === node.techId)) throw new Error("Knowledge node does not belong to this workspace");
    const createdAt = Date.now();
    const id = evidenceKey(input.nodeId, input.kind as EvidenceKind, input.reference, createdAt);
    if (!state.evidence.some((item) => item.id === id)) {
      state.evidence.push({ id, nodeId: input.nodeId, projectId: project.id, kind: input.kind as EvidenceKind, reference: input.reference, createdAt });
    }
    return masteryForNode(state, input.nodeId);
  });
}

function wikiBody(technology: StoredTechnology, nodes: StoredNode[]): string {
  const sections = nodes.map((node) => `## ${node.title}\n\n${node.summary}\n\n### Review checklist\n\n- Explain the main abstraction in your own words.\n- Locate its configuration and boundaries in the current workspace.\n- Identify one failure mode and one test that catches it.\n`).join("\n");
  return `# ${technology.name}\n\n> Rumen local knowledge guide. Verify version-specific details against official documentation before making production decisions.\n\n## Why it matters here\n\nThis workspace contains ${technology.evidence.length} local evidence anchor${technology.evidence.length === 1 ? "" : "s"} for ${technology.name}. The guide focuses on understanding the code you and your agents are changing.\n\n${sections}`;
}

export async function getWiki(input: ZodOutput<typeof wikiRpc.input>, context: PluginHandlerContext) {
  const project = await ensureProject(input, context);
  return updateState((state) => {
    const technology = project.technologies.find((item) => item.id === input.techId);
    if (!technology) throw new Error("Technology is not present in this workspace");
    let wiki = state.wikis.find((item) => item.projectId === project.id && item.techId === technology.id);
    if (!wiki || input.force) {
      const nodes = state.nodes.filter((node) => node.techId === technology.id);
      wiki = {
        projectId: project.id,
        techId: technology.id,
        title: technology.name,
        body: wikiBody(technology, nodes),
        generatedAt: Date.now(),
        sourceCount: 0,
        sourcedRatio: 0,
      };
      state.wikis = [...state.wikis.filter((item) => item.projectId !== project.id || item.techId !== technology.id), wiki];
    }
    return { ...wiki, anchors: technology.evidence };
  });
}

function questionFor(node: StoredNode): StoredQuestion {
  return {
    id: `quiz:${stableHash(`${node.id}:${node.title}`)}`,
    techId: node.techId,
    nodeId: node.id,
    prompt: `In your own words, explain ${node.title}. Mention at least two important ideas and one practical check you would make in this workspace.`,
    keywords: node.keywords,
    createdAt: Date.now(),
    passed: false,
    attempts: 0,
  };
}

export async function nextQuiz(input: ZodOutput<typeof quizNextRpc.input>, context: PluginHandlerContext) {
  const project = await ensureProject(input, context);
  return updateState((state) => {
    if (!project.technologies.some((item) => item.id === input.techId)) throw new Error("Technology is not present in this workspace");
    const candidates = state.nodes.filter((node) => node.techId === input.techId).sort((left, right) => masteryForNode(state, left.id).score - masteryForNode(state, right.id).score);
    const node = candidates.find((item) => !state.questions.find((question) => question.nodeId === item.id)?.passed) ?? candidates[0];
    if (!node) throw new Error("This technology has no knowledge nodes");
    let question = state.questions.find((item) => item.nodeId === node.id && !item.passed);
    if (!question) {
      question = questionFor(node);
      state.questions.push(question);
    }
    return { id: question.id, techId: question.techId, nodeId: question.nodeId, nodeTitle: node.title, prompt: question.prompt };
  });
}

export async function answerQuiz(input: ZodOutput<typeof quizAnswerRpc.input>, context: PluginHandlerContext) {
  const project = await ensureProject(input, context);
  return updateState((state) => {
    const question = state.questions.find((item) => item.id === input.questionId);
    if (!question) throw new Error("Unknown quiz question");
    if (!project.technologies.some((item) => item.id === question.techId)) throw new Error("Quiz does not belong to this workspace");
    const normalized = input.answer.toLowerCase();
    const matched = question.keywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
    const depthBonus = Math.min(0.35, normalized.split(/\s+/).filter(Boolean).length / 120);
    const score = Math.min(1, matched.length / Math.max(2, question.keywords.length) + depthBonus);
    const passed = score >= 0.7;
    question.attempts += 1;
    question.passed ||= passed;
    if (passed) {
      const createdAt = Date.now();
      const id = evidenceKey(question.nodeId, "quiz_passed", question.id, createdAt);
      if (!state.evidence.some((item) => item.id === id)) state.evidence.push({ id, nodeId: question.nodeId, projectId: project.id, kind: "quiz_passed", reference: question.id, createdAt });
    }
    return {
      passed,
      score: Math.round(score * 100) / 100,
      feedback: passed ? "Passed. The answer covered enough of the node's core vocabulary and included useful detail." : `Not yet. Expand the answer with concrete details about ${question.keywords.slice(0, 3).join(", ")}.`,
      mastery: masteryForNode(state, question.nodeId),
    };
  });
}

export async function listCommits(input: ZodOutput<typeof commitsRpc.input>, context: PluginHandlerContext) {
  const project = await ensureProject(input, context);
  return { commits: await analyzeCommits(project, await readState(), input.limit) };
}

interface ObservedMutation { callId: string; filePath: string; timestamp: number }

function mutationFromTool(item: unknown, timestamp: unknown): ObservedMutation | null {
  const value = record(item);
  if (!value || value.type !== "tool_call" || value.status !== "completed") return null;
  const detail = record(value.detail);
  if (!detail || (detail.type !== "edit" && detail.type !== "write")) return null;
  const filePath = text(detail.filePath);
  const callId = text(value.callId);
  if (!filePath || !callId) return null;
  const observedAt = typeof timestamp === "string" || typeof timestamp === "number" ? new Date(timestamp).getTime() : Number.NaN;
  return { callId, filePath, timestamp: Number.isFinite(observedAt) ? observedAt : Date.now() };
}

export async function getAgentImpact(input: ZodOutput<typeof agentImpactRpc.input>, context: PluginHandlerContext): Promise<AgentImpact> {
  const project = await ensureProject(input, context);
  const page = await context.paseo.agents.ref(input.agentId).timeline.refetch({ direction: "tail", limit: 300, projection: "canonical" });
  if (page.agent?.id !== input.agentId || page.agent.workspaceId !== input.workspaceId) throw new Error("Agent does not belong to the selected workspace");
  const files = new Set<string>();
  const mutations: Array<ObservedMutation & { relativePath: string }> = [];
  for (const entry of page.entries) {
    const mutation = mutationFromTool(entry.item, entry.timestamp);
    if (!mutation) continue;
    const absolute = mutation.filePath.startsWith(sep) ? resolve(mutation.filePath) : resolve(project.root, mutation.filePath);
    const relativePath = relative(project.root, absolute);
    if (relativePath.startsWith("..") || relativePath.startsWith(sep)) continue;
    files.add(relativePath);
    mutations.push({ ...mutation, relativePath });
  }
  const state = await readState();
  const technologies = project.technologies.map((item) => publicTechnology(state, item));
  const touched = technologies.filter((technology) => technology.evidence.some((anchor) => files.has(anchor.file)));
  const weakNodes = touched.flatMap((technology) => technology.nodes).filter((node) => !node.mastery.grasped).slice(0, 30);
  if (weakNodes.length && mutations.length) {
    await updateState((current) => {
      for (const node of weakNodes) {
        const technology = project.technologies.find((item) => item.id === node.techId);
        const relevant = mutations.filter((mutation) => technology?.evidence.some((anchor) => anchor.file === mutation.relativePath));
        for (const mutation of relevant) {
          const reference = `agent:${input.agentId}:call:${mutation.callId}`;
          const id = evidenceKey(node.id, "agent_wrote_unreviewed", reference, mutation.timestamp);
          if (!current.evidence.some((item) => item.id === id)) current.evidence.push({ id, nodeId: node.id, projectId: project.id, kind: "agent_wrote_unreviewed", reference, createdAt: mutation.timestamp });
        }
      }
    });
  }
  const refreshed = await readState();
  const finalWeak = weakNodes.map((node) => publicNode(refreshed, refreshed.nodes.find((item) => item.id === node.id)!));
  return {
    agentId: input.agentId,
    projectName: project.name,
    active: page.agent?.status === "running",
    touchedFiles: [...files].slice(-80),
    touchedTechs: touched.map((technology) => technology.name),
    weakNodes: finalWeak,
    newKnowledge: touched.filter((technology) => technology.mastery.score === 0).map((technology) => technology.name),
    totalDebt: finalWeak.reduce((sum, node) => sum + node.mastery.debt, 0),
  };
}

export async function overview(_input: ZodOutput<typeof overviewRpc.input>) {
  const state = await readState();
  const allNodes = state.nodes.map((node) => publicNode(state, node));
  const uniqueTech = new Set(state.projects.flatMap((project) => project.technologies.map((technology) => technology.id)));
  return {
    projects: state.projects.map((project) => projectSummary(state, project)),
    totalTechnologies: uniqueTech.size,
    totalNodes: allNodes.length,
    graspedNodes: allNodes.filter((node) => node.mastery.grasped).length,
    totalDebt: allNodes.reduce((sum, node) => sum + node.mastery.debt, 0),
  };
}

export async function exportKnowledge(_input: ZodOutput<typeof exportRpc.input>) {
  const state = await readState();
  const directory = join(dataDirectory(), "export");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const records: unknown[] = [];
  for (const node of state.nodes) records.push({ type: "node", ...node, mastery: masteryForNode(state, node.id) });
  for (const evidence of state.evidence) records.push({ type: "evidence", id: evidence.id, nodeId: evidence.nodeId, project: evidence.projectId ? stableHash(evidence.projectId) : null, kind: evidence.kind, createdAt: evidence.createdAt });
  for (const wiki of state.wikis) records.push({ type: "wiki", project: stableHash(wiki.projectId), techId: wiki.techId, title: wiki.title, body: wiki.body, generatedAt: wiki.generatedAt, sourceCount: wiki.sourceCount, sourcedRatio: wiki.sourcedRatio });
  records.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const path = join(directory, "rumen.jsonl");
  await writeFile(path, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return { path, records: records.length };
}

export async function searchAttachments(input: ZodOutput<typeof attachmentSearchRpc.input>) {
  const state = await readState();
  const query = input.query.trim().toLowerCase();
  const items: Array<{ id: string; identifier: string; title: string; subtitle?: string; url: string; text: string; resourceType: string }> = [];
  for (const node of state.nodes) {
    const technology = state.projects.flatMap((project) => project.technologies).find((item) => item.id === node.techId);
    const haystack = `${technology?.name ?? ""} ${node.title} ${node.summary}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;
    const mastery = masteryForNode(state, node.id);
    items.push({
      id: node.id,
      identifier: node.id,
      title: node.title,
      subtitle: `${technology?.name ?? node.techId} · mastery ${Math.round(mastery.score)} · debt ${mastery.debt}`,
      url: `rumen://knowledge/${encodeURIComponent(node.id)}`,
      text: `# ${node.title}\n\n${node.summary}\n\nCurrent mastery: ${Math.round(mastery.score)}/100; confidence ${Math.round(mastery.confidence * 100)}%; knowledge debt ${mastery.debt}.\n\nUse this as learning context. Do not claim the user understands concepts without positive evidence.`,
      resourceType: "rumen-knowledge",
    });
    if (items.length >= 50) break;
  }
  return { items };
}
