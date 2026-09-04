import type { PluginHandlerContext } from "@getpaseo/plugin";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ingestMutations, markReviewed, mutationFrom, verdictBucket } from "../server/observe.server";
import { ScanBoundaryError, scanWorkspace } from "../server/scanner.server";
import {
  exportKnowledge,
  resetCommitCacheForTests,
  getAgentImpact,
  getDashboard,
  getReviewSource,
  getSettings,
  getWiki,
  markReviewDone,
  overview,
  recordEvidence,
  updateSettings,
} from "../server/service.server";
import { readState, resetStoreForTests, statePath, updateState } from "../server/store.server";

const AGENT_ENTRIES = [
  {
    item: {
      type: "tool_call",
      callId: "call-1",
      name: "functions.write",
      status: "completed",
      detail: { type: "write", filePath: "app.tsx" },
    },
    timestamp: "2026-01-02T12:00:00.000Z",
  },
  {
    item: {
      type: "tool_call",
      callId: "call-read",
      name: "read",
      status: "completed",
      detail: { type: "read", filePath: "app.tsx" },
    },
    timestamp: "2026-01-02T12:01:00.000Z",
  },
  {
    item: {
      type: "tool_call",
      callId: "call-failed",
      name: "write",
      status: "failed",
      detail: { type: "write", filePath: "app.tsx" },
    },
    timestamp: "2026-01-02T12:02:00.000Z",
  },
  {
    item: {
      type: "tool_call",
      callId: "call-outside",
      name: "write",
      status: "completed",
      detail: { type: "write", filePath: "/etc/passwd" },
    },
    timestamp: "2026-01-02T12:03:00.000Z",
  },
];

function contextFor(workspaceId: string, directory: string, agentId = "agent-1"): PluginHandlerContext {
  const workspace = { id: workspaceId, workspaceDirectory: directory, title: "Test workspace", name: "test" };
  const timeline = {
    agent: { id: agentId, workspaceId, status: "running", provider: "test", title: null },
    entries: AGENT_ENTRIES,
  };
  return {
    paseo: {
      workspaces: { ref: () => ({ refresh: async () => workspace }) },
      agents: {
        ref: () => ({ timeline: { refetch: async () => timeline } }),
        list: async () => ({ entries: [{ agent: { id: agentId, workspaceId, status: "running", provider: "test" } }] }),
      },
      // 测试环境里没有 provider —— 生成路径应当优雅降级而不是崩
      providers: { snapshot: async () => ({ entries: [] }) },
    },
  } as unknown as PluginHandlerContext;
}

async function withStore<T>(run: (data: string) => Promise<T>): Promise<T> {
  const data = await mkdtemp(join(tmpdir(), "paseo-rumen-data-"));
  process.env.RUMEN_DATA_DIR = data;
  // ⚠️ 共享语言设置写在 $PASEO_HOME 下，是**三个插件共用的真实文件**。
  // 不隔离的话测试会把用户设的语言改掉 —— 实测发生过一次
  const paseoHome = await mkdtemp(join(tmpdir(), "paseo-rumen-home-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = paseoHome;
  resetStoreForTests();
  resetCommitCacheForTests();
  try {
    return await run(data);
  } finally {
    delete process.env.RUMEN_DATA_DIR;
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    resetStoreForTests();
    resetCommitCacheForTests();
    await rm(data, { recursive: true, force: true });
    await rm(paseoHome, { recursive: true, force: true });
  }
}

// ── 扫描边界 ────────────────────────────────────────────────────────

test("家目录和文件系统根永远不扫", async () => {
  await assert.rejects(() => scanWorkspace(homedir(), false), ScanBoundaryError);
  await assert.rejects(() => scanWorkspace("/", false), ScanBoundaryError);
  await assert.rejects(() => scanWorkspace("/tmp", false), ScanBoundaryError);
});

test("每个包不再各自成一个技术栈 —— 未命中的进待归类池", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-rumen-scan-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: {
          react: "^19.0.0",
          "react-dom": "^19.0.0",
          ioredis: "^5.4.1",
          "acme-internal-widget": "^1.0.0",
          "another-unknown-lib": "^2.0.0",
        },
      }),
    );
    const result = await scanWorkspace(root, false);
    const ids = result.techs.map((item) => item.id).sort();
    // react + react-dom 归一到 tech:react；ioredis 归到 tech:redis
    assert.deepEqual(ids, ["tech:react", "tech:redis"]);
    const react = result.technologies.find((item) => item.techId === "tech:react")!;
    assert.deepEqual(react.packages.sort(), ["react", "react-dom"]);
    // 两个不认识的包进待归类池，不是技术栈
    assert.deepEqual(result.pending.map((item) => item.pkg).sort(), ["acme-internal-widget", "another-unknown-lib"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("多个包并到一个技术栈时，版本取最规范的那个包", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-rumen-version-"));
  try {
    // tsx 和 typescript 都归到 tech:typescript。tsx 在前，
    // 取"数组第一个"会显示出 TypeScript@^4.20.6 —— 一个不存在的版本号
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { tsx: "^4.20.6", typescript: "^5.9.3" } }),
    );
    const result = await scanWorkspace(root, false);
    const ts = result.technologies.find((item) => item.techId === "tech:typescript")!;
    assert.equal(ts.version, "^5.9.3", "版本要来自 typescript 本身，不是 tsx");
    assert.deepEqual(ts.packages.sort(), ["tsx", "typescript"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("前缀命中不比精确命中权威", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-rumen-prefix-"));
  try {
    // @types/react 是前缀命中，react 是精确命中 —— 版本该取 react 的
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "@types/react": "~19.2.0", react: "19.1.0" } }),
    );
    const result = await scanWorkspace(root, false);
    const react = result.technologies.find((item) => item.techId === "tech:react")!;
    assert.equal(react.version, "19.1.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(".env 一个字都不读", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-rumen-env-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
    await writeFile(join(root, ".env"), "REDIS_URL=redis://secret@prod\n");
    await writeFile(join(root, ".env.production"), "KAFKA=kafka://secret\n");
    const result = await scanWorkspace(root, false);
    const ids = result.techs.map((item) => item.id);
    assert.ok(!ids.includes("tech:redis"), ".env 里的 redis:// 不该被当成证据");
    assert.ok(!ids.includes("tech:kafka"));
    for (const usage of result.technologies) {
      for (const anchor of usage.evidence) {
        assert.ok(!anchor.file.includes(".env"), `证据锚点指向了 ${anchor.file}`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compose 的 image 里认出只出现在基础设施层的技术", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-rumen-compose-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { express: "^4.0.0" } }));
    await writeFile(
      join(root, "docker-compose.yml"),
      "services:\n  cache:\n    image: redis:7-alpine\n  db:\n    image: postgres:16\n",
    );
    const result = await scanWorkspace(root, false);
    const ids = result.techs.map((item) => item.id).sort();
    assert.ok(ids.includes("tech:redis"), "Redis 常常只在 compose 里出现");
    assert.ok(ids.includes("tech:postgresql"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 观测与还债闭环 ──────────────────────────────────────────────────

test("只认已完成的写类工具，且项目外的改动不算", () => {
  const root = "/tmp/project";
  const write = mutationFrom(AGENT_ENTRIES[0]!.item, AGENT_ENTRIES[0]!.timestamp, root);
  assert.equal(write?.file, "app.tsx");
  assert.equal(mutationFrom(AGENT_ENTRIES[1]!.item, AGENT_ENTRIES[1]!.timestamp, root), null, "read 不是改动");
  assert.equal(mutationFrom(AGENT_ENTRIES[2]!.item, AGENT_ENTRIES[2]!.timestamp, root), null, "失败的写不是改动");
  assert.equal(mutationFrom(AGENT_ENTRIES[3]!.item, AGENT_ENTRIES[3]!.timestamp, root), null, "项目外的改动不算这个项目的债");
});

test("知识债闭环：agent 写 → 记债 → 读过 → 还债", () => {
  const project = {
    id: "p1",
    workspaceIds: ["w1"],
    name: "p",
    root: "/tmp/p",
    privacy: "private" as const,
    isGit: false,
    lastScanAt: 1,
    truncated: false,
    lastAnalyzedSha: null,
    pending: [],
    technologies: [{
      techId: "tech:react",
      version: "19",
      confidence: 0.95,
      packages: ["react"],
      evidence: [{ file: "app.tsx", line: 1, snippet: "react", layer: "manifest" as const }],
    }],
  };
  const nodes = [{
    id: "tech:react/hooks#en",
    techId: "tech:react",
    lang: "en" as const,
    groupId: "tech:react/hooks",
    title: "Hooks",
    summary: "",
    difficulty: 2,
    prerequisites: [],
    keywords: [],
    symbols: [],
    origin: "generated" as const,
  }];

  const ingest = ingestMutations({
    project,
    nodes,
    agentId: "a1",
    mutations: [{ callId: "c1", file: "app.tsx", at: 1000 }],
    grasped: new Set(),
    existingObservationIds: new Set(),
    existingReviewIds: new Set(),
  });
  assert.equal(ingest.observations.length, 1);
  assert.equal(ingest.reviews.length, 1, "碰到证据锚点所在文件才进还债队列");
  assert.equal(ingest.evidence[0]?.kind, "agent_wrote_unreviewed");

  // 同一次调用重放不应该重复记债
  const replay = ingestMutations({
    project,
    nodes,
    agentId: "a1",
    mutations: [{ callId: "c1", file: "app.tsx", at: 1000 }],
    grasped: new Set(),
    existingObservationIds: new Set(ingest.observations.map((item) => item.id)),
    existingReviewIds: new Set(ingest.reviews.map((item) => item.id)),
  });
  assert.equal(replay.observations.length, 0);
  assert.equal(replay.reviews.length, 0);

  // 还债产生 agent_wrote_reviewed
  const paid = markReviewed(ingest.reviews[0]!, 2000);
  assert.equal(paid.length, 1);
  assert.equal(paid[0]?.kind, "agent_wrote_reviewed");
  // 引用键用 review id 而不是当天 —— 同一处改动只该还一次
  assert.deepEqual(markReviewed(ingest.reviews[0]!, 2000)[0]?.id, paid[0]?.id);

  // 已掌握的知识点不再记债
  const grasped = ingestMutations({
    project,
    nodes,
    agentId: "a1",
    mutations: [{ callId: "c2", file: "app.tsx", at: 3000 }],
    grasped: new Set(["tech:react/hooks"]),
    existingObservationIds: new Set(),
    existingReviewIds: new Set(),
  });
  assert.equal(grasped.reviews.length, 0, "掌握好的知识点再提醒只是噪声");
  assert.equal(grasped.evidence.length, 0);
  assert.equal(grasped.observations.length, 1, "但观测记录仍要留 —— 归因要用");
});

test("只有没见过的依赖才有资格打断", () => {
  assert.equal(verdictBucket({ techIds: [], candidates: ["kafkajs"], manifestTouched: true }, false), "new_knowledge");
  assert.equal(verdictBucket({ techIds: ["tech:react"], candidates: [], manifestTouched: false }, false), "attention");
  assert.equal(verdictBucket({ techIds: [], candidates: [], manifestTouched: true }, false), "done", "改了依赖清单本身不算新知识点");
  assert.equal(verdictBucket({ techIds: [], candidates: [], manifestTouched: false }, false), "done");
});

// ── 端到端 ──────────────────────────────────────────────────────────

test("端到端：扫描 → 记债 → 读源码 → 还债 → 掌握度变化", async () => {
  await withStore(async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-rumen-e2e-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
      await writeFile(join(root, "app.tsx"), "import React from 'react';\nexport const App = () => null;\n");
      const context = contextFor("workspace-1", root);
      const input = { workspaceId: "workspace-1", cwd: root };

      const dashboard = await getDashboard(input, context);
      const react = dashboard.technologies.find((item) => item.id === "tech:react");
      assert.ok(react, "React 应该被检出");
      assert.equal(dashboard.project.privacy, "private", "默认私有");
      assert.equal(dashboard.generation.available, false, "测试环境没有 provider");
      assert.equal(dashboard.generation.reason, "no_provider");
      assert.ok(react.nodes.every((node) => node.origin === "fallback"), "没生成过 Wiki 时知识点是占位的");

      // 没生成过 Wiki 就没有 Wiki —— 不拿模板假装有
      assert.equal(await getWiki({ ...input, techId: react.id }, context), null);

      // agent 改了 app.tsx（react 的证据锚点所在文件）→ 记债
      const impact = await getAgentImpact({ ...input, agentId: "agent-1" }, context);
      assert.ok(impact.totalDebt > 0, "agent 改过就该有债");
      assert.equal(impact.reviews.length, 1, "一次写产生一条待审阅");

      const before = (await getDashboard(input, context)).technologies.find((item) => item.id === react.id)!;
      assert.equal(before.mastery.score, 0, "未读的 agent 代码不涨分");
      assert.ok(before.mastery.debt > 0);

      // 读源码 —— 只读本地文件
      const source = await getReviewSource({ ...input, reviewId: impact.reviews[0]!.id }, context);
      assert.equal(source.available, true);
      assert.equal(source.file, "app.tsx");
      assert.ok(source.lines.some((line) => line.text.includes("import React")));

      // 还债
      const paid = await markReviewDone({ ...input, reviewId: impact.reviews[0]!.id }, context);
      assert.ok(paid.paid > 0, "还债要产生 agent_wrote_reviewed 证据");
      assert.equal(paid.reviews.length, 0, "还完就不在待审阅列表里了");

      const after = (await getDashboard(input, context)).technologies.find((item) => item.id === react.id)!;
      assert.ok(after.mastery.score > before.mastery.score, "读过之后掌握度要涨");

      // 重放同一批时间线条目不该重复记债
      const replay = await getAgentImpact({ ...input, agentId: "agent-1" }, context);
      assert.equal(replay.totalDebt, impact.totalDebt, "重放同一个 canonical call 不该新增债");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("知识点不属于本项目时拒绝记证据", async () => {
  await withStore(async () => {
    const first = await mkdtemp(join(tmpdir(), "paseo-rumen-a-"));
    const second = await mkdtemp(join(tmpdir(), "paseo-rumen-b-"));
    try {
      await writeFile(join(first, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
      await writeFile(join(second, "package.json"), JSON.stringify({ dependencies: { ioredis: "^5.0.0" } }));
      const contextA = contextFor("workspace-1", first);
      const contextB = contextFor("workspace-2", second);
      await getDashboard({ workspaceId: "workspace-1", cwd: first }, contextA);
      const dashboardB = await getDashboard({ workspaceId: "workspace-2", cwd: second }, contextB);
      const redisNode = dashboardB.technologies.find((item) => item.id === "tech:redis")!.nodes[0]!;
      await assert.rejects(
        () => recordEvidence(
          { workspaceId: "workspace-1", cwd: first, nodeGroupId: redisNode.groupId, kind: "wiki_read" },
          contextA,
        ),
        /不属于|does not belong/,
      );
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });
});

test("掌握度是全局的：A 项目学会，B 项目打开就是已掌握", async () => {
  await withStore(async () => {
    const first = await mkdtemp(join(tmpdir(), "paseo-rumen-share-a-"));
    const second = await mkdtemp(join(tmpdir(), "paseo-rumen-share-b-"));
    try {
      const manifest = JSON.stringify({ dependencies: { react: "^19.0.0" } });
      await writeFile(join(first, "package.json"), manifest);
      await writeFile(join(second, "package.json"), manifest);
      const contextA = contextFor("workspace-1", first, "agent-a");
      const contextB = contextFor("workspace-2", second, "agent-b");

      const dashboardA = await getDashboard({ workspaceId: "workspace-1", cwd: first }, contextA);
      const node = dashboardA.technologies.find((item) => item.id === "tech:react")!.nodes[0]!;
      await recordEvidence(
        { workspaceId: "workspace-1", cwd: first, nodeGroupId: node.groupId, kind: "wiki_read" },
        contextA,
      );

      const dashboardB = await getDashboard({ workspaceId: "workspace-2", cwd: second }, contextB);
      const sameNode = dashboardB.technologies
        .find((item) => item.id === "tech:react")!
        .nodes.find((item) => item.groupId === node.groupId)!;
      assert.ok(sameNode.mastery.score > 0, "共享是恒等式，不是功能 —— 两边读的本来就是同一行");
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });
});

test("全局界面按 projectId 寻址 —— 那里没有\"当前 workspace\"", async () => {
  await withStore(async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-rumen-byid-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
      const context = contextFor("workspace-1", root);

      // 先从 workspace 面板绑定一次
      const bound = await getDashboard({ workspaceId: "workspace-1", cwd: root }, context);
      const projectId = bound.project.id;

      // 再从全局界面按 id 打开：拿到同一个项目，不需要 workspace
      const byId = await getDashboard({ projectId }, context);
      assert.equal(byId.project.id, projectId);
      assert.equal(byId.project.root, root);
      assert.ok(byId.technologies.some((item) => item.id === "tech:react"));

      // 记证据也走同一条路
      const node = byId.technologies.find((item) => item.id === "tech:react")!.nodes[0]!;
      const mastery = await recordEvidence(
        { projectId, nodeGroupId: node.groupId, kind: "wiki_read" },
        context,
      );
      assert.ok(mastery.score > 0);

      // 两个都不给要被拒
      await assert.rejects(() => getDashboard({}, context), /找不到这个项目|Unknown project/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("项目名不能是 workspace 的会话标题", async () => {
  await withStore(async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-rumen-name-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
      // Paseo 的 workspace 快照里 title 是 agent 从对话生成的会话标题
      const context = {
        paseo: {
          workspaces: {
            ref: () => ({
              refresh: async () => ({
                id: "workspace-1",
                workspaceDirectory: root,
                title: "Explore naruto codebase",
                name: "some-worktree-slug",
                projectDisplayName: "acme-billing",
              }),
            }),
          },
          agents: { list: async () => ({ entries: [] }), ref: () => ({ timeline: { refetch: async () => ({ agent: null, entries: [] }) } }) },
          providers: { snapshot: async () => ({ entries: [] }) },
        },
      } as unknown as PluginHandlerContext;

      const dashboard = await getDashboard({ workspaceId: "workspace-1", cwd: root }, context);
      assert.equal(dashboard.project.name, "acme-billing", "要用 projectDisplayName，不是会话标题");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── 语言 ────────────────────────────────────────────────────────────

test("⭐ 语言设置写的是三个插件共用的那个文件", async () => {
  await withStore(async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-rumen-shared-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
      const context = contextFor("workspace-1", root);
      const { sharedLocalePath } = await import("../server/locale.server");

      await updateSettings({ locale: "zh" }, context);

      // 落点必须在 $PASEO_HOME 下，不是本插件的 plugin-data —— 否则别的插件读不到
      const path = sharedLocalePath();
      assert.ok(path.startsWith(process.env.PASEO_HOME!), `共享文件应在 PASEO_HOME 下，实际 ${path}`);
      assert.ok(!path.includes("plugin-data"), "不能写进本插件的私有目录");
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { locale: "zh" });

      // 模拟"另一个插件改了语言"：直接改文件，rumen 下次请求就该跟上
      await writeFile(path, JSON.stringify({ locale: "en" }), "utf8");
      const after = await getSettings({}, context);
      assert.equal(after.locale, "en", "别的插件改完，这边下次请求要跟上");
      assert.equal(after.resolvedLocale, "en");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("设置里的语言压过环境，且服务端错误跟着走", async () => {
  await withStore(async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-rumen-lang-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
      const context = contextFor("workspace-1", root);

      const auto = await getSettings({ clientLocale: "zh-CN" }, context);
      assert.equal(auto.locale, "auto");
      assert.equal(auto.resolvedLocale, "zh", "客户端报中文就用中文");

      const forced = await updateSettings({ locale: "en", clientLocale: "zh-CN" }, context);
      assert.equal(forced.resolvedLocale, "en", "用户的显式选择压过客户端推断");

      // 服务端产生的错误要跟着界面语言走
      await updateSettings({ locale: "zh" }, context);
      await assert.rejects(
        () => getDashboard({ workspaceId: "workspace-1", cwd: "relative/path" }, context),
        /必须是绝对路径/,
      );
      await updateSettings({ locale: "en" }, context);
      await assert.rejects(
        () => getDashboard({ workspaceId: "workspace-1", cwd: "relative/path" }, context),
        /must be absolute/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── 存储 ────────────────────────────────────────────────────────────

test("损坏的状态文件永不被覆盖", async () => {
  await withStore(async (data) => {
    await mkdir(data, { recursive: true });
    await writeFile(statePath(), "{not-json", "utf8");
    await assert.rejects(() => readState(), /malformed/);
    await assert.rejects(() => updateState((state) => state.projects.push()), /malformed/);
    assert.equal(await readFile(statePath(), "utf8"), "{not-json", "原文件必须原样保留");
  });
});

test("v1 迁移保留项目身份，丢弃坏掉的技术栈数据，并留下备份", async () => {
  await withStore(async (data) => {
    await mkdir(data, { recursive: true });
    const v1 = {
      version: 1,
      projects: [{
        // 家目录被当成 workspace 打开过一次留下的事故产物：它扫不了，
        // 留着只会在总览里挂一个永远报错的空项目
        id: "path:" + homedir(),
        workspaceIds: [],
        name: "test",
        root: homedir(),
        privacy: "private",
        lastScanAt: 1,
        truncated: true,
        technologies: [],
      }, {
        id: "git:github.com/acme/repo",
        workspaceIds: ["w1"],
        name: "repo",
        root: "/tmp/repo",
        privacy: "public",
        lastScanAt: 123,
        truncated: true,
        // v1 把每个包都当成了一个技术栈 —— 这批数据不能带进新 schema
        technologies: Array.from({ length: 2293 }, (_, index) => ({ id: `tech:npm/pkg-${index}`, name: `pkg-${index}` })),
      }],
      nodes: Array.from({ length: 6945 }, (_, index) => ({ id: `n${index}` })),
      evidence: [{ id: "e1", nodeId: "n0", kind: "agent_wrote_unreviewed", createdAt: 1 }],
      wikis: [],
      questions: [],
    };
    await writeFile(statePath(), JSON.stringify(v1), "utf8");

    const state = await readState();
    assert.equal(state.version, 3);
    assert.equal(state.projects.length, 1, "家目录那条事故产物被丢掉了");
    assert.equal(state.projects[0]?.id, "git:github.com/acme/repo", "项目身份要留住");
    assert.equal(state.projects[0]?.privacy, "public", "隐私级别是用户设的，要留住");
    assert.equal(state.projects[0]?.technologies.length, 0, "伪技术栈全部丢弃");
    assert.equal(state.projects[0]?.lastScanAt, null, "强制重扫");
    assert.equal(state.nodes.length, 0);
    assert.equal(state.evidence.length, 0, "挂在伪知识点上的证据指向的东西不存在");

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(data);
    assert.ok(files.some((name) => name.includes(".v1-")), "原文件要另存一份，用户想捞随时能捞");
  });
});

test("迁移只发生一次 —— 立刻落盘，不是只改内存", async () => {
  await withStore(async (data) => {
    await mkdir(data, { recursive: true });
    await writeFile(
      statePath(),
      JSON.stringify({ version: 1, projects: [{ id: "path:/tmp/x", root: "/tmp/x", name: "x" }] }),
      "utf8",
    );
    const { readdir } = await import("node:fs/promises");

    await readState();
    resetStoreForTests(); // 模拟一次插件 reload
    await readState();
    resetStoreForTests();
    await readState();

    const backups = (await readdir(data)).filter((name) => name.includes(".v1-"));
    assert.equal(backups.length, 1, "只改内存的话每次 reload 都会重新迁移并再留一份全量备份");
    const onDisk = JSON.parse(await readFile(statePath(), "utf8"));
    assert.equal(onDisk.version, 3, "磁盘上必须已经是最新版本");
  });
});

test("v2 → v3 把项目名从会话标题改回目录名", async () => {
  await withStore(async (data) => {
    await mkdir(data, { recursive: true });
    await writeFile(
      statePath(),
      JSON.stringify({
        version: 2,
        settings: { locale: "auto", provider: null, deferToUserAgents: true },
        projects: [{
          id: "git:github.com/acme/billing-api",
          workspaceIds: ["w1"],
          // v2 存的是 workspace 的会话标题 —— agent 从对话内容生成的
          name: "Investigate flaky checkout tests",
          root: "/home/alice/work/billing-api",
          privacy: "private",
          isGit: true,
          lastScanAt: 123,
          truncated: false,
          technologies: [],
          pending: [],
          lastAnalyzedSha: null,
        }],
        techs: [], nodes: [], evidence: [], wikis: [], questions: [],
        aliases: [], observations: [], reviews: [],
      }),
      "utf8",
    );

    const state = await readState();
    assert.equal(state.version, 3);
    assert.equal(state.projects[0]?.name, "billing-api", "项目是仓库，不会因为你跟 agent 聊了什么改名");
    assert.equal(state.projects[0]?.lastScanAt, 123, "v2 的扫描结果是好的，不该丢");

    const { readdir } = await import("node:fs/promises");
    assert.ok((await readdir(data)).some((name) => name.includes(".v2-")), "留一份 v2 备份");
  });
});

test("导出脱敏：不含路径、不含项目名、不含代码片段", async () => {
  await withStore(async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-rumen-export-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
      await writeFile(join(root, "app.tsx"), "import React from 'react';\n");
      const context = contextFor("workspace-1", root);
      await getDashboard({ workspaceId: "workspace-1", cwd: root }, context);

      const exported = await exportKnowledge({});
      const content = await readFile(exported.path, "utf8");
      assert.ok(exported.records > 0);
      assert.equal(content.includes(root), false, "导出不该出现项目路径");
      assert.equal(content.includes("app.tsx"), false, "导出不该出现文件名");
      assert.equal(content.includes("import React"), false, "导出不该出现代码片段");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("总览把多项目汇到一起", async () => {
  await withStore(async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-rumen-overview-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0", ioredis: "^5.0.0" } }));
      const context = contextFor("workspace-1", root);
      await getDashboard({ workspaceId: "workspace-1", cwd: root }, context);
      const summary = await overview({});
      assert.equal(summary.projects.length, 1);
      assert.equal(summary.totalTechnologies, 2);
      assert.ok(summary.projects[0]?.color.startsWith("#"), "每个项目要有身份色");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
