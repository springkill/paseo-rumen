/**
 * 界面文案的本地化。
 *
 * ## 完整性靠类型检查，不靠对账脚本
 *
 * fluent / gettext 那一套的完整性靠运行期查表 + 外部脚本捞漏译：漏了程序照跑，
 * 只显示一个 key。这里换个路子 —— 每条文案的所有语言写在同一个对象字面量里，
 * 由 `satisfies Catalog` 约束：
 *
 * - 漏一种语言 → 缺少必需属性 → `tsc --noEmit` 失败
 * - 占位符引用了不存在的参数 → 模板字面量里找不到变量 → 编译失败
 * - 参数类型不对 → 编译失败
 *
 * 代价是不能在运行期热加载语言包。对一个插件来说这个代价是零。
 *
 * ## ⭐ 界面语言 ≠ 内容语言
 *
 * 这里管的只有**界面文案**（标签、按钮、错误消息）。wiki 正文、知识点标题、
 * 检验题题面是 agent 生成的**内容**，它们的语言由存储里的 `lang` 维度承载。
 * 两件事混起来必然做错：界面切语言是零成本的查表，内容切语言要重新调一次
 * agent、要花钱。**界面是 en 而内容只有 zh 是预期行为，不是 bug。**
 */

export const LOCALES = ["zh", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** 每条文案必须给全所有语言，缺一个就编译不过。 */
type Message = { readonly [L in Locale]: string };
type Entry = Message | ((...args: never[]) => Message);
type Catalog = Readonly<Record<string, Entry>>;

/**
 * 解析 BCP-47 / POSIX 风格的语言标签。
 *
 * `zh_CN.UTF-8`、`zh-Hans`、`zh`、`en_US` 都认。
 * `C` / `POSIX` 不是语言 —— 它们等同于「没设置」，返回 null 让上游继续往下找。
 */
export function localeFromTag(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const head = tag.split(/[.@]/)[0]?.replace(/_/g, "-").toLowerCase();
  const language = head?.split("-")[0];
  if (language === "zh") return "zh";
  if (language === "en") return "en";
  return null;
}

/**
 * 界面语言判定。
 *
 * 优先级：`RUMEN_LANG` > 用户设置 > 客户端语言 > 宿主机 `LC_ALL`/`LC_MESSAGES`/`LANG` > 英文。
 *
 * ⭐ **用户设置压过环境变量，但压不过 `RUMEN_LANG`。**
 * `LANG` 是环境在*告诉*我们这台机器习惯什么语言 —— 那是推断；
 * 设置页上点出来的是用户的*决定*。推断不该盖过决定，否则用户把界面设成英文，
 * 换个终端又变回中文，而他找不到是谁改的。`RUMEN_LANG` 同样显式，
 * 且只作用于这一个进程（作用域更窄），所以排在最前。
 *
 * ⭐ **客户端语言排在宿主机环境之前。** Paseo 可以从手机或浏览器访问，
 * 那时看界面的人和跑 daemon 的机器不是同一个。谁在看就跟谁走。
 *
 * 认不出来一律退到英文 —— 对一个国际化的工具，
 * 「认不出来就说英文」比「认不出来就说中文」更不容易让人卡住。
 */
export function resolveLocale(input: {
  env?: Record<string, string | undefined>;
  saved?: string | null;
  clientHint?: string | null;
}): Locale {
  const env = input.env ?? {};
  const forced = localeFromTag(env.RUMEN_LANG);
  if (forced) return forced;
  const saved = localeFromTag(input.saved);
  if (saved) return saved;
  const hinted = localeFromTag(input.clientHint);
  if (hinted) return hinted;
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const fromEnv = localeFromTag(env[key]);
    if (fromEnv) return fromEnv;
  }
  return "en";
}

/**
 * 文案表。
 *
 * ## 术语表（强制，代码标识符与 UI 文案一一对应）
 *
 * | 概念 | UI 中文 | 代码标识符 | 禁用 |
 * |---|---|---|---|
 * | 技术栈实体 | 技术栈 | `TechEntity` | 技术、栈、tech stack 混用 |
 * | 具体依赖包 | 依赖 | `Package` | 库、组件 |
 * | 知识点 | 知识点 | `KnowledgeNode` | 知识、概念、节点 |
 * | 掌握度 | 掌握度 | `Mastery` | 熟练度、进度、学习进度 |
 * | 证据 | 证据 | `Evidence` | 记录、日志 |
 * | 知识债 | 知识债 | `KnowledgeDebt` | 待学、欠账 |
 * | 绑定的仓库 | 项目 | `Project` | 仓库、repo、工程 |
 * | 会话 vs agent | 会话是历史条目；agent 是活体 | `Session` / `Agent` | 两者混用 |
 *
 * ## 文案规范
 *
 * 英文沿用 Paseo 的原规则（sentence case / 无尾句号 / 按钮祈使 /
 * 进行时用字面三点省略号 / 错误直陈不道歉）。中文是等价改写：
 *
 * - 标签、行标题、按钮**不加句号**：`重新生成 Wiki` 而不是 `重新生成 Wiki。`
 * - 按钮用动词短语：`扫描项目` 而不是 `项目扫描`
 * - 进行中用「…中」：`生成中…` 而不是 `正在努力生成`
 * - 空状态是短名词短语：`暂无项目` 而不是 `这里空空如也，去绑定一个吧！`
 * - 错误直陈状态不道歉：`无法读取 git 仓库` 而不是 `抱歉，我们没能读取您的仓库`
 * - 多句正文才有句号
 */
const CATALOG = {
  // ── 品牌与总览 ──────────────────────────────────────────────────
  app_name: { zh: "Rumen", en: "Rumen" },
  app_tagline: {
    zh: "你的 agent 改了什么，以及你还有什么没弄懂",
    en: "What your agents changed, and what you still need to understand",
  },
  nav_open_knowledge: { zh: "打开 Rumen 知识层", en: "Open Rumen knowledge" },
  nav_open_workspace: { zh: "打开本项目的 Rumen", en: "Open Rumen for this workspace" },
  nav_scan_workspace: { zh: "Rumen：扫描项目", en: "Rumen: Scan workspace" },
  nav_open_agent: { zh: "打开 agent 知识影响", en: "Open agent knowledge impact" },
  nav_review_debt: { zh: "Rumen：审阅 agent 改动", en: "Rumen: Review agent changes" },

  // ── 通用标签 ────────────────────────────────────────────────────
  label_path: { zh: "路径", en: "Path" },
  label_version: { zh: "版本", en: "Version" },
  label_category: { zh: "类别", en: "Category" },
  label_confidence: { zh: "置信度", en: "Confidence" },
  label_mastery: { zh: "掌握度", en: "Mastery" },
  label_debt: { zh: "知识债", en: "Knowledge debt" },
  label_evidence: { zh: "证据", en: "Evidence" },
  label_projects: { zh: "项目", en: "Projects" },
  label_tech_stack: { zh: "技术栈", en: "Tech stack" },
  label_nodes: { zh: "知识点", en: "Concepts" },
  label_never: { zh: "从未", en: "never" },
  label_sources: { zh: "来源", en: "Sources" },
  label_prerequisites: { zh: "前置知识点", en: "Prerequisites" },

  // ── 一级入口 ────────────────────────────────────────────────────
  tab_now: { zh: "现在", en: "Now" },
  tab_stack: { zh: "技术栈", en: "Stack" },
  tab_learn: { zh: "学习", en: "Learn" },
  tab_review: { zh: "还债", en: "Review" },
  tab_commits: { zh: "提交", en: "Commits" },
  tab_settings: { zh: "设置", en: "Settings" },

  // ── 概览指标 ────────────────────────────────────────────────────
  metric_projects: { zh: "项目", en: "Projects" },
  metric_technologies: { zh: "技术栈", en: "Technologies" },
  metric_nodes_grasped: { zh: "已掌握知识点", en: "Concepts grasped" },
  metric_debt: { zh: "知识债", en: "Knowledge debt" },
  metric_avg_mastery: { zh: "平均掌握度", en: "Average mastery" },
  metric_ready: { zh: "可以学了", en: "Ready to learn" },
  metric_unreviewed: { zh: "待审阅改动", en: "Unreviewed changes" },

  // ── 项目 ────────────────────────────────────────────────────────
  projects_empty: {
    zh: "暂无项目\n\n打开一个 workspace，在它的 Rumen 面板里扫描一次",
    en: "No projects yet\n\nOpen a workspace and scan it from its Rumen panel",
  },
  projects_subtitle: {
    zh: "打开某个项目，在它的面板里做扫描、学习、Wiki、检验题和提交分析",
    en: "Open a workspace to scan, learn, read the Wiki, take quizzes, and review commits",
  },
  project_tech_count: (n: number) => ({
    zh: `${n} 个技术栈`,
    en: `${n} technolog${n === 1 ? "y" : "ies"}`,
  }),
  project_last_scan: (when: string) => ({ zh: `上次扫描 ${when}`, en: `Last scan ${when}` }),
  project_identified_by_path: {
    zh: "按路径识别 —— 移动目录后历史会丢失",
    en: "Identified by path; moving the directory loses its history",
  },
  project_scan_truncated: {
    zh: "扫描被截断，结果不完整",
    en: "Scan was truncated; results are incomplete",
  },

  // ── 扫描 ────────────────────────────────────────────────────────
  action_scan: { zh: "扫描项目", en: "Scan workspace" },
  action_scanning: { zh: "扫描中…", en: "Scanning…" },
  scan_complete: { zh: "扫描完成", en: "Scan complete" },
  scan_first_snapshot: {
    zh: "正在建立第一份知识快照…",
    en: "Building the first knowledge snapshot…",
  },
  scan_summary: (curated: number, pending: number) => ({
    zh: `${curated} 个已归类，${pending} 个待归类`,
    en: `${curated} classified, ${pending} pending`,
  }),
  scan_pending_hint: {
    zh: "待归类的依赖还没有并进技术栈实体。归类一次就会合并同类项",
    en: "Pending dependencies are not folded into technology entities yet. Classify to merge them",
  },
  action_classify: { zh: "归类待定依赖", en: "Classify pending dependencies" },
  action_classifying: { zh: "归类中…", en: "Classifying…" },
  classify_done: (merged: number) => ({
    zh: `已归类 ${merged} 个依赖`,
    en: `Classified ${merged} dependenc${merged === 1 ? "y" : "ies"}`,
  }),

  // ── 现在 ────────────────────────────────────────────────────────
  now_attention_title: { zh: "值得注意", en: "What deserves attention" },
  now_attention_subtitle: {
    zh: "本项目用到、但你还没有正面证据的技术栈",
    en: "Technologies used here where positive evidence is still weak",
  },
  now_attention_empty: { zh: "暂无薄弱的技术栈", en: "No weak technology right now" },
  now_next_nodes: { zh: "接下来学什么", en: "Next concepts" },
  now_live_agents: { zh: "正在跑", en: "Running now" },
  now_no_live_agents: { zh: "当前没有 agent 在跑", en: "No agent is running" },
  now_new_knowledge: (n: number) => ({
    zh: `${n} 个没见过的依赖`,
    en: `${n} dependenc${n === 1 ? "y" : "ies"} you have not seen`,
  }),

  // ── 技术栈 ──────────────────────────────────────────────────────
  stack_empty: {
    zh: "暂无技术栈\n\n先扫描一次这个项目",
    en: "No technology detected\n\nScan this workspace first",
  },
  stack_detected: (n: number) => ({ zh: `检出 ${n} 个`, en: `${n} detected` }),
  stack_back: { zh: "返回技术栈", en: "Back to tech stack" },
  detail_back: { zh: "返回项目列表", en: "Back to projects" },
  detail_open_workspace: { zh: "在 Paseo 里打开这个 workspace", en: "Open this workspace in Paseo" },
  detail_no_workspace: {
    zh: "这个项目当前没有关联的 workspace",
    en: "No workspace is currently linked to this project",
  },
  detail_scan_first: {
    zh: "还没扫描过\n\n先扫一次，才知道这个项目用了什么",
    en: "Not scanned yet\n\nScan once to find out what this project uses",
  },
  stack_why: { zh: "凭什么说我用了它", en: "Why this was detected" },
  stack_evidence_count: (n: number) => ({ zh: `${n} 个证据锚点`, en: `${n} evidence anchors` }),
  stack_pending_group: { zh: "待归类", en: "Pending" },

  // ── 学习 ────────────────────────────────────────────────────────
  learn_debt_title: { zh: "知识债", en: "Knowledge debt" },
  learn_debt_subtitle: {
    zh: "agent 改过、而你还没读过的地方",
    en: "Areas an agent wrote that you have not reviewed",
  },
  learn_ready_title: { zh: "可以学了", en: "Ready to learn" },
  learn_ready_subtitle: {
    zh: "按前置知识点、难度和当前掌握度排序",
    en: "Ordered by prerequisites, difficulty, and current mastery",
  },
  learn_ready_empty: { zh: "暂无待学的知识点", en: "No pending concepts" },
  learn_locked: (n: number) => ({
    zh: `还差 ${n} 个前置知识点`,
    en: `${n} prerequisite${n === 1 ? "" : "s"} to go`,
  }),
  action_mark_read: { zh: "标记已读", en: "Mark read" },
  action_quiz_me: { zh: "考我一下", en: "Quiz me" },
  evidence_recorded: { zh: "已记下阅读证据", en: "Reading evidence recorded" },

  // ── 还债（审阅 agent 改动）──────────────────────────────────────
  review_title: { zh: "审阅 agent 的改动", en: "Review agent changes" },
  review_subtitle: {
    zh: "读过 agent 写的代码才算还债。展开读完再标记 —— 标记的是「我读懂了」，不是「我知道有这回事」",
    en: "Debt is paid by reading what the agent wrote. Expand, read, then mark — the mark means you understood it, not that you noticed it",
  },
  review_empty: { zh: "暂无待审阅的改动", en: "Nothing to review" },
  review_pending: (n: number) => ({
    zh: `${n} 处待审阅`,
    en: `${n} change${n === 1 ? "" : "s"} to review`,
  }),
  review_touched_nodes: { zh: "涉及的知识点", en: "Concepts touched" },
  action_expand_diff: { zh: "展开这段改动", en: "Show this change" },
  action_collapse_diff: { zh: "收起", en: "Collapse" },
  action_mark_reviewed: { zh: "我读懂了", en: "I understood this" },
  review_marked: { zh: "已还一笔知识债", en: "Knowledge debt paid down" },
  review_read_first: {
    zh: "先展开读完再标记",
    en: "Expand and read it before marking",
  },
  review_agent_wrote: (agent: string, when: string) => ({
    zh: `${agent} 于 ${when} 改动`,
    en: `${agent} changed this ${when}` ,
  }),
  review_diff_unavailable: {
    zh: "取不到这段改动的内容 —— 文件可能已被后续改动覆盖",
    en: "This change is no longer retrievable; the file may have been overwritten since",
  },

  // ── Wiki ────────────────────────────────────────────────────────
  wiki_title: (name: string) => ({ zh: `Wiki · ${name}`, en: `Wiki · ${name}` }),
  wiki_subtitle: {
    zh: "结合本项目的指南。版本相关的细节仍应对照官方文档核实",
    en: "Project-aware guide. Version-specific details should still be checked against official documentation",
  },
  wiki_absent: {
    zh: "还没有 Wiki",
    en: "No Wiki yet",
  },
  action_generate_wiki: { zh: "生成 Wiki", en: "Generate Wiki" },
  action_regenerate_wiki: { zh: "重新生成 Wiki", en: "Regenerate Wiki" },
  wiki_generating: { zh: "生成中…", en: "Generating…" },
  wiki_generating_hint: {
    zh: "要联网检索并写作，通常一到几分钟。生成一次全局复用，别的项目用到同一个技术栈时是零成本的",
    en: "This searches the web and writes; usually a few minutes. Generated once and reused globally, so other projects using it pay nothing",
  },
  job_running: { zh: "生成中…", en: "Generating…" },
  job_running_detail: (elapsed: string) => ({
    zh: `已跑 ${elapsed}。可以关掉这个面板，跑完了回来看`,
    en: `Running for ${elapsed}. You can close this panel and come back`,
  }),
  job_failed: { zh: "生成失败", en: "Generation failed" },
  job_open_session: { zh: "看看 agent 做了什么", en: "See what the agent did" },
  job_done: { zh: "生成完成", en: "Generation complete" },
  classify_running: { zh: "归类中…", en: "Classifying…" },
  wiki_sourced_ratio: (percent: number) => ({
    zh: `${percent}% 段落可溯源`,
    en: `${percent}% of sections are sourced`,
  }),
  wiki_low_sourced: {
    zh: "可溯源比例偏低，这篇内容不够可信",
    en: "Low sourced ratio; treat this content as unreliable",
  },
  wiki_unsourced_section: { zh: "无出处", en: "unsourced" },
  wiki_in_this_project: { zh: "在本项目里", en: "In this workspace" },
  wiki_content_lang_notice: (contentLang: string, uiLang: string) => ({
    zh: `这篇内容是 ${contentLang} 的，界面是 ${uiLang} 的。换语言生成要重新调一次 agent`,
    en: `This content is in ${contentLang} while the interface is ${uiLang}. Generating another language costs one more agent run`,
  }),
  action_generate_in: (lang: string) => ({
    zh: `生成 ${lang} 版`,
    en: `Generate the ${lang} version`,
  }),

  // ── 检验题 ──────────────────────────────────────────────────────
  quiz_title: { zh: "检验题", en: "Knowledge check" },
  quiz_subtitle_code: {
    zh: "用本项目里的真实代码出题",
    en: "Built from real code in this workspace",
  },
  quiz_subtitle_concept: {
    zh: "概念题 —— 当前隐私级别不允许把代码交给 agent 出题",
    en: "Concept question; the current privacy level keeps project code away from the agent",
  },
  action_new_question: { zh: "出一道题", en: "New question" },
  action_submit_answer: { zh: "提交作答", en: "Submit answer" },
  quiz_grading: { zh: "评分中…", en: "Grading…" },
  quiz_placeholder: { zh: "说说你的理解…", en: "Explain what you understand…" },
  quiz_empty: { zh: "准备好了就出一道题", en: "Generate a question when you are ready" },
  quiz_passed: { zh: "通过", en: "Passed" },
  quiz_failed: { zh: "还差点", en: "Not yet" },
  quiz_result: (verdict: string, percent: number) => ({
    zh: `${verdict} · 得分 ${percent}%`,
    en: `${verdict} · scored ${percent}%`,
  }),
  quiz_graded_locally: {
    zh: "这次是本地关键词判分，比 agent 判分弱得多 —— 通过了也别太当真",
    en: "Graded locally by keyword coverage, which is much weaker than agent grading; treat a pass with caution",
  },

  // ── 提交 ────────────────────────────────────────────────────────
  commits_title: { zh: "提交时间线", en: "Commit timeline" },
  commits_subtitle: {
    zh: "○ 是 agent 写的，● 是你写的。判不出的既不算你写也不算 agent 写，不产生任何证据",
    en: "○ agent-written, ● human-written. Unknown counts as neither and produces no evidence",
  },
  commits_empty: { zh: "暂无 commit 历史", en: "No Git commit history" },
  commits_not_git: {
    zh: "这个项目不是 git 仓库，不做提交分析",
    en: "This project is not a Git repository; commit analysis is unavailable",
  },
  authorship_agent: { zh: "agent 写", en: "agent" },
  authorship_human: { zh: "你写的", en: "human" },
  authorship_mixed: { zh: "混合", en: "mixed" },
  authorship_unknown: { zh: "判不出", en: "unknown" },
  commits_agent_share: (n: number) => ({
    zh: `其中 ${n} 个是 agent 写的 —— 这些是你的知识债`,
    en: `${n} of these were agent-written; that is your knowledge debt`,
  }),
  commits_touches: (names: string) => ({ zh: `涉及 ${names}`, en: `Touches ${names}` }),
  commits_why: { zh: "凭什么这么判", en: "Why this attribution" },

  // ── 设置 ────────────────────────────────────────────────────────
  settings_language: { zh: "界面语言", en: "Interface language" },
  settings_language_subtitle: {
    zh: "只改界面。已生成的 Wiki 和知识点保持原来的语言 —— 换语言看文档不该丢掉学习记录",
    en: "Interface only. Existing Wiki and concepts keep their own language; switching the interface must not lose your learning record",
  },
  settings_language_auto: { zh: "自动", en: "Automatic" },
  settings_language_auto_detail: (resolved: string) => ({
    zh: `跟随环境，当前是 ${resolved}`,
    en: `Follows the environment; currently ${resolved}`,
  }),
  settings_language_forced_by_env: {
    zh: "RUMEN_LANG 已锁定界面语言，设置在此不生效",
    en: "RUMEN_LANG pins the interface language; this setting has no effect",
  },
  lang_name_zh: { zh: "中文", en: "Chinese" },
  lang_name_en: { zh: "English", en: "English" },

  settings_privacy: { zh: "隐私级别", en: "Privacy" },
  settings_privacy_subtitle: {
    zh: "默认 private。airgapped 完全禁止把项目内容交给 agent",
    en: "Private by default. Airgapped forbids handing any project content to an agent",
  },
  privacy_public: { zh: "公开", en: "Public" },
  privacy_private: { zh: "私有", en: "Private" },
  privacy_airgapped: { zh: "物理隔离", en: "Airgapped" },
  privacy_public_detail: {
    zh: "允许抓上游文档与源码作为 Wiki 依据",
    en: "Upstream docs and sources may back the Wiki",
  },
  privacy_private_detail: {
    zh: "代码不出本机；Wiki 只用技术名与版本去检索",
    en: "Code stays local; the Wiki is searched by technology name and version only",
  },
  privacy_airgapped_detail: {
    zh: "完全不调 agent，只有确定性检测",
    en: "No agent calls at all; deterministic detection only",
  },

  settings_generation: { zh: "内容生成", en: "Content generation" },
  settings_generation_subtitle: {
    zh: "Wiki、知识点和检验题由你在 Paseo 里配好的 agent 生成，消耗你自己的额度",
    en: "Wiki, concepts, and quizzes are generated by the agent you configured in Paseo, on your own quota",
  },
  settings_provider: { zh: "生成用的 agent", en: "Agent used for generation" },
  settings_provider_none: {
    zh: "Paseo 里没有可用的 provider",
    en: "No provider is available in Paseo",
  },
  settings_defer_to_user: { zh: "你的 agent 在跑时让路", en: "Yield while your own agents run" },
  settings_defer_detail: {
    zh: "你正在被 agent 服务时不跟你抢配额，也避免触发限流",
    en: "Does not compete for quota or trigger rate limits while an agent is working for you",
  },

  settings_data: { zh: "本地数据", en: "Local data" },
  settings_data_subtitle: {
    zh: "Rumen 的状态只留在这台 Paseo 宿主机上。导出是脱敏 JSONL，不含路径和代码片段",
    en: "Rumen state stays on this Paseo host. Export is redacted JSONL with no paths or snippets",
  },
  action_export: { zh: "导出知识快照", en: "Export knowledge snapshot" },
  action_exporting: { zh: "导出中…", en: "Exporting…" },
  export_done: (records: number, path: string) => ({
    zh: `已导出 ${records} 条到 ${path}`,
    en: `Exported ${records} records to ${path}`,
  }),

  // ── 时间 ────────────────────────────────────────────────────────
  time_just_now: { zh: "刚刚", en: "just now" },
  time_minutes_ago: (n: number) => ({ zh: `${n} 分钟前`, en: `${n}m ago` }),
  time_hours_ago: (n: number) => ({ zh: `${n} 小时前`, en: `${n}h ago` }),
  time_days_ago: (n: number) => ({ zh: `${n} 天前`, en: `${n}d ago` }),

  // ── 状态桶 ──────────────────────────────────────────────────────
  bucket_needs_input: { zh: "等你回应", en: "Needs you" },
  bucket_new_knowledge: { zh: "有新知识点", en: "New concept" },
  bucket_failed: { zh: "失败", en: "Failed" },
  bucket_running: { zh: "运行中", en: "Running" },
  bucket_attention: { zh: "待处理", en: "Attention" },
  bucket_done: { zh: "空闲", en: "Idle" },

  // ── Agent 影响面板 ──────────────────────────────────────────────
  agent_panel_title: { zh: "知识影响", en: "Knowledge impact" },
  agent_panel_subtitle: {
    zh: "这个 agent 碰过的技术栈，以及它留下的知识债",
    en: "Technologies this agent touched, and the knowledge debt it left",
  },
  agent_touched_files: (n: number) => ({
    zh: `碰了 ${n} 个文件`,
    en: `Touched ${n} file${n === 1 ? "" : "s"}`,
  }),
  agent_no_impact: {
    zh: "这个 agent 还没有改动本项目的文件",
    en: "This agent has not changed any file in this workspace",
  },
  agent_observation_only_when_open: {
    zh: "观测只在 Paseo 打开时进行 —— 关掉期间 agent 的改动仍会被 commit 分析兜住",
    en: "Observation runs only while Paseo is open; changes made meanwhile are still caught by commit analysis",
  },

  // ── 时间线卡片 ──────────────────────────────────────────────────
  timeline_manifest_label: { zh: "依赖或基础设施改动", en: "Dependency or infrastructure change" },
  timeline_source_label: { zh: "代码知识点触碰", en: "Code knowledge touch" },
  timeline_manifest_body: {
    zh: "这可能引入新技术栈或改变项目的知识地图。这一轮结束后扫描一次",
    en: "This can introduce new technology or change the knowledge map. Scan after the turn",
  },
  timeline_source_body: {
    zh: "Rumen 会把这个文件对上技术栈证据和你的掌握度",
    en: "Rumen will correlate this file with technology evidence and your mastery",
  },

  // ── 错误 ────────────────────────────────────────────────────────
  err_workspace_unavailable: {
    zh: "这个 workspace 在当前 Paseo 宿主机上不可用",
    en: "Workspace is unavailable on this Paseo host",
  },
  err_workspace_mismatch: {
    zh: "目录与所选的 Paseo workspace 对不上",
    en: "Workspace directory does not match the selected Paseo workspace",
  },
  err_path_not_absolute: { zh: "workspace 目录必须是绝对路径", en: "Workspace directory must be absolute" },
  err_project_unknown: { zh: "找不到这个项目", en: "Unknown project" },
  err_unknown_node: { zh: "找不到这个知识点", en: "Unknown concept" },
  err_node_foreign: {
    zh: "这个知识点不属于当前项目",
    en: "This concept does not belong to this workspace",
  },
  err_tech_absent: { zh: "本项目没有这个技术栈", en: "Technology is not present in this workspace" },
  err_no_nodes: {
    zh: "这个技术栈还没有知识点 —— 先生成一次 Wiki",
    en: "This technology has no concepts yet; generate its Wiki first",
  },
  err_unknown_question: { zh: "找不到这道题", en: "Unknown quiz question" },
  err_quiz_foreign: { zh: "这道题不属于当前项目", en: "Quiz does not belong to this workspace" },
  err_agent_foreign: {
    zh: "这个 agent 不属于所选的 workspace",
    en: "Agent does not belong to the selected workspace",
  },
  err_scan_too_broad: (files: number, path: string) => ({
    zh: `${path} 下有 ${files}+ 个文件，且不是 git 仓库 —— 这看起来不是一个项目。请打开具体的项目目录`,
    en: `${path} holds ${files}+ files and is not a Git repository, so it does not look like a project. Open the project directory itself`,
  }),
  err_scan_home_directory: (path: string) => ({
    zh: `${path} 是家目录或文件系统根 —— 不扫。请打开具体的项目目录`,
    en: `${path} is a home or filesystem root, which is never scanned. Open the project directory itself`,
  }),
  err_airgapped: {
    zh: "这个项目是物理隔离级别，不调用 agent",
    en: "This project is airgapped; no agent is called",
  },
  err_no_provider: {
    zh: "Paseo 里没有可用的 agent provider。先在 Paseo 设置里配一个",
    en: "No agent provider is available in Paseo. Configure one in Paseo settings first",
  },
  err_generation_failed: (detail: string) => ({
    zh: `生成失败：${detail}`,
    en: `Generation failed: ${detail}`,
  }),
  err_generation_busy: {
    zh: "你的 agent 正在跑，生成已让路。等它跑完再试",
    en: "Your own agent is running, so generation yielded. Try again once it finishes",
  },
  err_generation_invalid: {
    zh: "agent 返回的内容无法校验 —— 已丢弃，没有落库",
    en: "The agent returned content that failed validation; it was discarded and not stored",
  },
  err_state_unreadable: (path: string) => ({
    zh: `读不了 Rumen 的状态文件 ${path}。修好权限或还原文件后再写`,
    en: `Rumen state is unreadable at ${path}; fix permissions or restore the file before writing`,
  }),
  err_state_malformed: (path: string) => ({
    zh: `Rumen 的状态文件 ${path} 格式损坏，没有被覆盖`,
    en: `Rumen state is malformed at ${path}; it was not overwritten`,
  }),
  action_retry: { zh: "重试", en: "Try again" },
} as const satisfies Catalog;

export type MessageKey = keyof typeof CATALOG;

/** 全部文案的名字。测试用它遍历，也便于外部工具盘点。 */
export const MESSAGE_KEYS = Object.keys(CATALOG) as MessageKey[];

type Translated<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => Message
    ? (...args: A) => string
    : string;
};

export type Translator = Translated<typeof CATALOG>;

const CACHE = new Map<Locale, Translator>();

/**
 * 取一份某语言的文案表。
 *
 * 调用点长这样：`t.label_mastery` / `t.scan_summary(12, 3)` —— 参数类型与个数
 * 都由 catalog 里的定义推出来，写错了编译不过。
 */
export function translator(locale: Locale): Translator {
  const cached = CACHE.get(locale);
  if (cached) return cached;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(CATALOG)) {
    out[key] = typeof entry === "function"
      ? (...args: never[]) => (entry as (...a: never[]) => Message)(...args)[locale]
      : entry[locale];
  }
  const built = Object.freeze(out) as Translator;
  CACHE.set(locale, built);
  return built;
}

/** 语言自己的名字，用在语言选择器上（永远显示母语名，不翻译）。 */
export const LOCALE_NATIVE_NAME: Record<Locale, string> = { zh: "中文", en: "English" };

/** 相对时间。`now` 显式传入，方便测试。 */
export function relativeTime(t: Translator, at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return t.time_just_now;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t.time_minutes_ago(minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t.time_hours_ago(hours);
  return t.time_days_ago(Math.round(hours / 24));
}
