/**
 * 哪些目录不能当项目扫。
 *
 * 单独成一个模块是为了让扫描器和存储迁移共用同一份判据 —— 两处各写一份的话
 * 迟早会分叉，然后出现"迁移留下来的项目扫不动"这种自相矛盾的状态。
 */

import { homedir } from "node:os";
import { parse as parsePath } from "node:path";

/**
 * 家目录和文件系统根**永远不扫**。
 *
 * 它们不是项目，扫出来的东西对谁都没有意义。这条护栏是实机事故的直接产物：
 * 家目录被当成 workspace 打开过一次，产出 2293 个「技术栈」和 7.8MB 状态文件。
 */
export function forbiddenRoot(path: string): boolean {
  const canonical = path.replace(/\/+$/, "") || "/";
  if (canonical === parsePath(canonical).root) return true;
  if (canonical === homedir().replace(/\/+$/, "")) return true;
  return ["/home", "/Users", "/root", "/tmp", "/var", "/usr", "/etc", "/opt", "/mnt", "/srv"]
    .includes(canonical);
}
