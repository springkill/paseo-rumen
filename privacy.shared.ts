/**
 * 三级项目隐私，以及送去 agent 之前的强制过滤。
 *
 * | 级别 | 允许出本机的内容 | 联网 |
 * |---|---|---|
 * | `public` | 代码片段可作为 prompt 上下文；可抓上游文档 | 全开 |
 * | `private`（默认） | **仅**技术栈名、依赖名、抽象化的问题描述；**不发代码原文、不发文件路径** | 仅检索通用技术资料 |
 * | `airgapped` | 无 | 完全离线，只用已缓存的内容 |
 *
 * ⭐ 这一层不是"提醒开发者注意"，是**在组装 prompt 的路径上强制拦截**：
 * {@link assertNoProjectLeak} 检出泄漏就抛错，宁可这次生成失败。
 * 一个把用户私有代码发出去的 bug，没有"下次注意"这个选项。
 */

import type { Privacy } from "./domain.shared";

/** 这个隐私级别允不允许调 agent。 */
export function allowsGeneration(privacy: Privacy): boolean {
  return privacy !== "airgapped";
}

/** 这个隐私级别允不允许把项目代码交给 agent。 */
export function allowsProjectCode(privacy: Privacy): boolean {
  return privacy === "public";
}

export class PrivacyLeakError extends Error {
  constructor(readonly kind: "absolute_path" | "code_body", readonly sample: string) {
    super(`Prompt would leak ${kind} for a non-public project: ${sample}`);
    this.name = "PrivacyLeakError";
  }
}

/**
 * 组装 prompt 的最后一道闸。
 *
 * 只对**非 public** 项目生效。检两样：
 *
 * 1. **绝对路径**。`/home/alice/work/acme-billing` 这种东西本身就是情报 ——
 *    公司名、项目名、目录结构全在里面。
 * 2. **代码正文**。围栏代码块、以及连续多行看起来像代码的文本。
 *
 * `roots` 传项目根路径，用来生成更精准的匹配（相对路径是允许的，绝对路径不是）。
 */
export function assertNoProjectLeak(
  prompt: string,
  privacy: Privacy,
  roots: readonly string[] = [],
  /**
   * 明确允许出现的路径 —— Rumen 自己的落盘位置。
   *
   * 这条口子必须是**显式传入的白名单**，不能放宽正则：放宽了就等于给
   * "某个 /home/... 路径"开了后门，而项目路径正是长这样。
   */
  allow: readonly string[] = [],
): void {
  if (privacy === "public") return;

  for (const root of roots) {
    if (root && prompt.includes(root)) {
      throw new PrivacyLeakError("absolute_path", root);
    }
  }
  const allowed = (path: string) => allow.some((item) => item && path.startsWith(item));
  // POSIX 绝对路径：至少两段，且不是常见的公共路径（技术文档里会提到 /etc/nginx 之类）
  const PUBLIC_PREFIXES = ["/etc/", "/usr/", "/var/log/", "/proc/", "/dev/", "/tmp/"];
  const absolute = prompt.match(/(?:^|[\s"'`(])(\/(?:[A-Za-z0-9._-]+\/){1,}[A-Za-z0-9._-]+)/g);
  if (absolute) {
    for (const raw of absolute) {
      const path = raw.trim().replace(/^["'`(]/, "");
      if (PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
      if (allowed(path)) continue;
      throw new PrivacyLeakError("absolute_path", path);
    }
  }
  // Windows 绝对路径
  const windows = prompt.match(/[A-Za-z]:\\[A-Za-z0-9._\\-]+/);
  if (windows) throw new PrivacyLeakError("absolute_path", windows[0]);

  // 围栏代码块 = 代码正文
  const fenced = prompt.match(/```[\s\S]*?```/);
  if (fenced) throw new PrivacyLeakError("code_body", fenced[0].slice(0, 60));
}

/**
 * 把一段本地文本改造成可以外发的形式：剥掉路径、只留文件名。
 *
 * 用在"抽象化的问题描述"上 —— private 项目允许说"用到了 Redis 的连接池"，
 * 不允许说"在 /home/alice/acme/src/db/pool.ts:42 用到了"。
 */
export function stripPaths(text: string): string {
  return text
    .replace(/(?:^|(?<=[\s"'`(]))\/(?:[A-Za-z0-9._-]+\/)+([A-Za-z0-9._-]+)/g, "$1")
    .replace(/[A-Za-z]:\\(?:[A-Za-z0-9._-]+\\)+([A-Za-z0-9._-]+)/g, "$1");
}
