import type { PaseoApi } from "@getpaseo/client";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractJson, GenerationBusyError, runStructured } from "./agentrun.server";
import { analyzeCommits, matchKnowledge, readCommits, repoIdentityEmail } from "./commits.server";
import {
  fallbackNodes,
  generateQuestion,
  generateWiki,
  gradeLocally,
  majorVersionOf,
  MIN_SOURCED_RATIO,
  nodeGroupId,
  questionId,
  QUIZ_PASS_THRESHOLD,
  wikiCacheKey,
} from "./generate.server";
import type { StoredNode, StoredProject, StoredTechEntity } from "./store.server";
import test from "node:test";

const exec = promisify(execFile);

// ── agent 输出的解析与校验 ──────────────────────────────────────────

test("三种 JSON 形态都认", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
  assert.throws(() => extractJson("no json at all"), /no parsable JSON/);
});

/** 一个可编程的假 Paseo：按脚本依次返回每次调用的最终消息。 */
function fakePaseo(messages: string[], options: { running?: boolean } = {}): PaseoApi {
  let call = 0;
  return {
    providers: {
      snapshot: async () => ({ entries: [{ provider: "test", enabled: true, models: [{ id: "m", isDefault: true }] }] }),
    },
    agents: {
      list: async () => ({
        entries: options.running ? [{ agent: { id: "user-agent", status: "running", labels: {} } }] : [],
      }),
      create: async () => {
        const message = messages[Math.min(call, messages.length - 1)];
        call += 1;
        return {
          waitForFinish: async () => ({ status: "idle", final: null, error: null, lastMessage: message }),
          archive: async () => ({ archivedAt: "" }),
        };
      },
    },
  } as unknown as PaseoApi;
}

const RUN_BASE = {
  task: "test",
  prompt: "p",
  schema: {},
  cwd: "/tmp",
  provider: null,
  timeoutMs: 1000,
  deferToUserAgents: true,
};

test("用户的 agent 在跑时让路，不跟他抢配额", async () => {
  await assert.rejects(
    () => runStructured({ ...RUN_BASE, paseo: fakePaseo(['{"ok":1}'], { running: true }), validate: (v) => v }),
    GenerationBusyError,
  );
});

test("校验不过就重试，重试完还不过就丢弃 —— 不落库", async () => {
  let validations = 0;
  await assert.rejects(
    () =>
      runStructured({
        ...RUN_BASE,
        paseo: fakePaseo(['{"bad":1}']),
        validate() {
          validations += 1;
          throw new Error("nope");
        },
      }),
    /failed validation/,
  );
  assert.equal(validations, 3, "一次加两次重试");
});

test("重试成功就返回", async () => {
  const result = await runStructured({
    ...RUN_BASE,
    paseo: fakePaseo(["garbage", '{"ok":1}']),
    validate: (value) => value as { ok: number },
  });
  assert.deepEqual(result, { ok: 1 });
});

// ── Wiki 生成的反幻觉闸门 ───────────────────────────────────────────

function wikiPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    summary: "Redis is an in-memory data store.",
    sections: [
      { heading: "What it is", body: "...", source_refs: [0] },
      { heading: "Gotchas", body: "...", source_refs: [] },
    ],
    sources: [{ url: "https://redis.io/docs", title: "Redis docs", authority: 1 }],
    concepts: [
      { id: "basics", title: "Basics", summary: "s", difficulty: 1, prerequisites: [], keywords: ["redis"], symbols: ["SET"] },
      { id: "expiry", title: "Expiry", summary: "s", difficulty: 2, prerequisites: ["basics"], keywords: [], symbols: ["EXPIRE"] },
    ],
    ...overrides,
  });
}

const WIKI_BASE = {
  cwd: "/tmp",
  provider: null,
  deferToUserAgents: false,
  privacy: "private" as const,
  techId: "tech:redis",
  techName: "Redis",
  majorVersion: "7",
  lang: "en" as const,
  now: 1000,
};

test("指向不存在的 source 的引用被丢弃，可溯源比例如实计算", async () => {
  const result = await generateWiki({
    ...WIKI_BASE,
    paseo: fakePaseo([wikiPayload({
      sections: [
        { heading: "A", body: "x", source_refs: [0] },
        { heading: "B", body: "x", source_refs: [7] }, // 指向不存在的来源
        { heading: "C", body: "x", source_refs: [] },
      ],
    })]),
  });
  assert.deepEqual(result.wiki.sections[1]?.sourceRefs, [], "给没读过的段落硬安来源要被拆掉");
  assert.equal(result.wiki.sourcedRatio, 0.33, "3 段里只有 1 段真的有出处");
  assert.ok(result.wiki.sourcedRatio < MIN_SOURCED_RATIO, "低于阈值要能被 UI 标成不可信");
});

test("前置知识点必须回指到本次输出里存在的 id", async () => {
  await assert.rejects(
    () =>
      generateWiki({
        ...WIKI_BASE,
        paseo: fakePaseo([wikiPayload({
          concepts: [{ id: "a", title: "A", summary: "s", difficulty: 1, prerequisites: ["ghost"], keywords: [], symbols: [] }],
        })]),
      }),
    /failed validation/,
  );
});

test("知识点 DAG 不能有环", async () => {
  await assert.rejects(
    () =>
      generateWiki({
        ...WIKI_BASE,
        paseo: fakePaseo([wikiPayload({
          concepts: [
            { id: "a", title: "A", summary: "s", difficulty: 1, prerequisites: ["b"], keywords: [], symbols: [] },
            { id: "b", title: "B", summary: "s", difficulty: 1, prerequisites: ["a"], keywords: [], symbols: [] },
          ],
        })]),
      }),
    /failed validation/,
  );
});

test("知识点的跨语言身份稳定 —— 换语言看文档不该丢学习记录", async () => {
  const en = await generateWiki({ ...WIKI_BASE, paseo: fakePaseo([wikiPayload()]) });
  const zh = await generateWiki({ ...WIKI_BASE, lang: "zh", paseo: fakePaseo([wikiPayload()]) });
  assert.notDeepEqual(en.nodes[0]!.id, zh.nodes[0]!.id, "两个语言版本是两条记录");
  assert.equal(en.nodes[0]!.groupId, zh.nodes[0]!.groupId, "但掌握度挂的 groupId 是同一个");
  assert.equal(en.nodes[0]!.groupId, nodeGroupId("tech:redis", "basics"));
});

test("Shared 层缓存键与项目无关 —— 第 100 个用 Redis 的项目零成本", () => {
  assert.equal(wikiCacheKey("tech:redis", "7", "en"), wikiCacheKey("tech:redis", "7", "en"));
  assert.notEqual(wikiCacheKey("tech:redis", "7", "en"), wikiCacheKey("tech:redis", "7", "zh"));
  assert.notEqual(wikiCacheKey("tech:redis", "7", "en"), wikiCacheKey("tech:redis", "8", "en"));
  assert.equal(majorVersionOf("^5.4.1"), "5");
  assert.equal(majorVersionOf(null), "*");
});

test("兜底知识点跟随界面语言，且标明自己是占位的", () => {
  const zh = fallbackNodes("tech:redis", "Redis", "zh");
  const en = fallbackNodes("tech:redis", "Redis", "en");
  assert.ok(zh[0]!.title.includes("基础"));
  assert.ok(en[0]!.title.includes("fundamentals"));
  assert.ok(zh.every((node) => node.origin === "fallback"), "占位内容必须能被 UI 认出来并明说");
  assert.equal(zh[0]!.groupId, en[0]!.groupId, "占位内容也共享跨语言身份");
  assert.deepEqual(zh[1]!.prerequisites, [nodeGroupId("tech:redis", "fundamentals")]);
});

// ── 检验题 ──────────────────────────────────────────────────────────

test("答案在类型上就到不了展示层", async () => {
  const generated = await generateQuestion({
    paseo: fakePaseo([JSON.stringify({ prompt: "Why does this config leak memory?", rubric: ["mentions maxmemory", "mentions eviction"] })]),
    cwd: "/tmp",
    provider: null,
    deferToUserAgents: false,
    privacy: "private",
    techName: "Redis",
    nodeTitle: "Expiry",
    nodeSummary: "s",
    anchors: [],
    lang: "en",
  });
  assert.equal(generated.kind, "concept", "private 项目降级为概念题");
  assert.deepEqual(generated.rubric, ["mentions maxmemory", "mentions eviction"]);
  // 下发给客户端的 Quiz 类型里根本没有 rubric —— 这条由 contracts.shared 的
  // schema 保证，这里断言的是生成层确实把它分开存了
  assert.ok(!("answer" in generated));
});

test("public 项目才出代码题", async () => {
  const anchors = [{ file: "compose.yml", line: 3, snippet: "mem_limit: 128m", layer: "config" as const }];
  const payload = JSON.stringify({
    prompt: "This compose sets mem_limit but no maxmemory. What happens as data grows?",
    rubric: ["names the eviction gap", "traces it to user-visible failure"],
  });
  const code = await generateQuestion({
    paseo: fakePaseo([payload]),
    cwd: "/tmp",
    provider: null,
    deferToUserAgents: false,
    privacy: "public",
    techName: "Redis",
    nodeTitle: "Memory",
    nodeSummary: "s",
    anchors,
    lang: "en",
  });
  assert.equal(code.kind, "code");

  const degraded = await generateQuestion({
    paseo: fakePaseo([payload]),
    cwd: "/tmp",
    provider: null,
    deferToUserAgents: false,
    privacy: "private",
    techName: "Redis",
    nodeTitle: "Memory",
    nodeSummary: "s",
    anchors,
    lang: "en",
  });
  assert.equal(degraded.kind, "concept", "private 项目有锚点也不出代码题 —— 代码不出本机");
});

test("通过线定在 0.7，题目 id 幂等", () => {
  assert.equal(QUIZ_PASS_THRESHOLD, 0.7);
  const weak = gradeLocally(["explains eviction policy", "mentions maxmemory setting"], "eviction");
  assert.equal(weak.passed, false, "沾一个词不算掌握");
  assert.equal(questionId("g", "code", "en"), questionId("g", "code", "en"));
  assert.notEqual(questionId("g", "code", "en"), questionId("g", "concept", "en"));
  assert.notEqual(questionId("g", "code", "en"), questionId("g", "code", "zh"));
});

// ── Commit 分析 ─────────────────────────────────────────────────────

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "paseo-rumen-git-"));
  const run = (args: string[]) => exec("git", ["-C", root, ...args]);
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.email", "me@example.com"]);
  await run(["config", "user.name", "Me"]);
  await run(["config", "commit.gpgsign", "false"]);
  return root;
}

test("从真实 git 仓库里读出 commit 事实与归因", async () => {
  const root = await gitRepo();
  try {
    const run = (args: string[]) => exec("git", ["-C", root, ...args]);
    await writeFile(join(root, "pool.ts"), "export const pool = 1;\n");
    await run(["add", "-A"]);
    await run(["commit", "-q", "-m", "feat: add pool"]);

    await writeFile(join(root, "pool.ts"), "export const pool = 2;\nexport const extra = 3;\n");
    await run(["add", "-A"]);
    await run(["commit", "-q", "-m", "fix: pool drain deadlock\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>"]);

    assert.equal(await repoIdentityEmail(root), "me@example.com");

    const commits = await readCommits(root, 10);
    assert.equal(commits.length, 2);
    assert.equal(commits[0]?.subject, "fix: pool drain deadlock");
    assert.deepEqual(commits[0]?.files, ["pool.ts"]);
    assert.ok(commits[0]!.insertions > 0);
    assert.ok(commits[0]!.body.includes("noreply@anthropic.com"));

    const project: StoredProject = {
      id: "p",
      workspaceIds: [],
      name: "p",
      root,
      privacy: "private",
      isGit: true,
      lastScanAt: 1,
      truncated: false,
      lastAnalyzedSha: null,
      pending: [],
      technologies: [{
        techId: "tech:typescript",
        version: null,
        confidence: 0.9,
        packages: ["typescript"],
        evidence: [{ file: "pool.ts", line: 1, snippet: "pool", layer: "source" }],
      }],
    };
    const techs = new Map<string, StoredTechEntity>([[
      "tech:typescript",
      { id: "tech:typescript", name: "TypeScript", category: "language", worthLearning: true, origin: "builtin" },
    ]]);
    const nodes: StoredNode[] = [{
      id: "n#en",
      techId: "tech:typescript",
      lang: "en",
      groupId: "tech:typescript/basics",
      title: "Basics",
      summary: "",
      difficulty: 1,
      prerequisites: [],
      keywords: [],
      // 两个 commit 的 diff 里都有 `pool`，所以精确匹配能命中
      symbols: ["pool"],
      origin: "generated",
    }];

    const result = await analyzeCommits({
      project,
      techs,
      nodes,
      observations: [],
      grasped: new Set(),
      limit: 10,
    });
    assert.equal(result.insights.length, 2);

    const agentCommit = result.insights.find((item) => item.subject.startsWith("fix:"))!;
    assert.equal(agentCommit.authorship, "agent", "带 anthropic 域名 trailer 的判为 agent");
    assert.ok(agentCommit.knowledgeDebt > 0);
    assert.ok(agentCommit.signals.length > 0, "归因错了得能查出为什么");

    const humanCommit = result.insights.find((item) => item.subject.startsWith("feat:"))!;
    assert.equal(humanCommit.authorship, "human");
    assert.equal(humanCommit.confidence, 0.6, "没有观测记录时停在 0.6");
    assert.equal(humanCommit.knowledgeDebt, 0);

    // 证据落到 groupId 上；agent commit 记债，人写的 commit 涨分
    const kinds = new Set(result.evidence.map((item) => item.kind));
    assert.ok(kinds.has("agent_wrote_unreviewed"), "agent 写的记债");
    assert.ok(kinds.has("human_wrote"), "人写的且符号精确命中 → 正面证据");
    assert.ok(result.evidence.every((item) => item.nodeGroupId === "tech:typescript/basics"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("非 git 项目不做 commit 分析", async () => {
  const project = {
    id: "p",
    workspaceIds: [],
    name: "p",
    root: "/tmp",
    privacy: "private" as const,
    isGit: false,
    lastScanAt: 1,
    truncated: false,
    lastAnalyzedSha: null,
    pending: [],
    technologies: [],
  };
  const result = await analyzeCommits({
    project,
    techs: new Map(),
    nodes: [],
    observations: [],
    grasped: new Set(),
    limit: 10,
  });
  assert.deepEqual(result, { insights: [], evidence: [] });
});

test("符号匹配是 FQN-exact，不是子串", () => {
  const project: StoredProject = {
    id: "p",
    workspaceIds: [],
    name: "p",
    root: "/tmp",
    privacy: "private",
    isGit: true,
    lastScanAt: 1,
    truncated: false,
    lastAnalyzedSha: null,
    pending: [],
    technologies: [{
      techId: "tech:redis",
      version: null,
      confidence: 0.9,
      packages: ["ioredis"],
      evidence: [{ file: "cache.ts", line: 1, snippet: "", layer: "source" }],
    }],
  };
  const techs = new Map<string, StoredTechEntity>([[
    "tech:redis",
    { id: "tech:redis", name: "Redis", category: "datastore", worthLearning: true, origin: "builtin" },
  ]]);
  const nodes: StoredNode[] = [
    { id: "a", techId: "tech:redis", lang: "en", groupId: "redis/expiry", title: "", summary: "", difficulty: 1, prerequisites: [], keywords: [], symbols: ["EXPIRE"], origin: "generated" },
    { id: "b", techId: "tech:redis", lang: "en", groupId: "redis/cluster", title: "", summary: "", difficulty: 1, prerequisites: [], keywords: [], symbols: ["CLUSTER"], origin: "generated" },
  ];

  // 方法调用形态是符号最常见的出现方式，`.` 必须算合法边界
  const call = matchKnowledge({ project, techs, nodes, files: ["cache.ts"], diff: "+ await client.EXPIRE(key, 60)" });
  assert.deepEqual(call.exactNodeGroupIds, ["redis/expiry"], "只精确命中真正出现的符号");
  assert.deepEqual(
    call.coarseNodeGroupIds.sort(),
    ["redis/cluster", "redis/expiry"],
    "粗筛档是该技术下的全部知识点",
  );

  // 子串不算命中
  const substring = matchKnowledge({ project, techs, nodes, files: ["cache.ts"], diff: "+ const EXPIREDAT = 1" });
  assert.deepEqual(substring.exactNodeGroupIds, [], "EXPIREDAT 不是 EXPIRE 的精确命中");
  const underscore = matchKnowledge({ project, techs, nodes, files: ["cache.ts"], diff: "+ const MY_EXPIRE = 1" });
  assert.deepEqual(underscore.exactNodeGroupIds, [], "MY_EXPIRE 也不是");
});

test("正面证据只认精确匹配，记债才走粗筛", async () => {
  const root = await gitRepo();
  try {
    const run = (args: string[]) => exec("git", ["-C", root, ...args]);
    await writeFile(join(root, "cache.ts"), "export const ttl = 1;\n");
    await run(["add", "-A"]);
    // 人写的 commit，但 diff 里没有任何知识点符号
    await run(["commit", "-q", "-m", "feat: add ttl constant"]);

    const project: StoredProject = {
      id: "p", workspaceIds: [], name: "p", root, privacy: "private", isGit: true,
      lastScanAt: 1, truncated: false, lastAnalyzedSha: null, pending: [],
      technologies: [{
        techId: "tech:redis", version: null, confidence: 0.9, packages: ["ioredis"],
        evidence: [{ file: "cache.ts", line: 1, snippet: "", layer: "source" }],
      }],
    };
    const techs = new Map<string, StoredTechEntity>([[
      "tech:redis",
      { id: "tech:redis", name: "Redis", category: "datastore", worthLearning: true, origin: "builtin" },
    ]]);
    const nodes: StoredNode[] = [{
      id: "a", techId: "tech:redis", lang: "en", groupId: "redis/cluster", title: "", summary: "",
      difficulty: 1, prerequisites: [], keywords: [], symbols: ["CLUSTER"], origin: "generated",
    }];

    const result = await analyzeCommits({
      project, techs, nodes, observations: [], grasped: new Set(), limit: 10,
    });
    assert.equal(result.insights[0]?.authorship, "human");
    assert.equal(
      result.evidence.length,
      0,
      "改了 Redis 文件但 diff 里没有 CLUSTER —— 不该给你记上 Redis 集群的学习证据",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("知识点还没有符号可匹配时，正面证据不产生 —— 这是覆盖率门，不是 bug", async () => {
  const root = await gitRepo();
  try {
    const run = (args: string[]) => exec("git", ["-C", root, ...args]);
    await writeFile(join(root, "pool.ts"), "export const pool = 1;\n");
    await run(["add", "-A"]);
    await run(["commit", "-q", "-m", "feat: add pool"]);

    const project: StoredProject = {
      id: "p", workspaceIds: [], name: "p", root, privacy: "private", isGit: true,
      lastScanAt: 1, truncated: false, lastAnalyzedSha: null, pending: [],
      technologies: [{
        techId: "tech:typescript", version: null, confidence: 0.9, packages: ["typescript"],
        evidence: [{ file: "pool.ts", line: 1, snippet: "", layer: "source" }],
      }],
    };
    const techs = new Map<string, StoredTechEntity>([[
      "tech:typescript",
      { id: "tech:typescript", name: "TypeScript", category: "language", worthLearning: true, origin: "builtin" },
    ]]);
    // 占位知识点没有 symbols —— 生成过 Wiki 之前就是这个状态
    const nodes: StoredNode[] = [{
      id: "n", techId: "tech:typescript", lang: "en", groupId: "tech:typescript/fundamentals",
      title: "", summary: "", difficulty: 1, prerequisites: [], keywords: [], symbols: [],
      origin: "fallback",
    }];

    const result = await analyzeCommits({
      project, techs, nodes, observations: [], grasped: new Set(), limit: 10,
    });
    assert.equal(result.insights[0]?.authorship, "human");
    assert.equal(result.evidence.length, 0);
    // UI 有义务说清原因：技术栈卡片上的 hasWiki=false 和知识点的 origin=fallback
    // 就是为这条服务的。静默地只记债不涨分，用户会以为是算错了
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
