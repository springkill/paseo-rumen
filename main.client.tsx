import { Icon, type PluginSurfaceProps, useRpc } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { overviewRpc } from "./contracts.shared";
import { Card, Empty, MasteryBar, Metric, Section } from "./ui.client";

export function MainSurface({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const getOverview = useRpc(overviewRpc);
  const query = useQuery({ queryKey: ["rumen", "overview", host.id], queryFn: () => getOverview({}), refetchInterval: 60_000, retry: 0 });
  return <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}><ScrollView contentContainerStyle={{ padding: layout.compact ? 12 : 22, gap: 18, paddingBottom: 48 }}>
    <View style={{ gap: 4 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}><Icon name="BrainCircuit" size={26} color={theme.colors.accent} /><Text style={{ color: theme.colors.foreground, fontSize: 25, fontWeight: "900" }}>Rumen</Text></View><Text style={{ color: theme.colors.foregroundMuted }}>What your coding agents changed, and what you still need to understand.</Text></View>
    {query.isLoading ? <ActivityIndicator color={theme.colors.accent} /> : null}
    {query.error ? <Card theme={theme}><Text style={{ color: theme.colors.statusDanger }}>{query.error instanceof Error ? query.error.message : String(query.error)}</Text></Card> : null}
    {query.data ? <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Metric label="Projects" value={query.data.projects.length} theme={theme} /><Metric label="Technologies" value={query.data.totalTechnologies} theme={theme} /><Metric label="Knowledge nodes" value={`${query.data.graspedNodes}/${query.data.totalNodes}`} theme={theme} tone="accent" /><Metric label="Knowledge debt" value={query.data.totalDebt} theme={theme} tone={query.data.totalDebt ? "warning" : "normal"} /></View>
      <Section title="Projects" subtitle="Open a workspace and use its Rumen panel for scanning, learning, Wiki, quizzes, and commits." theme={theme}>
        {query.data.projects.length ? query.data.projects.map((project) => <Pressable key={project.id} disabled={!navigation || !project.workspaceId} onPress={() => navigation?.openWorkspace({ workspaceId: project.workspaceId })}><Card theme={theme} accent={project.totalDebt > 0}><View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10 }}><View style={{ flex: 1 }}><Text style={{ color: theme.colors.foreground, fontWeight: "800", fontSize: 16 }}>{project.name}</Text><Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 10 }}>{project.root}</Text></View><Text style={{ color: project.totalDebt ? theme.colors.statusWarning : theme.colors.foregroundMuted }}>{project.totalDebt} debt</Text></View><MasteryBar score={project.averageMastery} theme={theme} /><Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{project.techCount} technologies · {project.privacy} · {project.lastScanAt ? new Date(project.lastScanAt).toLocaleString() : "not scanned"}</Text></Card></Pressable>) : <Empty text="Open a workspace and run Rumen Scan to create its knowledge map." theme={theme} />}
      </Section>
    </> : null}
  </ScrollView></View>;
}
