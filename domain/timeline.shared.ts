import { TimelineImpactSchema, type TimelineImpact } from "./contracts.shared";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const MANIFEST =
  /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|gemfile|composer\.json|dockerfile(?:\.[^/]*)?|docker-compose[^/]*\.ya?ml|[^/]+\.tf)$/i;

const SOURCE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|kts|rb|php|exs?|cs|swift|scala)$/i;

/**
 * 只认**已完成的写类工具**。
 *
 * 进行中的不算 —— agent 可能改到一半被打断，那不是一次改动；
 * 卡片提前出现之后又没有对应的结果，比不出现更让人困惑。
 */
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
  // 源码里只认真正的代码文件。改 README 不是知识点触碰
  if (signal === "source" && !SOURCE.test(target)) return null;

  const parsed = TimelineImpactSchema.safeParse({
    tool: name,
    target: target.slice(0, 4096),
    signal,
  });
  return parsed.success ? parsed.data : null;
}
