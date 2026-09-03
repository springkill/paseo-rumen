/**
 * Wiki、知识点 DAG、检验题的生成。
 *
 * ## 检索与写作合成一次调用
 *
 * agent 自带 WebSearch，所以不做"先检索、再把结果喂回去写"的两段式：
 * 让它自己搜、自己引，一次调用出结果。好处不只是省一次固定开销，
 * 更重要的是**它引的就是它真读过的** —— 两段式里模型很容易给自己没读过的
 * 段落硬安一个来源。
 *
 * ## 反幻觉
 *
 * - 正文每个事实性段落必须挂 ≥1 个 source
 * - 挂不上的段落标 `unsourced`，UI 灰化 + 角标，**不删除但不可信**
 * - 每个 source 落库存 url / title / authority，可溯源
 * - `sourcedRatio` 低于 {@link MIN_SOURCED_RATIO} 时 UI 必须明说这篇不可信 ——
 *   反幻觉的闸门是"让不可信的东西看起来不可信"，不是"假装它不存在"
 *
 * ## Shared 层是成本控制机制
 *
 * 缓存键 `(techId, majorVersion, lang)`，与项目无关。第 100 个 Node 项目
 * 绑进来时，Express 的 Shared 层是零成本的。
 *
 * ## 隐私
 *
 * Shared 层的 prompt 里只有**技术名与主版本**，不含任何项目内容。
 * 所以它对 `private` 项目也是安全的；只有 `airgapped` 要完全禁掉。
 */

import type { PaseoApi } from "@getpaseo/client";
import { runStructured } from "./agentrun.server";
import type { Privacy } from "./domain.shared";
import { stableHash } from "./domain.shared";
import type { Locale } from "./i18n.shared";
import { runsDirectory } from "./agentrun.server";
import { allowsProjectCode, assertNoProjectLeak } from "./privacy.shared";
import type { StoredAnchor, StoredNode, StoredWiki, StoredWikiSection } from "./store.server";

/** 内容 schema 版本。改了内容结构就 +1，旧缓存自动失效。 */
export const WIKI_SCHEMA_VERSION = 1;

/** 低于这个"有来源段落占比"就认为这次生成不可信。不是丢弃 —— 是明确警告。 */
export const MIN_SOURCED_RATIO = 0.6;

/** 通过线定在 0.7 而非 0.5。宁可多考一次，不要把"大概知道"算成"掌握"。 */
export const QUIZ_PASS_THRESHOLD = 0.7;

const LANGUAGE_NAME: Record<Locale, string> = { zh: "Simplified Chinese", en: "English" };

/** 生成一篇 wiki 的超时。要联网搜多次再写长文，给足。 */
const WIKI_TIMEOUT_MS = 900_000;
const QUIZ_TIMEOUT_MS = 300_000;

export function majorVersionOf(version: string | null): string {
  if (!version) return "*";
  const match = version.match(/(\d+)/);
  return match ? match[1]! : "*";
}

export function wikiCacheKey(techId: string, majorVersion: string, lang: Locale): string {
  return `${techId}@${majorVersion}#${lang}#v${WIKI_SCHEMA_VERSION}`;
}

// ── Wiki + 知识点 DAG ───────────────────────────────────────────────

const WIKI_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          body: { type: "string" },
          source_refs: { type: "array", items: { type: "integer" } },
        },
        required: ["heading", "body", "source_refs"],
        additionalProperties: false,
      },
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          authority: { type: "integer" },
        },
        required: ["url", "title", "authority"],
        additionalProperties: false,
      },
    },
    concepts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          difficulty: { type: "integer" },
          prerequisites: { type: "array", items: { type: "string" } },
          keywords: { type: "array", items: { type: "string" } },
          symbols: { type: "array", items: { type: "string" } },
        },
        required: ["id", "title", "summary", "difficulty", "prerequisites", "keywords", "symbols"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "sections", "sources", "concepts"],
  additionalProperties: false,
};

function wikiPrompt(techName: string, majorVersion: string, lang: Locale): string {
  const version = majorVersion === "*" ? "" : ` (major version ${majorVersion})`;
  return `Write a learning guide for the technology **${techName}**${version}, for a working
software engineer whose coding agent has been writing ${techName} code that they have not read.

Search the web first. Prefer sources in this order and record every source you actually read:
official documentation (authority 1) > official blog / RFC / design docs (authority 2) >
upstream source code and issues (authority 3) > everything else (authority 4).

Write ALL prose — \`summary\`, every section \`heading\` and \`body\`, and every concept
\`title\` and \`summary\` — in ${LANGUAGE_NAME[lang]}. Keep code identifiers, API names,
and URLs in their original form.

## sections
Cover: what it is and what problem it solves; the mental model; how it is normally wired
into a project; the failure modes and anti-patterns people actually hit; operational
concerns (performance, limits, security).

**Every factual paragraph must cite at least one source.** \`source_refs\` holds 0-based
indices into your \`sources\` array. If you cannot honestly cite a claim, still write it but
leave \`source_refs\` empty — it will be shown to the user as unsourced. Do NOT attach a
source you did not actually read to make the ratio look better; that is the one failure
this whole format exists to prevent.

## concepts
Break ${techName} into a DAG of knowledge concepts.

- Granularity rule: **one concept ≈ 15 minutes to explain, and you can write exactly one
  test question about it.** Not "Redis" and not "the EXPIRE command's third argument".
- \`id\` is a short lowercase kebab slug, unique within this response (e.g. \`expiry-policy\`).
- \`prerequisites\` are ids from this same list. The graph must be acyclic and every
  referenced id must exist here. Concepts with no prerequisites come first.
- \`difficulty\` is 1..5.
- \`keywords\`: the vocabulary someone who understands this concept would naturally use.
- \`symbols\`: concrete API names, types, config keys or CLI flags belonging to this concept.
  These are matched exactly against code, so give real identifiers, not descriptions.
  Empty array if the concept has no code surface.

Aim for 6-14 concepts. Return only the JSON object.`;
}

interface RawWiki {
  summary: string;
  sections: Array<{ heading: string; body: string; source_refs: number[] }>;
  sources: Array<{ url: string; title: string; authority: number }>;
  concepts: Array<{
    id: string;
    title: string;
    summary: string;
    difficulty: number;
    prerequisites: string[];
    keywords: string[];
    symbols: string[];
  }>;
}

export interface GeneratedWiki {
  wiki: StoredWiki;
  nodes: StoredNode[];
}

/** 知识点的跨语言稳定身份。同一个技术的同一个概念，换语言生成也是同一个 `groupId`。 */
export function nodeGroupId(techId: string, conceptId: string): string {
  return `${techId}/${conceptId}`;
}

export async function generateWiki(input: {
  paseo: PaseoApi;
  cwd: string;
  provider: string | null;
  deferToUserAgents: boolean;
  privacy: Privacy;
  techId: string;
  techName: string;
  majorVersion: string;
  lang: Locale;
  now?: number;
  runId: string;
  onAgent?: (agentId: string) => void;
}): Promise<GeneratedWiki> {
  const now = input.now ?? Date.now();
  const prompt = wikiPrompt(input.techName, input.majorVersion, input.lang);
  // Shared 层不含项目内容，但闸门照走一遍 —— 防的是以后有人往 prompt 里塞东西
  assertNoProjectLeak(prompt, input.privacy);

  const { value: raw } = await runStructured<RawWiki>({
    paseo: input.paseo,
    task: `wiki:${input.techName}`,
    runId: input.runId,
    onAgent: input.onAgent,
    prompt,
    schema: WIKI_SCHEMA,
    cwd: input.cwd,
    provider: input.provider,
    timeoutMs: WIKI_TIMEOUT_MS,
    deferToUserAgents: input.deferToUserAgents,
    validate(value) {
      const doc = value as Partial<RawWiki>;
      if (typeof doc.summary !== "string" || !doc.summary.trim()) throw new Error("missing summary");
      if (!Array.isArray(doc.sections) || doc.sections.length === 0) throw new Error("missing sections");
      if (!Array.isArray(doc.sources)) throw new Error("missing sources");
      if (!Array.isArray(doc.concepts) || doc.concepts.length === 0) throw new Error("missing concepts");
      const ids = new Set(doc.concepts.map((concept) => concept?.id).filter((id): id is string => typeof id === "string"));
      if (ids.size !== doc.concepts.length) throw new Error("concept ids are not unique");
      for (const concept of doc.concepts) {
        if (!Array.isArray(concept.prerequisites)) throw new Error(`concept ${concept.id} has no prerequisites array`);
        for (const prerequisite of concept.prerequisites) {
          // ⭐ 回指校验：前置知识点必须在本次输出里存在，不能指向凭空的 id
          if (!ids.has(prerequisite)) throw new Error(`concept ${concept.id} references unknown prerequisite ${prerequisite}`);
        }
        if (concept.prerequisites.includes(concept.id)) throw new Error(`concept ${concept.id} is its own prerequisite`);
      }
      if (hasCycle(doc.concepts)) throw new Error("concept prerequisites form a cycle");
      return doc as RawWiki;
    },
  });

  const sources = raw.sources
    .filter((source) => typeof source.url === "string" && /^https?:\/\//i.test(source.url))
    .map((source) => ({
      url: source.url.slice(0, 500),
      title: (source.title || source.url).slice(0, 200),
      authority: Math.max(1, Math.min(4, Math.round(source.authority) || 4)),
    }));

  const sections: StoredWikiSection[] = raw.sections.map((section) => ({
    heading: String(section.heading ?? "").slice(0, 200),
    body: String(section.body ?? ""),
    // ⭐ 指向不存在的 source 一律丢弃 —— 这是"给没读过的段落硬安来源"的主要形态
    sourceRefs: (Array.isArray(section.source_refs) ? section.source_refs : [])
      .filter((index) => Number.isInteger(index) && index >= 0 && index < sources.length),
  }));

  const sourced = sections.filter((section) => section.sourceRefs.length > 0).length;
  const sourcedRatio = sections.length ? Math.round((sourced / sections.length) * 100) / 100 : 0;

  const nodes: StoredNode[] = raw.concepts.map((concept) => ({
    id: `${input.techId}/${concept.id}#${input.lang}`,
    techId: input.techId,
    lang: input.lang,
    groupId: nodeGroupId(input.techId, concept.id),
    title: String(concept.title).slice(0, 200),
    summary: String(concept.summary).slice(0, 2000),
    difficulty: Math.max(1, Math.min(5, Math.round(concept.difficulty) || 1)),
    prerequisites: concept.prerequisites.map((id) => nodeGroupId(input.techId, id)),
    keywords: (concept.keywords ?? []).filter((item) => typeof item === "string").slice(0, 20),
    symbols: (concept.symbols ?? []).filter((item) => typeof item === "string").slice(0, 30),
    origin: "generated",
  }));

  return {
    wiki: {
      techId: input.techId,
      majorVersion: input.majorVersion,
      lang: input.lang,
      title: input.techName,
      summary: raw.summary,
      sections,
      sources,
      generatedAt: now,
      sourcedRatio,
      schemaVersion: WIKI_SCHEMA_VERSION,
    },
    nodes,
  };
}

function hasCycle(concepts: RawWiki["concepts"]): boolean {
  const graph = new Map(concepts.map((concept) => [concept.id, concept.prerequisites ?? []]));
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const seen = state.get(id);
    if (seen === 1) return true;
    if (seen === 2) return false;
    state.set(id, 1);
    for (const next of graph.get(id) ?? []) {
      if (visit(next)) return true;
    }
    state.set(id, 2);
    return false;
  };
  return [...graph.keys()].some(visit);
}

/**
 * 没有生成能力时的兜底知识点。
 *
 * ⚠️ 它是**兜底**，不是产品。`origin: "fallback"` 会让 UI 明说
 * "这是占位的，生成一次才有真内容" —— 静默用模板顶替，用户会以为
 * "Redis 的知识点就这三条"，那比没有知识点更糟。
 *
 * 与之前那版的区别：文案跟随界面语言，且不假装自己是生成出来的。
 */
export function fallbackNodes(
  techId: string,
  techName: string,
  lang: Locale,
): StoredNode[] {
  const shape = lang === "zh"
    ? [
      { id: "fundamentals", title: `${techName} 基础`, summary: `${techName} 的核心抽象、执行模型和术语。`, difficulty: 1 },
      { id: "integration", title: `${techName} 接入`, summary: `在真实项目里怎么配置、划边界、写测试。`, difficulty: 2 },
      { id: "operations", title: `${techName} 排障与运维`, summary: `故障诊断、性能上限、安全考量和取舍。`, difficulty: 3 },
    ]
    : [
      { id: "fundamentals", title: `${techName} fundamentals`, summary: `Core abstractions, execution model, and vocabulary of ${techName}.`, difficulty: 1 },
      { id: "integration", title: `${techName} integration`, summary: `Configuration, boundaries, and tests in a real project.`, difficulty: 2 },
      { id: "operations", title: `${techName} production and debugging`, summary: `Failure diagnosis, performance limits, security, and trade-offs.`, difficulty: 3 },
    ];
  return shape.map((item, index) => ({
    id: `${techId}/${item.id}#${lang}`,
    techId,
    lang,
    groupId: nodeGroupId(techId, item.id),
    title: item.title,
    summary: item.summary,
    difficulty: item.difficulty,
    prerequisites: index === 0 ? [] : [nodeGroupId(techId, shape[index - 1]!.id)],
    keywords: [techName],
    symbols: [],
    origin: "fallback",
  }));
}

// ── 检验题 ──────────────────────────────────────────────────────────

const QUIZ_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    rubric: { type: "array", items: { type: "string" } },
  },
  required: ["prompt", "rubric"],
  additionalProperties: false,
};

export interface GeneratedQuestion {
  prompt: string;
  /** 评分要点。**永远不下发给客户端。** */
  rubric: string[];
  kind: "code" | "concept";
}

/**
 * 出一道题。
 *
 * **代码题优先，概念题兜底。** 代码题拿这个项目里真实用到该知识点的代码出题，
 * 测"会用"；概念题从 wiki 出，测"读懂"。前者信号强得多。
 *
 * 隐私不允许时**降级而不是阻断**，并且要在 UI 上**明说降级原因与开启方式** ——
 * 静默降级会让用户高估这次通过的含金量。
 */
export async function generateQuestion(input: {
  paseo: PaseoApi;
  cwd: string;
  provider: string | null;
  deferToUserAgents: boolean;
  privacy: Privacy;
  techName: string;
  nodeTitle: string;
  nodeSummary: string;
  anchors: readonly StoredAnchor[];
  lang: Locale;
  runId: string;
  onAgent?: (agentId: string) => void;
}): Promise<GeneratedQuestion> {
  const useCode = allowsProjectCode(input.privacy) && input.anchors.length > 0;
  const kind: "code" | "concept" = useCode ? "code" : "concept";

  const codeContext = useCode
    ? `\n\nHere is how this workspace actually uses it:\n\n${
      input.anchors.slice(0, 8).map((item) => `${item.file}:${item.line}\n    ${item.snippet}`).join("\n")
    }`
    : "";

  const prompt = `Write ONE test question that checks whether an engineer genuinely understands
this concept — not whether they can recall a definition.

Technology: ${input.techName}
Concept: ${input.nodeTitle}
What it covers: ${input.nodeSummary}${codeContext}

${
    useCode
      ? "Base the question on the real code above. A good question walks from a concrete\nproperty of this code to a consequence the engineer has to reason out."
      : "Base the question on the concept itself. Ask for reasoning about a consequence or a\ntrade-off, not for a definition."
  }

Write the question in ${LANGUAGE_NAME[input.lang]}.

\`rubric\` is 3-6 short statements describing what a correct answer must demonstrate.
**The rubric is never shown to the person answering.** Do not restate the answer inside
\`prompt\` — a question that contains its own answer is worthless.

Return only the JSON object.`;

  // ⭐ 非 public 项目：这里就是代码和路径出本机的最后一道闸
  // 交付路径在 Rumen 自己的目录下，显式放行；项目路径仍然一个字都不许出现
  assertNoProjectLeak(prompt, input.privacy, [input.cwd], [runsDirectory()]);

  const { value: raw } = await runStructured<{ prompt: string; rubric: string[] }>({
    paseo: input.paseo,
    task: `quiz:${input.techName}`,
    runId: input.runId,
    onAgent: input.onAgent,
    prompt,
    schema: QUIZ_SCHEMA,
    cwd: input.cwd,
    provider: input.provider,
    timeoutMs: QUIZ_TIMEOUT_MS,
    deferToUserAgents: input.deferToUserAgents,
    validate(value) {
      const item = value as { prompt?: unknown; rubric?: unknown };
      if (typeof item.prompt !== "string" || item.prompt.trim().length < 10) throw new Error("prompt too short");
      if (!Array.isArray(item.rubric) || item.rubric.length < 2) throw new Error("rubric needs at least two points");
      return {
        prompt: item.prompt.trim(),
        rubric: item.rubric.filter((point): point is string => typeof point === "string").slice(0, 8),
      };
    },
  });

  return { ...raw, kind };
}

const GRADE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    score: { type: "number" },
    covered: { type: "array", items: { type: "string" } },
    missing: { type: "array", items: { type: "string" } },
    feedback: { type: "string" },
  },
  required: ["score", "covered", "missing", "feedback"],
  additionalProperties: false,
};

export interface Grade {
  score: number;
  passed: boolean;
  feedback: string;
}

/**
 * 判分。
 *
 * **给出具体欠缺但不给出答案** —— prompt 里明确禁止，说破了这道题就废了。
 */
export async function gradeAnswer(input: {
  paseo: PaseoApi;
  cwd: string;
  provider: string | null;
  deferToUserAgents: boolean;
  privacy: Privacy;
  question: string;
  rubric: readonly string[];
  answer: string;
  lang: Locale;
  runId: string;
}): Promise<Grade> {
  const prompt = `Grade this answer against the rubric.

Question:
${input.question}

Rubric (what a correct answer must demonstrate):
${input.rubric.map((point, index) => `${index + 1}. ${point}`).join("\n")}

The engineer's answer:
${input.answer}

\`score\` is the fraction of rubric points genuinely demonstrated, in [0,1]. Judge
understanding, not vocabulary: restating the question in different words scores 0 for
that point. Partial credit is fine.

\`feedback\` names what is missing and where to look — **but never states the answer**.
If they got it wrong, they must be able to go find out themselves. Write the feedback
in ${LANGUAGE_NAME[input.lang]}.

Return only the JSON object.`;

  // 交付路径在 Rumen 自己的目录下，显式放行；项目路径仍然一个字都不许出现
  assertNoProjectLeak(prompt, input.privacy, [input.cwd], [runsDirectory()]);

  const { value: raw } = await runStructured<{ score: number; feedback: string }>({
    paseo: input.paseo,
    task: "grade",
    runId: input.runId,
    prompt,
    schema: GRADE_SCHEMA,
    cwd: input.cwd,
    provider: input.provider,
    timeoutMs: QUIZ_TIMEOUT_MS,
    deferToUserAgents: input.deferToUserAgents,
    retries: 1,
    validate(value) {
      const item = value as { score?: unknown; feedback?: unknown };
      if (typeof item.score !== "number" || !Number.isFinite(item.score)) throw new Error("missing score");
      if (typeof item.feedback !== "string") throw new Error("missing feedback");
      return { score: Math.max(0, Math.min(1, item.score)), feedback: item.feedback.trim() };
    },
  });

  return {
    score: Math.round(raw.score * 100) / 100,
    passed: raw.score >= QUIZ_PASS_THRESHOLD,
    feedback: raw.feedback,
  };
}

/**
 * 判分的确定性兜底：`airgapped` 项目、或生成不可用时。
 *
 * ⚠️ 它明显比 agent 判分弱 —— 靠 rubric 关键词覆盖率。所以调用方
 * **必须在 UI 上说清这次是降级判分**，否则用户会高估这次通过的含金量。
 */
export function gradeLocally(rubric: readonly string[], answer: string): Grade {
  const normalized = answer.toLowerCase();
  const terms = rubric
    .flatMap((point) => point.toLowerCase().match(/[a-z0-9_]{4,}|[一-龥]{2,}/g) ?? [])
    .filter((term, index, all) => all.indexOf(term) === index);
  const hit = terms.filter((term) => normalized.includes(term)).length;
  const coverage = terms.length ? hit / terms.length : 0;
  const depth = Math.min(0.2, answer.trim().split(/\s+|(?<=[一-龥])/).filter(Boolean).length / 400);
  const score = Math.max(0, Math.min(1, coverage + depth));
  return {
    score: Math.round(score * 100) / 100,
    passed: score >= QUIZ_PASS_THRESHOLD,
    feedback: "",
  };
}

/** 题目 id。同一个知识点的同一道题幂等。 */
export function questionId(nodeGroupId: string, kind: string, lang: Locale): string {
  return `quiz:${stableHash(`${nodeGroupId}\0${kind}\0${lang}`)}`;
}
