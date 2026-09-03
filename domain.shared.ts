export type Privacy = "public" | "private" | "airgapped";
export type EvidenceKind =
  | "agent_wrote_unreviewed"
  | "agent_wrote_reviewed"
  | "human_wrote"
  | "wiki_read"
  | "quiz_passed"
  | "debugged";

export interface EvidenceInput {
  kind: EvidenceKind;
  createdAt: number;
}

const WEIGHTS: Record<EvidenceKind, number> = {
  agent_wrote_unreviewed: 0,
  agent_wrote_reviewed: 0.4,
  human_wrote: 1,
  wiki_read: 0.3,
  quiz_passed: 1.5,
  debugged: 1.2,
};

export function masteryOf(evidence: EvidenceInput[], now = Date.now()) {
  let sum = 0;
  let debt = 0;
  const positiveKinds = new Set<EvidenceKind>();
  for (const item of evidence) {
    if (item.kind === "agent_wrote_unreviewed") {
      debt += 1;
      continue;
    }
    const ageDays = Math.max(0, now - item.createdAt) / 86_400_000;
    const effective = WEIGHTS[item.kind] * Math.exp(-ageDays / 180);
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
    grasped: score >= 60 && confidence >= 0.5,
  };
}

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
  return value.replace(/:\d+\//, "/").replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
}

export function projectIdentity(input: { remote?: string | null; firstCommit?: string | null; path: string }) {
  if (input.remote?.trim()) return `git:${normalizeRemote(input.remote)}`;
  if (input.firstCommit?.trim()) return `root:${input.firstCommit.trim().toLowerCase()}`;
  return `path:${input.path}`;
}

export function confidenceForLayers(maxConfidence: number, distinctLayers: number): number {
  return Math.min(0.99, maxConfidence + 0.5 * (1 - maxConfidence) * Math.max(0, distinctLayers - 1));
}

export function evidenceKey(nodeId: string, kind: EvidenceKind, reference: string | undefined, createdAt: number): string {
  const day = new Date(createdAt).toISOString().slice(0, 10);
  return stableHash(`${nodeId}\0${kind}\0${reference ?? ""}\0${day}`);
}
