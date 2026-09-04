import assert from "node:assert/strict";
import { test } from "node:test";
import { collapse, FLAT_ORDER, flatRank, identityColor, IDENTITY_COLORS } from "../domain/buckets.shared";
import {
  attributeFromCommit,
  ATTRIBUTION_FLOOR,
  confidenceForLayers,
  decayTau,
  evidenceKey,
  evidenceKindFor,
  identityStrength,
  isFixCommit,
  masteryOf,
  normalizeRemote,
  projectIdentity,
  refineAttribution,
} from "../domain/domain.shared";
import { LOCALES, localeFromTag, MESSAGE_KEYS, relativeTime, resolveLocale, translator } from "../domain/i18n.shared";
import { assertNoProjectLeak, PrivacyLeakError, stripPaths } from "../domain/privacy.shared";
import { resolveTech, TECH_DEFS } from "../domain/techmap.shared";

// ── 掌握度 ──────────────────────────────────────────────────────────

test("agent 写的未读代码只记债，不动分数", () => {
  const now = Date.now();
  const debtOnly = masteryOf([{ kind: "agent_wrote_unreviewed", createdAt: now }], now);
  assert.equal(debtOnly.score, 0, "未读的 agent 代码不该涨分");
  assert.equal(debtOnly.debt, 1);
  assert.ok(debtOnly.confidence < 0.5, "有知识债时置信度该被拉低");
  assert.equal(debtOnly.grasped, false);
});

test("掌握度、置信度、知识债是三个独立的量", () => {
  const now = Date.now();
  // 分数够高但只有一类证据 → 置信度不足 → 不算掌握
  const singleKind = masteryOf(
    [{ kind: "quiz_passed", createdAt: now }, { kind: "quiz_passed", createdAt: now - 86_400_000 }],
    now,
  );
  assert.ok(singleKind.score >= 60, "两次通过检验题应该有不低的分数");
  const mixed = masteryOf(
    [
      { kind: "human_wrote", createdAt: now },
      { kind: "debugged", createdAt: now },
      { kind: "quiz_passed", createdAt: now },
    ],
    now,
  );
  assert.ok(mixed.grasped, "多类正面证据齐备才算掌握");
  assert.ok(mixed.confidence > singleKind.confidence, "证据种类越多，估计越有把握");
});

test("还债会把知识债换成正面证据", () => {
  const now = Date.now();
  const before = masteryOf([{ kind: "agent_wrote_unreviewed", createdAt: now }], now);
  const after = masteryOf(
    [
      { kind: "agent_wrote_unreviewed", createdAt: now },
      { kind: "agent_wrote_reviewed", createdAt: now },
    ],
    now,
  );
  assert.equal(before.score, 0);
  assert.ok(after.score > 0, "读过 agent 写的代码要涨分");
  assert.equal(after.debt, 1, "债的计数不因还债消失 —— 它是历史事实");
});

test("API 细节比概念衰减得快", () => {
  assert.ok(decayTau(5) < decayTau(1));
  const old = Date.now() - 200 * 86_400_000;
  const concept = masteryOf([{ kind: "human_wrote", createdAt: old }], Date.now(), 1);
  const detail = masteryOf([{ kind: "human_wrote", createdAt: old }], Date.now(), 5);
  assert.ok(concept.score > detail.score);
});

test("没有出处的证据按天去重", () => {
  const first = Date.UTC(2026, 0, 2, 1);
  const second = Date.UTC(2026, 0, 2, 23);
  const nextDay = Date.UTC(2026, 0, 3, 1);
  // 今天翻五遍同一页 wiki 不算学了五次
  assert.equal(evidenceKey("n", "wiki_read", undefined, first), evidenceKey("n", "wiki_read", undefined, second));
  // 但明天再翻是新的复习
  assert.notEqual(evidenceKey("n", "wiki_read", undefined, first), evidenceKey("n", "wiki_read", undefined, nextDay));
  assert.notEqual(evidenceKey("n", "wiki_read", undefined, first), evidenceKey("n", "quiz_passed", undefined, first));
});

test("⭐ 有出处的证据跨天也只算一次 —— 否则最强信号可以无限刷", () => {
  const today = Date.UTC(2026, 0, 2, 1);
  const nextYear = Date.UTC(2027, 5, 9, 1);
  // 同一道题明天重答一遍，不该再记一次 quiz_passed（权重 1.5，模型里最强的信号）
  assert.equal(
    evidenceKey("n", "quiz_passed", "quiz:abc", today),
    evidenceKey("n", "quiz_passed", "quiz:abc", nextYear),
  );
  // 同一处 agent 改动只该还一次债
  assert.equal(
    evidenceKey("n", "agent_wrote_reviewed", "review:xyz", today),
    evidenceKey("n", "agent_wrote_reviewed", "review:xyz", nextYear),
  );
  // 同一个 commit 也只算一次
  assert.equal(
    evidenceKey("n", "human_wrote", "commit:deadbeef", today),
    evidenceKey("n", "human_wrote", "commit:deadbeef", nextYear),
  );
  // 不同出处仍然是不同的证据
  assert.notEqual(
    evidenceKey("n", "quiz_passed", "quiz:abc", today),
    evidenceKey("n", "quiz_passed", "quiz:def", today),
  );
});

// ── 项目身份 ────────────────────────────────────────────────────────

test("等价的 git remote 归一到同一个身份", () => {
  const ssh = projectIdentity({ remote: "git@github.com:Acme/Repo.git", path: "/a" });
  const https = projectIdentity({ remote: "https://github.com/acme/repo", path: "/b" });
  assert.equal(ssh, https);
  assert.equal(normalizeRemote("https://user@github.com:443/acme/repo.git/"), "github.com/acme/repo");
});

test("身份强度单调，用来决定原地升级的方向", () => {
  assert.ok(identityStrength("git:github.com/a/b") > identityStrength("root:abc"));
  assert.ok(identityStrength("root:abc") > identityStrength("path:/tmp/x"));
});

test("跨层证据提升置信度但有上界", () => {
  assert.ok(confidenceForLayers(0.7, 3) > confidenceForLayers(0.7, 1));
  assert.ok(confidenceForLayers(0.95, 5) <= 0.99);
});

// ── 归因 ────────────────────────────────────────────────────────────

const BASE = { authorEmail: "me@example.com", committerEmail: "me@example.com", repoIdentityEmail: "me@example.com" };

test("认域名而不是模型名 —— 模型名一直在变，域名不变", () => {
  const claude = attributeFromCommit({
    ...BASE,
    subject: "feat: add cache",
    body: "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
  });
  assert.equal(claude.authorship, "agent");
  assert.ok(claude.confidence >= 0.95);
  // 换个模型名照样认得
  const future = attributeFromCommit({
    ...BASE,
    subject: "feat: add cache",
    body: "Co-Authored-By: Some Future Model <noreply@anthropic.com>",
  });
  assert.equal(future.authorship, "agent");
});

test("无标记且作者是本仓库身份 → human 0.6，这一档是硬伤", () => {
  const result = attributeFromCommit({ ...BASE, subject: "feat: x", body: "" });
  assert.equal(result.authorship, "human");
  assert.equal(result.confidence, 0.6);
});

test("别人的 commit 判不出，且不产生任何证据", () => {
  const result = attributeFromCommit({ ...BASE, authorEmail: "other@example.com", subject: "feat: x", body: "" });
  assert.equal(result.authorship, "unknown");
  assert.ok(result.confidence < ATTRIBUTION_FLOOR);
  assert.equal(evidenceKindFor(result, false), null, "判不出就一条证据都不该产生");
});

test("没在观测时，第二层一个字都不改", () => {
  const first = attributeFromCommit({ ...BASE, subject: "feat: x", body: "" });
  const refined = refineAttribution(first, ["a.ts"], { observing: false, agentTouched: new Set(["a.ts"]) });
  assert.deepEqual(refined, first, "没在观测就连信号都不加，否则审计记录里会出现无依据的话");
});

test("观测把 0.6 那一档双向解开", () => {
  const first = attributeFromCommit({ ...BASE, subject: "feat: x", body: "" });
  const toAgent = refineAttribution(first, ["a.ts", "b.ts"], {
    observing: true,
    agentTouched: new Set(["a.ts", "b.ts"]),
  });
  assert.equal(toAgent.authorship, "agent");
  assert.equal(toAgent.confidence, 0.95);

  const toHuman = refineAttribution(first, ["a.ts", "b.ts"], { observing: true, agentTouched: new Set() });
  assert.equal(toHuman.authorship, "human");
  assert.equal(toHuman.confidence, 0.9);

  const toMixed = refineAttribution(first, ["a.ts", "b.ts", "c.ts"], {
    observing: true,
    agentTouched: new Set(["a.ts"]),
  });
  assert.equal(toMixed.authorship, "mixed");
});

test("显式 trailer 永不下调", () => {
  const first = attributeFromCommit({
    ...BASE,
    subject: "feat: x",
    body: "Co-Authored-By: Claude <noreply@anthropic.com>",
  });
  const refined = refineAttribution(first, ["a.ts"], { observing: true, agentTouched: new Set() });
  assert.equal(refined.authorship, "agent", "作者自己写的声明比我们的旁证权威");
});

test("fix 类 commit 产生 debugged 而不是 human_wrote", () => {
  assert.ok(isFixCommit("fix: null pointer"));
  assert.ok(isFixCommit("fix(pool): drain deadlock"));
  assert.ok(!isFixCommit("feat: prefix"));
  const human = { authorship: "human" as const, confidence: 0.9, signals: [] };
  assert.equal(evidenceKindFor(human, true), "debugged");
  assert.equal(evidenceKindFor(human, false), "human_wrote");
});

test("六种证据全部可达 —— 没有够不到的枚举", () => {
  const reachable = new Set<string>();
  reachable.add("agent_wrote_unreviewed"); // observe.ingestMutations
  reachable.add("agent_wrote_reviewed"); //  observe.markReviewed
  reachable.add("wiki_read"); //             evidenceRpc
  reachable.add("quiz_passed"); //           answerQuiz
  reachable.add(evidenceKindFor({ authorship: "human", confidence: 0.9, signals: [] }, false)!);
  reachable.add(evidenceKindFor({ authorship: "human", confidence: 0.9, signals: [] }, true)!);
  assert.equal(reachable.size, 6);
});

// ── 状态桶 ──────────────────────────────────────────────────────────

test("折叠优先级与平铺排序刻意不同", () => {
  assert.equal(collapse(["running", "attention"]), "running", "折叠时正在干活的要继续显示 loader");
  assert.ok(
    flatRank("attention") < flatRank("running"),
    "平铺列表里 attention 排在 running 之上 —— 两套顺序不能共用一个常量",
  );
  assert.equal(collapse([]), "done");
  assert.equal(collapse(["done", "new_knowledge", "failed"]), "new_knowledge", "学习时机错过就没了，排在 failed 之上");
  assert.equal(collapse(["new_knowledge", "needs_input"]), "needs_input");
  assert.equal(FLAT_ORDER.length, 6);
});

test("身份色稳定且落在十色带内", () => {
  const color = identityColor("git:github.com/acme/repo");
  assert.equal(color, identityColor("git:github.com/acme/repo"), "同一个 key 永远同一个颜色");
  assert.ok(IDENTITY_COLORS.includes(color));
  assert.equal(IDENTITY_COLORS.length, 10, "数组长度是承重的：索引是 hash % 10");
});

// ── 技术栈归并 ──────────────────────────────────────────────────────

test("跨生态的同一个概念归到同一个 TechEntity", () => {
  const npm = resolveTech("ioredis", "npm");
  const pypi = resolveTech("redis-py", "pypi");
  const maven = resolveTech("spring-data-redis", "maven");
  assert.equal(npm?.techId, "tech:redis");
  assert.equal(pypi?.techId, "tech:redis");
  assert.equal(maven?.techId, "tech:redis");
});

test("未命中的包不是 TechEntity —— 它进待归类池", () => {
  assert.equal(resolveTech("some-random-internal-lib", "npm"), null);
});

test("agent 学到的 alias 压过内置表", () => {
  const learned = new Map([[
    "npm:vite",
    {
      pkg: "vite",
      ecosystem: "npm",
      techId: "tech:custom",
      name: "Custom",
      category: "build" as const,
      worthLearning: false,
      confidence: 0.9,
      learnedAt: 0,
    },
  ]]);
  assert.equal(resolveTech("vite", "npm")?.techId, "tech:vite");
  assert.equal(resolveTech("vite", "npm", learned)?.techId, "tech:custom");
});

test("命名空间按前缀吃掉，长前缀优先", () => {
  assert.equal(resolveTech("@nestjs/common", "npm")?.techId, "tech:nestjs");
  assert.equal(resolveTech("@opentelemetry/sdk-node", "npm")?.techId, "tech:opentelemetry");
});

test("内置 alias 表没有重复条目", () => {
  const seen = new Map<string, string>();
  for (const definition of TECH_DEFS) {
    for (const alias of definition.aliases) {
      const key = alias.toLowerCase();
      const previous = seen.get(key);
      assert.equal(previous, undefined, `alias ${key} 同时挂在 ${previous} 和 ${definition.id} 上`);
      seen.set(key, definition.id);
    }
  }
});

// ── 隐私 ────────────────────────────────────────────────────────────

test("private 项目的 prompt 里不能出现绝对路径", () => {
  const root = "/home/alice/work/acme-billing";
  assert.throws(
    () => assertNoProjectLeak(`Look at ${root}/src/db/pool.ts`, "private", [root]),
    PrivacyLeakError,
  );
  assert.throws(() => assertNoProjectLeak("see /srv/data/customers/report.csv", "private"), PrivacyLeakError);
  // public 项目不拦
  assert.doesNotThrow(() => assertNoProjectLeak(`Look at ${root}/src/db/pool.ts`, "public", [root]));
  // 技术文档里会提到的公共路径不算泄漏
  assert.doesNotThrow(() => assertNoProjectLeak("check /etc/nginx/nginx.conf", "private"));
});

test("private 项目的 prompt 里不能出现代码正文", () => {
  assert.throws(
    () => assertNoProjectLeak("Explain:\n```ts\nconst secret = 1;\n```", "private"),
    PrivacyLeakError,
  );
});

test("stripPaths 只留文件名", () => {
  assert.equal(stripPaths("edit /home/alice/acme/src/db/pool.ts now"), "edit pool.ts now");
});

// ── i18n ────────────────────────────────────────────────────────────

test("语言标签解析认 POSIX 和 BCP-47", () => {
  assert.equal(localeFromTag("zh_CN.UTF-8"), "zh");
  assert.equal(localeFromTag("zh-Hans"), "zh");
  assert.equal(localeFromTag("en_US"), "en");
  assert.equal(localeFromTag("C"), null, "C/POSIX 不是语言");
  assert.equal(localeFromTag("POSIX"), null);
  assert.equal(localeFromTag("fr_FR"), null);
  assert.equal(localeFromTag(undefined), null);
});

test("用户的显式选择压过环境推断，但压不过 RUMEN_LANG", () => {
  const env = { LANG: "zh_CN.UTF-8" };
  assert.equal(resolveLocale({ env }), "zh", "没有别的信号时跟随环境");
  assert.equal(resolveLocale({ env, saved: "en" }), "en", "设置页上点出来的是决定，环境只是推断");
  assert.equal(resolveLocale({ env: { ...env, RUMEN_LANG: "en" }, saved: "zh" }), "en");
  assert.equal(resolveLocale({ env: {}, clientHint: "zh-CN" }), "zh", "看界面的人和跑 daemon 的机器可能不是同一个");
  assert.equal(resolveLocale({ env: { LANG: "zh_CN" }, clientHint: "en-US" }), "en", "客户端语言排在宿主机之前");
  assert.equal(resolveLocale({ env: {} }), "en", "认不出来退到英文");
});

test("每条文案都给全了所有语言", () => {
  assert.ok(MESSAGE_KEYS.length > 100, "catalog 不该是空的");
  for (const locale of LOCALES) {
    const t = translator(locale);
    for (const key of MESSAGE_KEYS) {
      const entry = (t as Record<string, unknown>)[key];
      if (typeof entry === "function") continue; // 带参数的由调用点的类型保证
      assert.equal(typeof entry, "string", `${key} 在 ${locale} 下不是字符串`);
      assert.ok((entry as string).length > 0, `${key} 在 ${locale} 下是空的`);
    }
  }
});

test("中英文案不是同一个字符串（真的翻译过）", () => {
  const zh = translator("zh");
  const en = translator("en");
  let differing = 0;
  for (const key of MESSAGE_KEYS) {
    const a = (zh as Record<string, unknown>)[key];
    const b = (en as Record<string, unknown>)[key];
    if (typeof a === "string" && typeof b === "string" && a !== b) differing += 1;
  }
  assert.ok(differing > 80, `只有 ${differing} 条中英不同，catalog 可能有大量未翻译`);
});

test("中文文案不带尾句号，空状态是短名词短语", () => {
  const t = translator("zh");
  for (const key of ["action_scan", "action_export", "tab_now", "label_mastery", "quiz_passed"] as const) {
    const value = t[key] as string;
    assert.ok(!value.endsWith("。"), `${key} 不该有尾句号`);
  }
});

test("相对时间跟随语言", () => {
  const now = Date.UTC(2026, 0, 2, 12);
  assert.equal(relativeTime(translator("zh"), now - 5000, now), "刚刚");
  assert.equal(relativeTime(translator("en"), now - 5000, now), "just now");
  assert.equal(relativeTime(translator("zh"), now - 3 * 60_000, now), "3 分钟前");
  assert.equal(relativeTime(translator("en"), now - 3 * 60_000, now), "3m ago");
});
