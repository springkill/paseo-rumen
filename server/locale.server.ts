/**
 * 共享语言设置的读写。
 *
 * 三个插件（paseo-rumen / paseo-pi-todos / paseo-provider-balances）读写
 * **同一个文件**，所以在任何一个里改语言，另外两个下次渲染就跟上。
 *
 * ```
 * $PASEO_HOME/plugin-locale.json      // { "locale": "auto" | "zh" | "en" }
 * ```
 *
 * 文件不存在 / 读不动 / 格式坏 —— 一律当 `auto`，不抛错。语言设置读不到的
 * 后果只是显示成英文，为这个把插件搞崩不值得。**写**失败才需要让用户知道。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LocalePreference } from "../domain/locale.shared";

export function sharedLocalePath(): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-locale.json");
}

export async function readSharedLocale(): Promise<LocalePreference> {
  try {
    const raw = await readFile(sharedLocalePath(), "utf8");
    const value = (JSON.parse(raw) as { locale?: unknown }).locale;
    if (value === "zh" || value === "en" || value === "auto") return value;
  } catch {
    // 没有文件、读不动、格式坏 —— 都当没设过
  }
  return "auto";
}

export async function writeSharedLocale(locale: LocalePreference): Promise<void> {
  const path = sharedLocalePath();
  await mkdir(dirname(path), { recursive: true });
  // 临时文件 + rename：另一个插件正在读的时候不会读到半个文件
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ locale }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

/**
 * 内存缓存的共享语言偏好。
 *
 * `localeOf` 有 14 个同步调用点，把它们全改成异步不值得。改成：入口处
 * `refreshSharedLocale()` 刷一次缓存，判定仍然同步。代价是别的插件刚改完语言时，
 * 本插件的当前这一次请求可能还用旧值 —— 下一次就对了，而语言这种东西
 * 慢一拍没有后果。
 */
let cached: LocalePreference = "auto";

export function sharedLocalePreference(): LocalePreference {
  return cached;
}

export async function refreshSharedLocale(): Promise<LocalePreference> {
  cached = await readSharedLocale();
  return cached;
}

export async function setSharedLocale(preference: LocalePreference): Promise<void> {
  cached = preference;
  await writeSharedLocale(preference);
}
