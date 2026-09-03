import type { PluginContext, PluginTimelineData } from "@getpaseo/plugin";
import { RumenAgentPanel } from "./agent.client";
import {
  agentImpactRpc,
  attachmentSearchRpc,
  classifyRpc,
  commitsRpc,
  dashboardRpc,
  evidenceRpc,
  exportRpc,
  generateWikiRpc,
  markReviewedRpc,
  overviewRpc,
  privacyRpc,
  quizAnswerRpc,
  quizNextRpc,
  reviewSourceRpc,
  reviewsRpc,
  rumenAttachmentSource,
  scanRpc,
  settingsRpc,
  TimelineImpactSchema,
  updateSettingsRpc,
  wikiRpc,
} from "./contracts.shared";
import { resolveLocale, translator } from "./i18n.shared";
import { MainSurface } from "./main.client";
import {
  answerQuiz,
  classify,
  exportKnowledge,
  generateWikiFor,
  getAgentImpact,
  getDashboard,
  getReviewSource,
  getSettings,
  getWiki,
  listCommits,
  listReviews,
  markReviewDone,
  nextQuiz,
  overview,
  recordEvidence,
  scan,
  searchAttachments,
  setPrivacy,
  updateSettings,
} from "./service.server";
import { RumenTimelineCard } from "./timeline.client";
import { parseTimelineImpact } from "./timeline.shared";
import { RumenWorkspacePanel } from "./workspace.client";

function timelineData(value: unknown): PluginTimelineData {
  return JSON.parse(JSON.stringify(value)) as PluginTimelineData;
}

export default function contribute(plugin: PluginContext) {
  // 命令面板的标题在插件注册时就固定下来了 —— 那时还没有客户端可问，
  // 所以只能按宿主机环境判定。面板内部的文案走完整的优先级链（见 i18n.shared）。
  const t = translator(resolveLocale({ env: process.env }));

  plugin.handle(dashboardRpc, getDashboard);
  plugin.handle(scanRpc, scan);
  plugin.handle(classifyRpc, classify);
  plugin.handle(privacyRpc, setPrivacy);
  plugin.handle(evidenceRpc, recordEvidence);
  plugin.handle(wikiRpc, getWiki);
  plugin.handle(generateWikiRpc, generateWikiFor);
  plugin.handle(quizNextRpc, nextQuiz);
  plugin.handle(quizAnswerRpc, answerQuiz);
  plugin.handle(commitsRpc, listCommits);
  plugin.handle(reviewsRpc, listReviews);
  plugin.handle(reviewSourceRpc, getReviewSource);
  plugin.handle(markReviewedRpc, markReviewDone);
  plugin.handle(agentImpactRpc, getAgentImpact);
  plugin.handle(overviewRpc, overview);
  plugin.handle(settingsRpc, getSettings);
  plugin.handle(updateSettingsRpc, updateSettings);
  plugin.handle(exportRpc, exportKnowledge);
  plugin.handle(attachmentSearchRpc, searchAttachments);

  plugin.addSurface("rumen", MainSurface);
  plugin.addSidebarItem({ id: "rumen", title: "Rumen", icon: "BrainCircuit", surface: "rumen" });

  plugin.addWorkspacePanel({
    id: "rumen-workspace",
    title: "Rumen",
    icon: "BrainCircuit",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: RumenWorkspacePanel,
  });
  plugin.addWorkspacePanel({
    id: "rumen-agent",
    title: t.agent_panel_title,
    icon: "ScanSearch",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: RumenAgentPanel,
  });

  plugin.addCommandCenterItem({
    id: "open-rumen",
    title: t.nav_open_knowledge,
    icon: "BrainCircuit",
    keywords: ["rumen", "learn", "mastery", "knowledge", "学习", "掌握度", "知识"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("rumen");
    },
  });
  plugin.addCommandCenterItem({
    id: "open-rumen-workspace",
    title: t.nav_open_workspace,
    icon: "BrainCircuit",
    keywords: ["rumen", "stack", "learn", "wiki", "quiz", "commits", "技术栈", "知识点"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("rumen-workspace");
    },
  });
  plugin.addCommandCenterItem({
    id: "scan-rumen-workspace",
    title: t.nav_scan_workspace,
    icon: "ScanSearch",
    keywords: ["rumen", "scan", "detect", "dependencies", "扫描", "依赖"],
    context: "workspace",
    async onSelect({ workspace, rpc, openPanel }) {
      openPanel("rumen-workspace");
      await rpc(scanRpc, { workspaceId: workspace.id, cwd: workspace.directory });
    },
  });
  plugin.addCommandCenterItem({
    id: "rumen-review-debt",
    title: t.nav_review_debt,
    icon: "BookOpenCheck",
    keywords: ["rumen", "review", "debt", "还债", "审阅", "知识债"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("rumen-workspace");
    },
  });
  plugin.addCommandCenterItem({
    id: "open-rumen-agent",
    title: t.nav_open_agent,
    icon: "ScanSearch",
    keywords: ["rumen", "agent", "debt", "impact", "知识债", "影响"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("rumen-agent");
    },
  });

  plugin.addTimelineTransformer({
    id: "rumen-code-impact",
    query: { itemType: "tool_call" },
    transform({ item }) {
      const impact = parseTimelineImpact(item);
      if (!impact) return;
      return {
        items: [{ type: "plugin", kind: "rumen-code-impact", version: 1, data: timelineData(impact) }],
      };
    },
  });
  plugin.addTimelineRenderer({
    kind: "rumen-code-impact",
    version: 1,
    schema: TimelineImpactSchema,
    Component: RumenTimelineCard,
  });
  plugin.addAttachmentSource(rumenAttachmentSource);

  return () => {};
}
