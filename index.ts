import type { PluginContext, PluginTimelineData } from "@getpaseo/plugin";
import { RumenAgentPanel } from "./agent.client";
import {
  agentImpactRpc,
  attachmentSearchRpc,
  commitsRpc,
  dashboardRpc,
  evidenceRpc,
  exportRpc,
  overviewRpc,
  privacyRpc,
  quizAnswerRpc,
  quizNextRpc,
  rumenAttachmentSource,
  scanRpc,
  TimelineImpactSchema,
  wikiRpc,
} from "./contracts.shared";
import { MainSurface } from "./main.client";
import {
  answerQuiz,
  exportKnowledge,
  getAgentImpact,
  getDashboard,
  getWiki,
  listCommits,
  nextQuiz,
  overview,
  recordEvidence,
  scan,
  searchAttachments,
  setPrivacy,
} from "./service.server";
import { RumenTimelineCard } from "./timeline.client";
import { parseTimelineImpact } from "./timeline.shared";
import { RumenWorkspacePanel } from "./workspace.client";

function timelineData(value: unknown): PluginTimelineData {
  return JSON.parse(JSON.stringify(value)) as PluginTimelineData;
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(dashboardRpc, getDashboard);
  plugin.handle(scanRpc, scan);
  plugin.handle(privacyRpc, setPrivacy);
  plugin.handle(evidenceRpc, recordEvidence);
  plugin.handle(wikiRpc, getWiki);
  plugin.handle(quizNextRpc, nextQuiz);
  plugin.handle(quizAnswerRpc, answerQuiz);
  plugin.handle(commitsRpc, listCommits);
  plugin.handle(agentImpactRpc, getAgentImpact);
  plugin.handle(overviewRpc, overview);
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
    title: "Rumen Impact",
    icon: "ScanSearch",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: RumenAgentPanel,
  });

  plugin.addCommandCenterItem({
    id: "open-rumen",
    title: "Open Rumen knowledge",
    icon: "BrainCircuit",
    keywords: ["learn", "mastery", "knowledge"],
    context: "global",
    onSelect({ openSurface }) { openSurface("rumen"); },
  });
  plugin.addCommandCenterItem({
    id: "open-rumen-workspace",
    title: "Open Rumen for workspace",
    icon: "BrainCircuit",
    keywords: ["stack", "learn", "wiki", "quiz", "commits"],
    context: "workspace",
    onSelect({ openPanel }) { openPanel("rumen-workspace"); },
  });
  plugin.addCommandCenterItem({
    id: "scan-rumen-workspace",
    title: "Rumen: Scan workspace",
    icon: "ScanSearch",
    keywords: ["detect", "dependencies", "technology"],
    context: "workspace",
    async onSelect({ workspace, rpc, openPanel }) {
      await rpc(scanRpc, { workspaceId: workspace.id, cwd: workspace.directory });
      openPanel("rumen-workspace");
    },
  });
  plugin.addCommandCenterItem({
    id: "open-rumen-agent",
    title: "Open Agent knowledge impact",
    icon: "ScanSearch",
    keywords: ["agent", "debt", "learning"],
    context: "agent",
    onSelect({ openPanel }) { openPanel("rumen-agent"); },
  });

  plugin.addTimelineTransformer({
    id: "rumen-code-impact",
    query: { itemType: "tool_call" },
    transform({ item }) {
      const impact = parseTimelineImpact(item);
      if (!impact) return;
      return { items: [{ type: "plugin", kind: "rumen-code-impact", version: 1, data: timelineData(impact) }] };
    },
  });
  plugin.addTimelineRenderer({ kind: "rumen-code-impact", version: 1, schema: TimelineImpactSchema, Component: RumenTimelineCard });
  plugin.addAttachmentSource(rumenAttachmentSource);

  return () => {};
}
