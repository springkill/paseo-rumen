import { type PluginTheme, type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin";
import { Icon, useToast } from "@getpaseo/plugin/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  dashboardRpc,
  evidenceRpc,
  exportRpc,
  privacyRpc,
  quizAnswerRpc,
  quizNextRpc,
  scanRpc,
  wikiRpc,
  type Dashboard,
  type KnowledgeNode,
  type Technology,
} from "./contracts.shared";
import { Button, Card, Empty, MasteryBar, Metric, Section, Tabs } from "./ui.client";

type Tab = "now" | "tech" | "learn" | "commits" | "settings";

function errorText(value: unknown): string { return value instanceof Error ? value.message : String(value); }

function NodeRow({ node, theme, onRead, onQuiz }: { node: KnowledgeNode; theme: PluginTheme; onRead(node: KnowledgeNode): void; onQuiz(node: KnowledgeNode): void }) {
  return <Card theme={theme} accent={node.mastery.debt > 0}>
    <View style={{ flexDirection: "row", gap: 10, justifyContent: "space-between" }}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "700" }}>{node.title}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{node.summary}</Text>
        {node.prerequisites.length ? <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>Prerequisites: {node.prerequisites.length}</Text> : null}
      </View>
      <MasteryBar score={node.mastery.score} confidence={node.mastery.confidence} theme={theme} />
    </View>
    <View style={{ flexDirection: "row", gap: 7, flexWrap: "wrap" }}>
      <Button label="Mark read" theme={theme} subtle onPress={() => onRead(node)} />
      <Button label="Quiz me" theme={theme} subtle onPress={() => onQuiz(node)} />
      {node.mastery.debt ? <Text style={{ color: theme.colors.statusWarning, alignSelf: "center", fontSize: 12 }}>Debt {node.mastery.debt}</Text> : null}
    </View>
  </Card>;
}

function TechRow({ technology, theme, selected, onPress }: { technology: Technology; theme: PluginTheme; selected: boolean; onPress(): void }) {
  return <Pressable accessibilityRole="button" onPress={onPress} style={{ padding: 11, borderRadius: 11, borderWidth: 1, borderColor: selected ? theme.colors.accent : theme.colors.border, backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1, gap: 7 }}>
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "800" }}>{technology.name}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{technology.category}{technology.version ? ` · ${technology.version}` : ""} · confidence {Math.round(technology.confidence * 100)}%</Text>
      </View>
      <Text style={{ color: technology.mastery.debt ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 12 }}>debt {technology.mastery.debt}</Text>
    </View>
    <MasteryBar score={technology.mastery.score} confidence={technology.mastery.confidence} theme={theme} />
  </Pressable>;
}

function QuizBox({ tech, workspaceId, cwd, theme, onChanged }: { tech: Technology; workspaceId: string; cwd: string; theme: PluginTheme; onChanged(): void }) {
  const nextQuiz = useRpc(quizNextRpc);
  const answerQuiz = useRpc(quizAnswerRpc);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const question = useQuery({
    queryKey: ["rumen", "quiz", workspaceId, tech.id],
    queryFn: () => nextQuiz({ workspaceId, cwd, techId: tech.id }),
    enabled: false,
    retry: 0,
  });
  const submit = useMutation({
    mutationFn: () => answerQuiz({ workspaceId, cwd, questionId: question.data!.id, answer }),
    onSuccess: (value) => {
      setResult(`${value.passed ? "Passed" : "Keep learning"} · score ${Math.round(value.score * 100)}% · ${value.feedback}`);
      setAnswer("");
      onChanged();
    },
  });
  return <Section title="Knowledge check" subtitle="Objective local grading; no answer key is sent to the client." theme={theme} action={<Button label={question.isFetching ? "Loading…" : "New question"} theme={theme} subtle disabled={question.isFetching} onPress={() => void question.refetch()} />}>
    {question.error ? <Text style={{ color: theme.colors.statusDanger }}>{errorText(question.error)}</Text> : null}
    {question.data ? <Card theme={theme}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "700" }}>{question.data.nodeTitle}</Text>
      <Text style={{ color: theme.colors.foreground }}>{question.data.prompt}</Text>
      <TextInput multiline value={answer} onChangeText={setAnswer} placeholder="Explain what you understand…" placeholderTextColor={theme.colors.foregroundMuted} style={{ minHeight: 96, color: theme.colors.foreground, backgroundColor: theme.colors.surface0, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 9, padding: 10, textAlignVertical: "top" }} />
      <Button label={submit.isPending ? "Grading…" : "Submit answer"} theme={theme} disabled={!answer.trim() || submit.isPending} onPress={() => submit.mutate()} />
      {submit.error ? <Text style={{ color: theme.colors.statusDanger }}>{errorText(submit.error)}</Text> : null}
      {result ? <Text style={{ color: result.startsWith("Passed") ? theme.colors.statusSuccess : theme.colors.statusWarning }}>{result}</Text> : null}
    </Card> : <Empty text="Generate a question when you are ready." theme={theme} />}
  </Section>;
}

function WikiBox({ tech, workspaceId, cwd, theme, onRead }: { tech: Technology; workspaceId: string; cwd: string; theme: PluginTheme; onRead(node: KnowledgeNode): void }) {
  const getWiki = useRpc(wikiRpc);
  const wiki = useQuery({ queryKey: ["rumen", "wiki", workspaceId, tech.id], queryFn: () => getWiki({ workspaceId, cwd, techId: tech.id, force: false }), retry: 0 });
  return <Section title={`Wiki · ${tech.name}`} subtitle="Local project-aware guide. Version-specific facts should still be checked against official documentation." theme={theme}>
    {wiki.isLoading ? <ActivityIndicator color={theme.colors.accent} /> : null}
    {wiki.error ? <Text style={{ color: theme.colors.statusDanger }}>{errorText(wiki.error)}</Text> : null}
    {wiki.data ? <>
      <Card theme={theme}>
        <Text selectable style={{ color: theme.colors.foreground, lineHeight: 20 }}>{wiki.data.body}</Text>
      </Card>
      <Section title="In this workspace" subtitle={`${wiki.data.anchors.length} evidence anchors`} theme={theme}>
        {wiki.data.anchors.slice(0, 20).map((anchor) => <Card key={`${anchor.file}:${anchor.line}`} theme={theme}>
          <Text selectable style={{ color: theme.colors.accent, fontFamily: "monospace", fontSize: 11 }}>{anchor.file}:{anchor.line}</Text>
          <Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11 }}>{anchor.snippet}</Text>
        </Card>)}
      </Section>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
        {tech.nodes.map((node) => <Button key={node.id} label={`Read: ${node.title}`} theme={theme} subtle onPress={() => onRead(node)} />)}
      </View>
    </> : null}
  </Section>;
}

export function RumenWorkspacePanel({ theme, host, layout, workspaceId }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, (item) => ({ name: item.name, directory: item.directory, projectDisplayName: item.projectDisplayName }));
  const getDashboard = useRpc(dashboardRpc);
  const scanWorkspace = useRpc(scanRpc);
  const setPrivacy = useRpc(privacyRpc);
  const addEvidence = useRpc(evidenceRpc);
  const exportKnowledge = useRpc(exportRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("now");
  const [selectedTech, setSelectedTech] = useState<string | null>(null);
  const cwd = workspace?.directory ?? "";
  const key = ["rumen", "dashboard", host.id, workspaceId];
  const dashboard = useQuery({ queryKey: key, queryFn: () => getDashboard({ workspaceId, cwd }), enabled: Boolean(cwd), retry: 0, staleTime: 30_000 });
  const scan = useMutation({ mutationFn: () => scanWorkspace({ workspaceId, cwd }), onSuccess: (value) => { queryClient.setQueryData(key, value); toast.show("Workspace scan complete", { variant: "success" }); }, onError: (error) => toast.error(errorText(error)) });
  const privacy = useMutation({ mutationFn: (value: "public" | "private" | "airgapped") => setPrivacy({ workspaceId, cwd, privacy: value }), onSuccess: () => void dashboard.refetch() });
  const evidence = useMutation({ mutationFn: (node: KnowledgeNode) => addEvidence({ workspaceId, cwd, nodeId: node.id, kind: "wiki_read" }), onSuccess: () => { toast.show("Reading evidence recorded", { variant: "success" }); void dashboard.refetch(); } });
  const exportMutation = useMutation({ mutationFn: () => exportKnowledge({}), onSuccess: (value) => toast.show(`Exported ${value.records} records to ${value.path}`, { variant: "success", durationMs: 5000 }), onError: (error) => toast.error(errorText(error)) });
  const data = dashboard.data;
  const selected = data?.technologies.find((item) => item.id === selectedTech) ?? null;
  const styles = useMemo(() => ({ screen: { flex: 1, backgroundColor: theme.colors.surface0 }, content: { padding: layout.compact ? 12 : 20, gap: 16, paddingBottom: 40 } }), [theme, layout.compact]);

  if (!workspace) return <View style={styles.screen}><Empty text="Workspace is unavailable." theme={theme} /></View>;
  return <View style={styles.screen}>
    <ScrollView contentContainerStyle={styles.content}>
      <View style={{ flexDirection: layout.compact ? "column" : "row", justifyContent: "space-between", alignItems: layout.compact ? "stretch" : "center", gap: 10 }}>
        <View style={{ gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Icon name="BrainCircuit" size={22} color={theme.colors.accent} /><Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "900" }}>Rumen</Text></View>
          <Text style={{ color: theme.colors.foregroundMuted }}>{workspace.projectDisplayName || workspace.name} · local knowledge layer</Text>
        </View>
        <Button label={scan.isPending ? "Scanning…" : "Scan workspace"} theme={theme} disabled={scan.isPending} onPress={() => scan.mutate()} />
      </View>
      <Tabs items={[{ id: "now", label: "Now" }, { id: "tech", label: "Stack" }, { id: "learn", label: "Learn" }, { id: "commits", label: "Commits" }, { id: "settings", label: "Settings" }]} active={tab} onChange={(value) => { setTab(value); setSelectedTech(null); }} theme={theme} />
      {dashboard.isLoading ? <View style={{ padding: 30, gap: 8, alignItems: "center" }}><ActivityIndicator color={theme.colors.accent} /><Text style={{ color: theme.colors.foregroundMuted }}>Building the first workspace knowledge snapshot…</Text></View> : null}
      {dashboard.error ? <Card theme={theme}><Text style={{ color: theme.colors.statusDanger }}>{errorText(dashboard.error)}</Text><Button label="Try again" theme={theme} subtle onPress={() => void dashboard.refetch()} /></Card> : null}
      {data && tab === "now" ? <NowView data={data} theme={theme} onOpenTech={(id) => { setSelectedTech(id); setTab("tech"); }} /> : null}
      {data && tab === "tech" ? selected ? <View style={{ gap: 16 }}><Button label="Back to technology stack" theme={theme} subtle onPress={() => setSelectedTech(null)} /><WikiBox tech={selected} workspaceId={workspaceId} cwd={cwd} theme={theme} onRead={(node) => evidence.mutate(node)} /><QuizBox tech={selected} workspaceId={workspaceId} cwd={cwd} theme={theme} onChanged={() => void dashboard.refetch()} /></View> : <TechView data={data} theme={theme} onSelect={setSelectedTech} /> : null}
      {data && tab === "learn" ? <LearnView data={data} theme={theme} onRead={(node) => evidence.mutate(node)} onQuiz={(node) => { setSelectedTech(node.techId); setTab("tech"); }} /> : null}
      {data && tab === "commits" ? <CommitsView data={data} theme={theme} /> : null}
      {data && tab === "settings" ? <SettingsView data={data} theme={theme} privacyPending={privacy.isPending} onPrivacy={(value) => privacy.mutate(value)} onExport={() => exportMutation.mutate()} exportPending={exportMutation.isPending} /> : null}
    </ScrollView>
  </View>;
}

function NowView({ data, theme, onOpenTech }: { data: Dashboard; theme: PluginTheme; onOpenTech(id: string): void }) {
  const weak = data.technologies.filter((item) => item.mastery.score < 60 && item.worthLearning !== false).slice(0, 8);
  return <View style={{ gap: 16 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Metric label="Technologies" value={data.project.techCount} theme={theme} />
      <Metric label="Average mastery" value={`${Math.round(data.project.averageMastery)}%`} theme={theme} tone="accent" />
      <Metric label="Knowledge debt" value={data.project.totalDebt} theme={theme} tone={data.project.totalDebt ? "warning" : "normal"} />
      <Metric label="Ready to learn" value={data.readyNodes.length} theme={theme} />
    </View>
    <Section title="What deserves attention" subtitle="Technologies used here where positive evidence is still weak." theme={theme}>
      {weak.length ? weak.map((item) => <TechRow key={item.id} technology={item} theme={theme} selected={false} onPress={() => onOpenTech(item.id)} />) : <Empty text="No weak technology is currently detected." theme={theme} />}
    </Section>
    <Section title="Next knowledge nodes" theme={theme}>
      {data.readyNodes.slice(0, 6).map((node) => <Card key={node.id} theme={theme}><Text style={{ color: theme.colors.foreground, fontWeight: "700" }}>{node.title}</Text><Text style={{ color: theme.colors.foregroundMuted }}>{node.summary}</Text></Card>)}
    </Section>
  </View>;
}

function TechView({ data, theme, onSelect }: { data: Dashboard; theme: PluginTheme; onSelect(id: string): void }) {
  const groups = new Map<string, Technology[]>();
  for (const item of data.technologies) groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
  return <View style={{ gap: 16 }}>{[...groups.entries()].map(([category, items]) => <Section key={category} title={category} subtitle={`${items.length} detected`} theme={theme}>{items.map((item) => <TechRow key={item.id} technology={item} theme={theme} selected={false} onPress={() => onSelect(item.id)} />)}</Section>)}</View>;
}

function LearnView({ data, theme, onRead, onQuiz }: { data: Dashboard; theme: PluginTheme; onRead(node: KnowledgeNode): void; onQuiz(node: KnowledgeNode): void }) {
  const debt = data.technologies.flatMap((technology) => technology.nodes).filter((node) => node.mastery.debt > 0 && !node.mastery.grasped).sort((a, b) => b.mastery.debt - a.mastery.debt);
  return <View style={{ gap: 16 }}>
    {debt.length ? <Section title="Knowledge debt" subtitle="Agent-written areas without positive review evidence." theme={theme}>{debt.slice(0, 20).map((node) => <NodeRow key={node.id} node={node} theme={theme} onRead={onRead} onQuiz={onQuiz} />)}</Section> : null}
    <Section title="Ready to learn" subtitle="Ordered by prerequisites, difficulty, and current mastery." theme={theme}>{data.readyNodes.length ? data.readyNodes.map((node) => <NodeRow key={node.id} node={node} theme={theme} onRead={onRead} onQuiz={onQuiz} />) : <Empty text="No pending knowledge nodes." theme={theme} />}</Section>
  </View>;
}

function CommitsView({ data, theme }: { data: Dashboard; theme: PluginTheme }) {
  return <Section title="Commit knowledge timeline" subtitle="Git facts and conservative authorship signals; unknown is not treated as human or agent." theme={theme}>{data.commits.length ? data.commits.map((commit) => <Card key={commit.sha} theme={theme} accent={commit.knowledgeDebt > 0}>
    <View style={{ flexDirection: "row", gap: 10, justifyContent: "space-between" }}><View style={{ flex: 1 }}><Text style={{ color: theme.colors.foreground, fontWeight: "700" }}>{commit.subject}</Text><Text style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11 }}>{commit.sha.slice(0, 8)} · +{commit.insertions}/−{commit.deletions} · {commit.filesChanged} files</Text></View><Text style={{ color: commit.authorship === "agent" ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 11 }}>{commit.authorship} {Math.round(commit.confidence * 100)}%</Text></View>
    {commit.touchedTechs.length ? <Text style={{ color: theme.colors.foregroundMuted }}>Touches {commit.touchedTechs.join(", ")}</Text> : null}
    {commit.knowledgeDebt ? <Text style={{ color: theme.colors.statusWarning }}>Potential knowledge debt: {commit.knowledgeDebt} nodes</Text> : null}
  </Card>) : <Empty text="No Git commit history is available." theme={theme} />}</Section>;
}

function SettingsView({ data, theme, privacyPending, onPrivacy, onExport, exportPending }: { data: Dashboard; theme: PluginTheme; privacyPending: boolean; onPrivacy(value: "public" | "private" | "airgapped"): void; onExport(): void; exportPending: boolean }) {
  return <View style={{ gap: 16 }}>
    <Section title="Privacy" subtitle="Private is the default. Airgapped prevents future external generation adapters from sending project data." theme={theme}><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>{(["public", "private", "airgapped"] as const).map((value) => <Button key={value} label={`${data.project.privacy === value ? "✓ " : ""}${value}`} theme={theme} subtle={data.project.privacy !== value} disabled={privacyPending} onPress={() => onPrivacy(value)} />)}</View></Section>
    <Section title="Local data" subtitle="Rumen state stays on this Paseo host. Export is redacted JSONL and excludes paths and snippets." theme={theme}><Card theme={theme}><Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 11 }}>{data.project.root}</Text><Text style={{ color: theme.colors.foregroundMuted }}>Last scan: {data.project.lastScanAt ? new Date(data.project.lastScanAt).toLocaleString() : "never"}{data.project.truncated ? " · scan truncated" : ""}</Text><Button label={exportPending ? "Exporting…" : "Export knowledge snapshot"} theme={theme} disabled={exportPending} onPress={onExport} /></Card></Section>
  </View>;
}
