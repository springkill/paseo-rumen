import { TimelineImpactSchema, type TimelineImpact } from "./contracts.shared";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }

const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|cargo\.toml|go\.mod|pom\.xml|gemfile|composer\.json|dockerfile(?:\.[^/]*)?|docker-compose[^/]*\.ya?ml|[^/]+\.tf)$/i;

export function parseTimelineImpact(value: unknown): TimelineImpact | null {
  const item = record(value);
  if (!item || item.type !== "tool_call" || item.status !== "completed") return null;
  const name = text(item.name);
  if (!name) return null;
  const detail = record(item.detail);
  if (!detail || (detail.type !== "edit" && detail.type !== "write")) return null;
  const target = text(detail.filePath);
  if (!target) return null;
  const signal = MANIFEST.test(target) ? "manifest" : "source";
  if (signal === "source" && !/\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|rb|php|exs?)$/i.test(target)) return null;
  const candidate = { tool: name, target: target.slice(0, 4096), signal, label: signal === "manifest" ? "Dependency or infrastructure change" : "Code knowledge touch" };
  const parsed = TimelineImpactSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
