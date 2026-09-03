import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EvidenceKind, Privacy } from "./domain.shared";

export interface StoredAnchor {
  file: string;
  line: number;
  snippet: string;
  layer: "manifest" | "config" | "source";
}

export interface StoredTechnology {
  id: string;
  name: string;
  category: string;
  version: string | null;
  confidence: number;
  worthLearning: boolean | null;
  curated: boolean;
  evidence: StoredAnchor[];
}

export interface StoredProject {
  id: string;
  workspaceIds: string[];
  name: string;
  root: string;
  privacy: Privacy;
  lastScanAt: number | null;
  truncated: boolean;
  technologies: StoredTechnology[];
}

export interface StoredNode {
  id: string;
  techId: string;
  title: string;
  summary: string;
  difficulty: number;
  prerequisites: string[];
  keywords: string[];
}

export interface StoredEvidence {
  id: string;
  nodeId: string;
  projectId: string | null;
  kind: EvidenceKind;
  reference?: string;
  createdAt: number;
}

export interface StoredWiki {
  projectId: string;
  techId: string;
  title: string;
  body: string;
  generatedAt: number;
  sourceCount: number;
  sourcedRatio: number;
}

export interface StoredQuestion {
  id: string;
  techId: string;
  nodeId: string;
  prompt: string;
  keywords: string[];
  createdAt: number;
  passed: boolean;
  attempts: number;
}

export interface RumenState {
  version: 1;
  projects: StoredProject[];
  nodes: StoredNode[];
  evidence: StoredEvidence[];
  wikis: StoredWiki[];
  questions: StoredQuestion[];
}

const EMPTY: RumenState = {
  version: 1,
  projects: [],
  nodes: [],
  evidence: [],
  wikis: [],
  questions: [],
};

export function dataDirectory(): string {
  return process.env.RUMEN_DATA_DIR
    ?? join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "paseo-rumen");
}

export function statePath(): string {
  return join(dataDirectory(), "state.json");
}

let cached: RumenState | null = null;
let queue: Promise<unknown> = Promise.resolve();

function normalize(value: unknown): RumenState {
  if (!value || typeof value !== "object") return structuredClone(EMPTY);
  const candidate = value as Partial<RumenState>;
  if (candidate.version !== 1) return structuredClone(EMPTY);
  return {
    version: 1,
    projects: Array.isArray(candidate.projects) ? candidate.projects : [],
    nodes: Array.isArray(candidate.nodes) ? candidate.nodes : [],
    evidence: Array.isArray(candidate.evidence) ? candidate.evidence : [],
    wikis: Array.isArray(candidate.wikis) ? candidate.wikis : [],
    questions: Array.isArray(candidate.questions) ? candidate.questions : [],
  };
}

async function loadUnqueued(): Promise<RumenState> {
  if (cached) return cached;
  let raw: string;
  try {
    raw = await readFile(statePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      cached = structuredClone(EMPTY);
      return cached;
    }
    console.error("[rumen] state is unreadable; refusing to replace it", error);
    throw new Error(`Rumen state is unreadable at ${statePath()}; fix permissions or restore the file before writing`);
  }
  try {
    cached = normalize(JSON.parse(raw));
    return cached;
  } catch (error) {
    const quarantine = `${statePath()}.corrupt-${Date.now()}`;
    await writeFile(quarantine, raw, { encoding: "utf8", mode: 0o600 }).catch(() => {});
    console.error(`[rumen] state is malformed; preserved a recovery copy at ${quarantine}`, error);
    throw new Error(`Rumen state is malformed at ${statePath()}; it was not overwritten`);
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
  const state = await loadUnqueued();
  return structuredClone(state);
}

export async function updateState<T>(mutator: (state: RumenState) => T | Promise<T>): Promise<T> {
  const operation = queue.then(async () => {
    const state = await loadUnqueued();
    const result = await mutator(state);
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
