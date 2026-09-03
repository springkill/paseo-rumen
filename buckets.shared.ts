/**
 * 状态桶与身份色。
 *
 * 两套颜色必须正交，加上掌握度热力一共三套：
 *
 * ```
 * 身份色  → 低彩度、等亮度、无语义   （只回答"这是哪个项目"）
 * 状态色  → 高彩度、少数几个        （只回答"现在什么状况"）
 * 掌握度  → 单色相顺序标度          （只回答"学到什么程度"）
 * ```
 *
 * 一个像素上同时出现三套色时，状态色永远在最上层 —— 它是唯一需要被抢先看到的。
 */

import type { PluginTheme } from "@getpaseo/plugin";
import type { Translator } from "./i18n.shared";

/**
 * 状态桶。前五个来自 Paseo，`new_knowledge` 是 Rumen 加的。
 *
 * `new_knowledge` 是**本产品唯一有资格打断你的信号** —— 它排在 `failed` 之上
 * 是刻意的：分析失败可以稍后再看，学习时机错过就没了。
 */
export type StatusBucket =
  | "needs_input"
  | "new_knowledge"
  | "failed"
  | "running"
  | "attention"
  | "done";

/**
 * 折叠优先级：把一个项目下的多个会话收成一个徽标时用这个。
 *
 * ⚠️ **故意不等于平铺排序**（见 {@link FLAT_ORDER}）。这是 Paseo 用注释标出来的坑，
 * 照搬：折叠成一行时你希望**正在干活的项目继续显示 loader**，所以 running 要压过
 * attention；而平铺列表里 attention 该排在 running 之上。两套顺序必须分开定义，
 * 不能共用一个常量。
 */
export const COLLAPSE_ORDER: readonly StatusBucket[] = [
  "needs_input",
  "new_knowledge",
  "failed",
  "running",
  "attention",
  "done",
];

/** 平铺列表的排序。注意 `attention` 在 `running` 之上 —— 与折叠顺序不同。 */
export const FLAT_ORDER: readonly StatusBucket[] = [
  "needs_input",
  "new_knowledge",
  "failed",
  "attention",
  "running",
  "done",
];

const COLLAPSE_RANK = new Map(COLLAPSE_ORDER.map((bucket, index) => [bucket, index]));
const FLAT_RANK = new Map(FLAT_ORDER.map((bucket, index) => [bucket, index]));

/** 折叠一组桶成一个。空集合是 `done`。 */
export function collapse(buckets: Iterable<StatusBucket>): StatusBucket {
  let winner: StatusBucket = "done";
  let best = COLLAPSE_ORDER.length;
  for (const bucket of buckets) {
    const rank = COLLAPSE_RANK.get(bucket) ?? COLLAPSE_ORDER.length;
    if (rank < best) {
      best = rank;
      winner = bucket;
    }
  }
  return winner;
}

/** 平铺列表用的排序键。 */
export function flatRank(bucket: StatusBucket): number {
  return FLAT_RANK.get(bucket) ?? FLAT_ORDER.length;
}

export interface BucketStyle {
  /** 点/字形的颜色。`null` 表示不画点。 */
  readonly color: string | null;
  /**
   * ⭐ 画告警字形而不是裸点。
   *
   * `needs_input` 与 `running` 同为 amber —— 它们不冲突，因为 `needs_input`
   * **永远画告警字形，从不画裸点**。这是 Paseo 的规则，照搬。
   */
  readonly glyph: "dot" | "alert" | "spark" | "loader" | "none";
  /** 允许动效。只有这两个桶有资格抢注意力，其余全静默。 */
  readonly animate: boolean;
}

export function bucketStyle(bucket: StatusBucket, theme: PluginTheme): BucketStyle {
  switch (bucket) {
    case "needs_input":
      return { color: theme.colors.statusWarning, glyph: "alert", animate: true };
    case "new_knowledge":
      return { color: theme.colors.statusWarning, glyph: "spark", animate: true };
    case "failed":
      return { color: theme.colors.statusDanger, glyph: "dot", animate: false };
    case "running":
      return { color: theme.colors.statusWarning, glyph: "loader", animate: false };
    case "attention":
      return { color: theme.colors.statusSuccess, glyph: "dot", animate: false };
    case "done":
      return { color: null, glyph: "none", animate: false };
  }
}

export function bucketLabel(bucket: StatusBucket, t: Translator): string {
  switch (bucket) {
    case "needs_input":
      return t.bucket_needs_input;
    case "new_knowledge":
      return t.bucket_new_knowledge;
    case "failed":
      return t.bucket_failed;
    case "running":
      return t.bucket_running;
    case "attention":
      return t.bucket_attention;
    case "done":
      return t.bucket_done;
  }
}

/**
 * 身份色 —— 只回答"这是哪个项目"。
 *
 * 两条性质比具体色相重要：
 *
 * 1. **低彩度**。这些方块在侧栏里紧挨着一个状态点和一个统计数字，
 *    满饱和度下项目图标会赢下一场它不该参加的战斗。
 * 2. **等亮度**。全部压在对白字 4.2–4.8:1 的同一条对比带内。
 *    用裸 Tailwind-500 时跨度是 1.9:1 到 4.5:1，**结果是"项目的颜色决定了它有多吵"**。
 *    压到同一条带后，颜色变成标识而不是排序。
 *
 * ⚠️ **数组顺序是承重的**：索引是 `hash(key) % 10`，
 * **重排数组会静默改掉所有已有项目的颜色**。调色要按对比带调，不要凭眼睛调 ——
 * 为好看挪一个色相会悄悄重新加权它相对另外九个的分量。
 */
export const IDENTITY_COLORS: readonly string[] = [
  "#7a6aa8", // violet
  "#3d7ea6", // sky
  "#388068", // emerald
  "#a4673a", // orange
  "#b05c80", // pink
  "#6a70b8", // indigo
  "#368080", // teal
  "#b06260", // red
  "#8f7838", // amber
  "#5179b0", // blue
];

/** 稳定的 FNV-1a，跨进程跨重启同一个 key 得同一个颜色。 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function identityColor(key: string): string {
  return IDENTITY_COLORS[fnv1a(key) % IDENTITY_COLORS.length]!;
}

/**
 * 掌握度热力 —— 单色相顺序标度，只回答"学到什么程度"。
 *
 * 刻意**不**用红/黄/绿：那是状态色的语义，掌握度低不是"出错了"。
 */
export function masteryColor(score: number, theme: PluginTheme): string {
  if (score >= 60) return theme.colors.statusSuccess;
  if (score >= 30) return theme.colors.accent;
  return theme.colors.foregroundMuted;
}
