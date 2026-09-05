import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import React from "react";

/**
 * 界面**真的渲染得出来**吗。
 *
 * ═══════════════════════════════════════════════════════════════════
 * ## 为什么需要这条
 *
 * typecheck 绿、单测全绿、web 端完全正常，安卓上却是：
 *
 * ```
 * Plugin failed: Object is not a function
 * ```
 *
 * 因为安卓的 Paseo 跑 **Hermes**，与 web 的 react-native-web 不是一个运行时。
 * 而宿主的 `SurfaceErrorBoundary` 把详细信息扔进 app 里的 `console.warn`，
 * daemon 日志（只有服务端那半边）什么都看不到 —— 隔着设备边界无从下手。
 *
 * ## 做法
 *
 * 用 Paseo 自己的编译器编出 client bundle → 喂桩模块 evaluate →
 * 把每个界面的组件树**递归调用一遍**。
 *
 * ⭐ 三个关键细节，做错就什么都验不到：
 *
 * 1. `react-native` 的图元要桩成**字符串宿主组件**，不能桩成返回 null 的函数 ——
 *    后者会让遍历在第一个 `<View>` 就停住。
 * 2. `@getpaseo/plugin` 要照抄**宿主**那张表，不是 npm 包的导出 ——
 *    `Icon` 只在宿主注入里有，照 npm 包桩的话每个用 Icon 的界面都会误报。
 * 3. 要跑一遍 **Hermes 裁剪模式**（Intl / toLocaleString 换成抛异常的桩）。
 *    正常模式下这类 bug 是**测不出来**的。
 *
 * ⚠️ 依赖全局装的 @getpaseo/cli 编译器，**CI 上会跳过**。
 * 真正在 CI 里拦回归的是 tests/portability.test.ts 的静态禁令。
 * ═══════════════════════════════════════════════════════════════════
 */

function compilerPath(): string | null {
  const roots = [process.env.PASEO_SERVER_DIST, (() => {
    try { return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(); } catch { return ""; }
  })()].filter(Boolean) as string[];
  for (const root of roots) {
    const candidate = join(root, "@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/plugins/compiler.js");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
const COMPILER = compilerPath();

/** 极简 hooks dispatcher：只求把组件函数跑起来，不做重渲染。 */
const DISPATCHER = {
  useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => {}],
  useReducer: (_r: unknown, init: unknown) => [init, () => {}],
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useRef: (init: unknown) => ({ current: init }),
  useEffect: () => {}, useLayoutEffect: () => {}, useInsertionEffect: () => {},
  useContext: (ctx: { _currentValue?: unknown } | null) => ctx?._currentValue,
  useDebugValue: () => {}, useId: () => "id",
  useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
  useTransition: () => [false, (fn: () => void) => fn()],
  useDeferredValue: (v: unknown) => v, useImperativeHandle: () => {},
};
// ⚠️ 必须真的装上去 —— 只定义不安装的话每个组件在第一个 hook 就炸，
// 而那看起来跟「界面渲染失败」一模一样。
(React as unknown as {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
}).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = DISPATCHER;

function walk(node: unknown, trail: string[], depth = 0): void {
  if (depth > 300) throw new Error("render depth exceeded");
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, trail, depth + 1);
    return;
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  const type = element.type;
  const props = element.props ?? {};
  // ⭐ React 对 undefined / null 的元素类型会抛
  // `Element type is invalid: … but got: undefined` —— 导入写错、导出名对不上、
  // 循环依赖都长这样。静默跳过的话这一整类错误一条都测不出来。
  if (type === undefined || type === null) {
    throw new Error(`Element type is invalid: got ${String(type)}（导入拿到了 undefined）`);
  }
  if (typeof type === "function") {
    trail.push((type as { name?: string }).name || "anonymous");
    const proto = (type as { prototype?: { isReactComponent?: unknown } }).prototype;
    if (proto?.isReactComponent) {
      const instance = new (type as new (p: unknown) => { render: () => unknown })(props);
      walk(instance.render(), trail, depth + 1);
    } else {
      walk((type as (p: unknown) => unknown)(props), trail, depth + 1);
    }
    trail.pop();
    return;
  }
  if (typeof type === "string") trail.push(type);
  if (props.children !== undefined) walk(props.children, trail, depth + 1);
  if (typeof type === "string") trail.pop();
}

const THEME = {
  colors: {
    surface0: "#000", surface1: "#111", surface2: "#222", border: "#333",
    foreground: "#fff", foregroundMuted: "#aaa", accent: "#4af", accentForeground: "#000",
    statusSuccess: "#0a0", statusWarning: "#fa0", statusDanger: "#f00",
  },
};

/** 时间线卡片的样本 —— 形状照 TimelineImpactSchema。 */
const TIMELINE_ITEM = { kind: "rumen-code-impact", version: 1, data: { tool: "edit", target: "src/index.ts", signal: "source" } };

async function renderAll(): Promise<{ ok: number; failures: string[] }> {
  const { compilePlugin } = await import(COMPILER!);
  const { clientBundle } = (await compilePlugin(join(import.meta.dirname, "..", "index.ts"))) as { clientBundle: string };
  const require_ = createRequire(join(import.meta.dirname, "..", "package.json"));

  const HOSTS = ["View", "Text", "Pressable", "ScrollView", "ActivityIndicator", "Image", "TextInput", "FlatList", "TouchableOpacity"];
  const base: Record<string, unknown> = Object.fromEntries(HOSTS.map((name) => [name, name]));
  base.StyleSheet = { create: (s: unknown) => s, flatten: (s: unknown) => s };
  base.Platform = { OS: "android", select: (o: Record<string, unknown>) => o.android ?? o.default };
  base.NativeModules = {};
  // 没显式列出的导出兜底成同名字符串宿主组件，免得「桩里没有」被误判成「运行时是 undefined」
  const reactNative = new Proxy(base, {
    get: (target, key) => (key in target ? target[key as string] : typeof key === "string" ? key : undefined),
    has: () => true,
  });

  const resolve = (id: string): unknown => {
    if (id === "react-native") return reactNative;
    if (id === "@getpaseo/plugin/react-native") {
      const Modal = Object.assign((props: { children?: unknown }) => props?.children ?? null, {
        Content: (props: { children?: unknown }) => props?.children ?? null,
      });
      return { Icon: "Icon", Modal, useToast: () => () => {} };
    }
    if (id === "@tanstack/react-query") return {
      useQuery: () => ({ data: undefined, error: null, isLoading: false, isFetching: false, refetch: async () => {} }),
      useMutation: () => ({ mutate: () => {}, isPending: false }),
      useQueryClient: () => ({ setQueryData: () => {}, invalidateQueries: async () => {} }),
    };
    if (id === "@getpaseo/plugin") {
      // ⭐ 照抄宿主那张表：Icon 只在宿主注入里有，npm 包本身不导出它
      return {
        ...(require_(id) as Record<string, unknown>),
        Icon: "Icon",
        useRpc: () => async () => ({}), useAgent: () => undefined,
        useWorkspace: () => undefined, usePaseo: () => ({}),
      };
    }
    try { return require_(id); } catch { return new Proxy({}, { get: () => () => null }); }
  };

  const surfaces: Array<{ id: string; Component: unknown; props?: Record<string, unknown> }> = [];
  const plugin = {
    handle: () => {},
    addTimelineTransformer: () => {},
    addTimelineRenderer: (c: { kind: string; Component: unknown }) =>
      surfaces.push({ id: `renderer:${c.kind}`, Component: c.Component, props: { item: TIMELINE_ITEM } }),
    addWorkspacePanel: (c: { id: string; Component: unknown }) => surfaces.push({ id: `panel:${c.id}`, Component: c.Component }),
    addSurface: (id: unknown, Component: unknown) => surfaces.push({ id: `surface:${String(id)}`, Component }),
    // sidebar item 只是个入口（id/title/icon/surface），没有 Component
    addSidebarItem: () => {},
    addCommandCenterItem: () => {}, addAttachmentSource: () => {}, addTheme: () => {},
    addClientSide: (fn: (client: unknown) => unknown) => {
      fn({
        rpc: async () => ({}), openPanel: () => {},
        addComposerPill: (c: { id: string; Component: unknown }) => {
          surfaces.push({ id: `pill:${c.id}`, Component: c.Component });
          return () => {};
        },
        paseo: { agents: {
          subscribe: () => () => {},
          list: async () => ({ entries: [] }),
        } },
      });
    },
  };
  // eslint-disable-next-line no-eval -- 就是要按宿主的方式执行它
  const factory = eval(clientBundle) as unknown;
  const exports = typeof factory === "function"
    ? (factory as (r: typeof resolve) => Record<string, unknown>)(resolve)
    : (factory as Record<string, unknown>);
  ((exports.default ?? exports) as (p: typeof plugin) => unknown)(plugin);

  const failures: string[] = [];
  let ok = 0;
  for (const surface of surfaces) {
    const trail: string[] = [];
    try {
      walk(React.createElement(surface.Component as never, {
        theme: THEME, host: { id: "rumen" }, layout: { compact: false },
        agentId: "a1", workspaceId: "w1", ...surface.props,
      } as never), trail);
      ok++;
    } catch (error) {
      failures.push(`${surface.id}: ${error instanceof Error ? error.message : String(error)}\n    路径 ${trail.join(" › ")}`);
    }
  }
  return { ok, failures };
}

const skip = COMPILER ? false : "本机没有全局 @getpaseo/cli";

test("⭐ 所有界面都渲染得出来", { skip }, async () => {
  const { ok, failures } = await renderAll();
  assert.deepEqual(failures, [], `\n${failures.join("\n")}\n`);
  assert.ok(ok >= 4, `只渲染了 ${ok} 个界面，太少了，多半是没收集到`);
});

test("⭐ 在没有 Intl 的运行时上也渲染得出来（安卓 Hermes）", { skip }, async () => {
  // ⚠️ 正常模式测不出这类问题 —— Node 有完整 Intl，一路绿灯，投到手机上才炸。
  const savedIntl = (globalThis as { Intl?: unknown }).Intl;
  const savedNumber = Number.prototype.toLocaleString;
  const savedDate = Date.prototype.toLocaleString;
  const savedCompare = String.prototype.localeCompare;
  const boom = function (): never { throw new TypeError("Object is not a function"); };
  (globalThis as { Intl?: unknown }).Intl = undefined;
  Number.prototype.toLocaleString = boom;
  Date.prototype.toLocaleString = boom;
  String.prototype.localeCompare = boom as never;
  try {
    const { failures } = await renderAll();
    assert.deepEqual(failures, [], `\n${failures.join("\n")}\n`);
  } finally {
    (globalThis as { Intl?: unknown }).Intl = savedIntl;
    Number.prototype.toLocaleString = savedNumber;
    Date.prototype.toLocaleString = savedDate;
    String.prototype.localeCompare = savedCompare;
  }
});
