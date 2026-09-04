/**
 * L4：把待归类的依赖交给 agent 并到概念层。
 *
 * ## 结构上就不可能"发明技术"
 *
 * L4 的输入是**扫描已经检出的包名集合**，输出被限制成对这些包的重映射。
 * 任何不在输入集合里的 `pkg` 一律丢弃。也就是说 L4 只能给已有的检测结果改标签，
 * 永远不能加出一条项目里根本不存在的技术 —— 这比在 prompt 里写"不要编造"可靠得多。
 *
 * ## 为什么要批量
 *
 * 一次 trivial 的 agent 调用固定开销就不小，大头是系统提示。一个包问一次的话，
 * 归类 400 个待定项的成本会离谱。批量之后是几次调用的事。
 *
 * ## 隐私
 *
 * prompt 里只有**包名和生态**，没有项目名、没有路径、没有代码。
 * 所以它对 `private` 项目也是安全的；只有 `airgapped` 要完全禁掉。
 */

import type { PaseoApi } from "@getpaseo/client";
import { runStructured } from "./agentrun.server";
import type { LearnedAlias, PendingPackage, TechCategory } from "../domain/techmap.shared";
import { isTechCategory, TECH_CATEGORIES } from "../domain/techmap.shared";

/** 一批多少个。太大模型容易漏项、输出被截断；太小失去批量的意义。 */
export const BATCH_SIZE = 40;

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    classifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pkg: { type: "string" },
          tech_id: { type: "string" },
          display_name: { type: "string" },
          category: { type: "string", enum: [...TECH_CATEGORIES] },
          worth_learning: { type: "boolean" },
          confidence: { type: "number" },
        },
        required: ["pkg", "tech_id", "display_name", "category", "worth_learning", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["classifications"],
  additionalProperties: false,
};

function prompt(batch: readonly PendingPackage[]): string {
  const lines = batch.map((item) => `- ${item.pkg} (${item.ecosystem}${item.version ? `, ${item.version}` : ""})`);
  return `You are normalizing software dependencies into concept-level technology entities for a learning tool.

For each package below, decide which *concept* it belongs to. Different packages across
ecosystems that are the same concept MUST get the same tech_id — for example
\`ioredis\` (npm), \`redis-py\` (pypi) and \`spring-data-redis\` (maven) all map to \`tech:redis\`.

Rules, in priority order:
1. Output one entry per input package, using the package name EXACTLY as given in \`pkg\`.
   Never output a package that is not in the list.
2. \`tech_id\` must be \`tech:<lowercase-kebab-slug>\` naming the concept, not the package.
   A package that IS its own concept maps to a slug of itself (\`tokio\` -> \`tech:tokio\`).
3. \`category\` is one of: ${TECH_CATEGORIES.join(", ")}.
4. \`worth_learning\` is false for things whose marginal knowledge value is low:
   formatters, linters, type stubs, polyfills, build glue, trivial utility wrappers.
   It is NOT a judgement of importance — Prettier is useful and still false.
5. \`confidence\` in [0,1]. Use below 0.5 when you do not actually recognize the package;
   do not guess a plausible-sounding concept for a package you do not know.

Packages:
${lines.join("\n")}

Return only a JSON object with a \`classifications\` array.`;
}

interface RawItem {
  pkg: string;
  tech_id: string;
  display_name: string;
  category: string;
  worth_learning: boolean;
  confidence: number;
}

/**
 * 归类一批待定包。
 *
 * 返回可落库的 alias。**低置信度的归到 `techId: null`** —— 那是"我不认识这个包"，
 * 压住它比瞎归一个概念好：瞎归会让技术栈列表里出现一个用户根本没用过的东西，
 * 而那正是这个产品最不能有的东西。
 */
export async function classifyPending(input: {
  paseo: PaseoApi;
  cwd: string;
  provider: string | null;
  deferToUserAgents: boolean;
  /** 默认 `user` —— 目前所有生成都是用户点按钮触发的。 */
  initiator?: "user" | "background";
  pending: readonly PendingPackage[];
  now?: number;
  runId: string;
  onAgent?: (agentId: string) => void;
}): Promise<LearnedAlias[]> {
  const now = input.now ?? Date.now();
  const out: LearnedAlias[] = [];

  for (let offset = 0; offset < input.pending.length; offset += BATCH_SIZE) {
    const batch = input.pending.slice(offset, offset + BATCH_SIZE);
    const allowed = new Map(batch.map((item) => [item.pkg.toLowerCase(), item]));

    const { value: items } = await runStructured<RawItem[]>({
      paseo: input.paseo,
      task: "classify",
      runId: `${input.runId}-${offset}`,
      onAgent: input.onAgent,
      prompt: prompt(batch),
      schema: SCHEMA,
      cwd: input.cwd,
      provider: input.provider,
      timeoutMs: 300_000,
      initiator: input.initiator ?? "user",
    deferToUserAgents: input.deferToUserAgents,
      validate(value) {
        const record = value as { classifications?: unknown };
        if (!Array.isArray(record.classifications)) throw new Error("missing classifications array");
        const parsed: RawItem[] = [];
        for (const raw of record.classifications) {
          if (!raw || typeof raw !== "object") continue;
          const item = raw as Partial<RawItem>;
          if (typeof item.pkg !== "string") continue;
          // ⭐ 回指校验：不在输入集合里的一律丢弃
          if (!allowed.has(item.pkg.toLowerCase())) continue;
          if (typeof item.tech_id !== "string" || !/^tech:[a-z0-9][a-z0-9-]*$/.test(item.tech_id)) continue;
          if (typeof item.display_name !== "string" || !item.display_name.trim()) continue;
          if (typeof item.category !== "string" || !isTechCategory(item.category)) continue;
          if (typeof item.worth_learning !== "boolean") continue;
          if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence)) continue;
          parsed.push(item as RawItem);
        }
        if (parsed.length === 0) throw new Error("no classification survived validation");
        return parsed;
      },
    });

    const seen = new Set<string>();
    for (const item of items) {
      const original = allowed.get(item.pkg.toLowerCase());
      if (!original || seen.has(original.pkg.toLowerCase())) continue;
      seen.add(original.pkg.toLowerCase());
      const confident = item.confidence >= 0.5;
      out.push({
        pkg: original.pkg.toLowerCase(),
        ecosystem: original.ecosystem,
        techId: confident ? item.tech_id : null,
        name: item.display_name.trim().slice(0, 80),
        category: item.category as TechCategory,
        worthLearning: confident ? item.worth_learning : false,
        confidence: Math.max(0, Math.min(1, item.confidence)),
        learnedAt: now,
      });
    }
    // 这一批里模型没提到的包也要压住，否则每次扫描都会重新问一遍同一批
    for (const item of batch) {
      if (seen.has(item.pkg.toLowerCase())) continue;
      out.push({
        pkg: item.pkg.toLowerCase(),
        ecosystem: item.ecosystem,
        techId: null,
        name: item.pkg,
        category: "unknown",
        worthLearning: false,
        confidence: 0,
        learnedAt: now,
      });
    }
  }
  return out;
}
