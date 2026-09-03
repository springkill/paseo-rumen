import {
  Icon,
  type PluginAgentPanelProps,
  type PluginClientContext,
  type PluginComposerPillProps,
  useAgent,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { agentImpactRpc } from "./contracts.shared";
import { Card, Empty, MasteryBar, Metric, Section } from "./ui.client";

function impactKey(hostId: string, agentId: string) { return ["rumen", "agent-impact", hostId, agentId]; }

export function RumenAgentPanel({ theme, host, layout, workspaceId, agentId }: PluginAgentPanelProps) {
  const workspace = useWorkspace(workspaceId, (item) => ({ directory: item.directory, name: item.name }));
  const agent = useAgent(agentId, (item) => ({ title: item.title, status: item.status, provider: item.provider, cwd: item.cwd }));
  const getImpact = useRpc(agentImpactRpc);
  const query = useQuery({
    queryKey: impactKey(host.id, agentId),
    queryFn: () => getImpact({ agentId, workspaceId, cwd: workspace!.directory }),
    enabled: Boolean(workspace?.directory && agent),
    refetchInterval: agent?.status === "running" ? 8_000 : 45_000,
    retry: 0,
  });
  return <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}><ScrollView contentContainerStyle={{ padding: layout.compact ? 12 : 20, gap: 16, paddingBottom: 40 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}><Icon name="BrainCircuit" size={22} color={theme.colors.accent} /><View><Text style={{ color: theme.colors.foreground, fontSize: 21, fontWeight: "900" }}>Agent knowledge impact</Text><Text style={{ color: theme.colors.foregroundMuted }}>{agent?.title ?? agentId} · {agent?.provider ?? "unknown"}</Text></View></View>
    {query.isLoading ? <ActivityIndicator color={theme.colors.accent} /> : null}
    {query.error ? <Card theme={theme}><Text style={{ color: theme.colors.statusDanger }}>{query.error instanceof Error ? query.error.message : String(query.error)}</Text></Card> : null}
    {query.data ? <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Metric label="Touched files" value={query.data.touchedFiles.length} theme={theme} /><Metric label="Touched technologies" value={query.data.touchedTechs.length} theme={theme} /><Metric label="Weak nodes" value={query.data.weakNodes.length} theme={theme} tone={query.data.weakNodes.length ? "warning" : "normal"} /><Metric label="Debt" value={query.data.totalDebt} theme={theme} tone={query.data.totalDebt ? "warning" : "normal"} /></View>
      {query.data.newKnowledge.length ? <Section title="New knowledge" subtitle="Technologies touched without positive mastery evidence." theme={theme}>{query.data.newKnowledge.map((name) => <Card key={name} theme={theme} accent><Text style={{ color: theme.colors.statusWarning, fontWeight: "800" }}>{name}</Text></Card>)}</Section> : null}
      <Section title="Weak knowledge nodes" theme={theme}>{query.data.weakNodes.length ? query.data.weakNodes.map((node) => <Card key={node.id} theme={theme} accent={node.mastery.debt > 0}><Text style={{ color: theme.colors.foreground, fontWeight: "700" }}>{node.title}</Text><Text style={{ color: theme.colors.foregroundMuted }}>{node.summary}</Text><MasteryBar score={node.mastery.score} confidence={node.mastery.confidence} theme={theme} /></Card>) : <Empty text="This Agent has not touched a detected weak knowledge area." theme={theme} />}</Section>
      <Section title="Observed file targets" subtitle="Metadata only; prompts, outputs, patches, and shell commands are not retained." theme={theme}>{query.data.touchedFiles.length ? <Card theme={theme}>{query.data.touchedFiles.map((file) => <Text key={file} selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11 }}>{file}</Text>)}</Card> : <Empty text="No file tool targets were found in the canonical timeline." theme={theme} />}</Section>
    </> : null}
  </ScrollView></View>;
}

function RumenPill({ theme, host, workspaceId, agentId }: PluginComposerPillProps) {
  const workspace = useWorkspace(workspaceId, (item) => item.directory);
  const agent = useAgent(agentId, (item) => ({ status: item.status }));
  const getImpact = useRpc(agentImpactRpc);
  const query = useQuery({
    queryKey: impactKey(host.id, agentId),
    queryFn: () => getImpact({ agentId, workspaceId, cwd: workspace! }),
    enabled: Boolean(workspace),
    refetchInterval: agent?.status === "running" ? 8_000 : 45_000,
    retry: 0,
  });
  const warning = (query.data?.newKnowledge.length ?? 0) > 0 || (query.data?.totalDebt ?? 0) > 0;
  const color = warning ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  const label = query.isLoading ? "Rumen…" : query.error ? "Rumen unavailable" : query.data ? `Rumen · ${query.data.weakNodes.length} weak · ${query.data.totalDebt} debt` : "Rumen";
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
    {query.isFetching && !query.data ? <ActivityIndicator size="small" color={color} /> : <Icon name="BrainCircuit" size={14} color={color} />}
    <Text numberOfLines={1} style={{ color, fontWeight: "700", flexShrink: 1 }}>{label}</Text>
  </View>;
}

export function contributeRumenPills(client: PluginClientContext) {
  const pills = new Map<string, { workspaceId: string; remove(): void }>();
  let active = true;
  function remove(agentId: string) { pills.get(agentId)?.remove(); pills.delete(agentId); }
  function upsert(agent: { id: string; workspaceId?: string; archivedAt?: string | null }) {
    if (!active || !agent.workspaceId || agent.archivedAt) { remove(agent.id); return; }
    const existing = pills.get(agent.id);
    if (existing?.workspaceId === agent.workspaceId) return;
    remove(agent.id);
    const { id: agentId, workspaceId } = agent;
    pills.set(agentId, { workspaceId, remove: client.addComposerPill({
      id: "rumen-knowledge",
      title: "Open Rumen knowledge impact",
      workspaceId,
      agentId,
      Component: RumenPill,
      onPress() { client.openPanel("rumen-agent", { workspaceId, agentId }); },
    }) });
  }
  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "upsert") upsert(update.agent);
    else if ("agentId" in update) remove(update.agentId);
  });
  void client.paseo.agents.list({}).then(({ entries }) => { if (active) for (const entry of entries) upsert(entry.agent); }).catch((error) => console.error("[rumen] failed to seed composer pills", error));
  return () => { active = false; unsubscribe(); for (const item of pills.values()) item.remove(); pills.clear(); };
}
