import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 运行时可移植性。
 *
 * ═══════════════════════════════════════════════════════════════════
 * ⭐ **客户端代码要在两个完全不同的 JS 运行时里跑：**
 *
 * | 端 | 运行时 | Intl |
 * |---|---|---|
 * | web / 桌面 | 浏览器 + react-native-web | 有 |
 * | iOS / 安卓 app | **Hermes** | **常常没有** |
 *
 * 实测代价（2026-09-05）：`ui/ui.client.tsx` 里一句 `React.useMemo` 被 esbuild
 * 编成 `import_react.default.useMemo` —— 依赖 `__toESM` interop 合成出来的
 * `.default`。web 端完全正常，安卓上 **`useLocale` 被每个界面调用**，于是一屏
 * 里好几条：
 *
 * ```
 * Plugin failed: Object is not a function
 * ```
 *
 * 这类问题的恶劣之处在于**本机怎么测都是绿的**，而且宿主的
 * `SurfaceErrorBoundary` 把详细信息扔进了 app 里的 `console.warn`，
 * daemon 日志（只有服务端那半边）看不到。
 *
 * 确实需要用的地方（比如语言探测的兜底）在行尾标 `hermes-ok:` 说明理由。
 * ═══════════════════════════════════════════════════════════════════
 */

const ROOT = join(import.meta.dirname, "..");

function shippedFiles(): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [["index.ts", readFileSync(join(ROOT, "index.ts"), "utf8")]];
  for (const dir of ["domain", "ui"]) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (!/\.(ts|tsx)$/.test(name)) continue;
      // .server.ts 只在 daemon 里跑（Node），不受 Hermes 约束
      if (name.endsWith(".server.ts")) continue;
      out.push([`${dir}/${name}`, readFileSync(join(ROOT, dir, name), "utf8")] as const);
    }
  }
  return out;
}

/** 剥掉注释 —— 这些 API 的名字在解释「为什么不能用」的注释里必然出现。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const BANNED: Array<readonly [RegExp, string]> = [
  [/\.toLocaleString\s*\(/, "Hermes（安卓）没有 Intl；手写格式化"],
  [/\.toLocaleDateString\s*\(/, "同上"],
  [/\.toLocaleTimeString\s*\(/, "同上"],
  [/\bIntl\s*\./, "Hermes 上 Intl 可能整个不存在"],
  [/\bnew\s+Intl\b/, "Hermes 上 Intl 可能整个不存在"],
  [/\.localeCompare\s*\(/, "排序改用普通比较"],
  [/\bReflect\.ownKeys\s*\(/, "裁剪运行时上不一定有"],
];

test("⭐ 客户端代码里不出现 Intl 家族 API", () => {
  const offenders: string[] = [];
  for (const [name, source] of shippedFiles()) {
    stripComments(source).split("\n").forEach((line, index) => {
      if (line.includes("hermes-ok:")) return;
      for (const [pattern, why] of BANNED) {
        if (pattern.test(line)) offenders.push(`${name}:${index + 1}  ${line.trim()}\n    → ${why}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `\n${offenders.join("\n")}\n`);
});

test("豁免必须写理由", () => {
  const bare = shippedFiles()
    .flatMap(([name, source]) => source.split("\n").map((line, index) => [name, index + 1, line] as const))
    .filter(([, , line]) => /hermes-ok:\s*$/.test(line))
    .map(([name, line]) => `${name}:${line}`);
  assert.deepEqual(bare, [], "hermes-ok: 后面要写清为什么这里安全");
});

test("⭐ 不用 React.xxx 运行时用法，一律具名导入", () => {
  // esbuild 把 `React.useMemo` / `React.Component` 编成
  // `import_react.default.xxx`，依赖 `__toESM` 合成出来的 `.default`。
  // 宿主在 web 与原生两端各自提供 react 模块，两边 interop 形状不保证一样。
  //
  // ⚠️ 表现是 `Plugin failed: Object is not a function`，
  // 从报错完全看不出跟 import 有关 —— 2026-09-05 为此排查了大半天。
  //
  // 类型位置（React.ReactNode 之类）会被 tsc 擦掉，不进运行时，放行。
  const offenders: string[] = [];
  for (const [name, source] of shippedFiles()) {
    for (const match of stripComments(source).matchAll(/\bReact\.(\w+)/g)) {
      const member = match[1]!;
      const isTypeOnly = /^[A-Z]/.test(member) && !/^(Component|PureComponent|Fragment|StrictMode|createElement|cloneElement|memo|forwardRef)$/.test(member);
      if (isTypeOnly) continue;
      offenders.push(`${name}: React.${member}`);
    }
  }
  assert.deepEqual(offenders, [], '改成具名导入，如 import { useMemo } from "react"');
});
