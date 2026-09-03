/**
 * 全局 Rumen 界面：list + detail。
 *
 * 点一个项目**就在这里展开它的详情**，不跳出去。
 *
 * ⚠️ 早先这里点一行是 `navigation.openWorkspace()` —— 那会跳到 Paseo 的对话窗口，
 * 于是"点进去什么都和 Rumen 没关系"。项目列表 → 项目详情属于壳 A（list + detail），
 * 它整个就该在这个 surface 里完成。跳去别的界面是导航，不是详情。
 */

import { Icon, type PluginSurfaceProps, useRpc } from "@getpaseo/plugin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { dashboardRpc, overviewRpc, type ProjectSummary, type RumenTarget } from "./contracts.shared";
import { relativeTime } from "./i18n.shared";
import {
  Button,
  Card,
  Empty,
  ErrorCard,
  IdentityDot,
  MasteryBar,
  Metric,
  Mono,
  Pill,
  Row,
  Section,
  StatusDot,
  useLocale,
} from "./ui.client";
import { ProjectBody, ScanButton, type ViewContext } from "./views.client";

// ── 详情 ────────────────────────────────────────────────────────────

function ProjectDetail({ project, view, settings, hostId, navigation, onBack, onLocaleChanged }: {
  project: ProjectSummary;
  view: ViewContext;
  settings: ReturnType<typeof useLocale>["settings"];
  hostId: string;
  navigation: PluginSurfaceProps["navigation"];
  onBack(): void;
  onLocaleChanged(): void;
}) {
  const { theme, t, clientLocale, locale } = view;
  const getDashboard = useRpc(dashboardRpc);
  const queryClient = useQueryClient();
  const key = ["rumen", "dashboard", hostId, project.id, locale];

  const dashboard = useQuery({
    queryKey: key,
    queryFn: () => getDashboard({ projectId: project.id, clientLocale }),
    retry: 0,
    staleTime: 20_000,
  });
  const data = dashboard.data;

  return (
    <View style={{ gap: 16 }}>
      <Button label={t.detail_back} icon="ChevronLeft" theme={theme} subtle onPress={onBack} />

      <View style={{ flexDirection: view.compact ? "column" : "row", justifyContent: "space-between", gap: 10, alignItems: view.compact ? "stretch" : "center" }}>
        <View style={{ gap: 3, flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <IdentityDot color={project.color} size={12} />
            <Text style={{ color: theme.colors.foreground, fontSize: 21, fontWeight: "900" }}>{project.name}</Text>
            <StatusDot bucket={project.bucket} theme={theme} size={7} />
          </View>
          <Mono text={project.root} theme={theme} />
        </View>
        <View style={{ flexDirection: "row", gap: 7, flexWrap: "wrap" }}>
          <ScanButton view={view} onScanned={(value) => queryClient.setQueryData(key, value)} />
          {navigation && project.workspaceId
            ? (
              <Button
                label={t.detail_open_workspace}
                icon="ExternalLink"
                theme={theme}
                subtle
                onPress={() => navigation.openWorkspace({ workspaceId: project.workspaceId })}
              />
            )
            : null}
        </View>
      </View>

      {dashboard.isLoading ? <ActivityIndicator color={theme.colors.accent} /> : null}
      {dashboard.error ? <ErrorCard error={dashboard.error} theme={theme} t={t} onRetry={() => void dashboard.refetch()} /> : null}

      {data
        ? (
          <ProjectBody
            data={data}
            view={view}
            settings={settings}
            onRefetch={() => void dashboard.refetch()}
            onLocaleChanged={onLocaleChanged}
          />
        )
        : null}
    </View>
  );
}

// ── 列表 ────────────────────────────────────────────────────────────

export function MainSurface({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const { t, clientLocale, locale, settings, refetch: refetchLocale } = useLocale(host.id);
  const getOverview = useRpc(overviewRpc);
  const [selected, setSelected] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["rumen", "overview", host.id, locale],
    queryFn: () => getOverview({ clientLocale }),
    refetchInterval: selected ? false : 60_000,
    retry: 0,
  });
  const now = Date.now();
  const project = query.data?.projects.find((item) => item.id === selected) ?? null;

  const view: ViewContext = {
    target: { projectId: selected ?? "" } as RumenTarget,
    clientLocale,
    locale,
    theme,
    t,
    compact: layout.compact,
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView contentContainerStyle={{ padding: layout.compact ? 12 : 22, gap: 18, paddingBottom: 48 }}>
        {project
          ? (
            <ProjectDetail
              project={project}
              view={view}
              settings={settings}
              hostId={host.id}
              navigation={navigation}
              onBack={() => setSelected(null)}
              onLocaleChanged={refetchLocale}
            />
          )
          : (
            <>
              <View style={{ gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
                  <Icon name="BrainCircuit" size={26} color={theme.colors.accent} />
                  <Text style={{ color: theme.colors.foreground, fontSize: 25, fontWeight: "900" }}>{t.app_name}</Text>
                </View>
                <Text style={{ color: theme.colors.foregroundMuted, lineHeight: 20 }}>{t.app_tagline}</Text>
              </View>

              {query.isLoading ? <ActivityIndicator color={theme.colors.accent} /> : null}
              {query.error ? <ErrorCard error={query.error} theme={theme} t={t} onRetry={() => void query.refetch()} /> : null}

              {query.data
                ? (
                  <>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      <Metric label={t.metric_projects} value={query.data.projects.length} theme={theme} />
                      <Metric label={t.metric_technologies} value={query.data.totalTechnologies} theme={theme} />
                      <Metric
                        label={t.metric_nodes_grasped}
                        value={`${query.data.graspedNodes}/${query.data.totalNodes}`}
                        theme={theme}
                        tone="accent"
                      />
                      <Metric
                        label={t.metric_debt}
                        value={query.data.totalDebt}
                        theme={theme}
                        tone={query.data.totalDebt ? "warning" : "normal"}
                      />
                      <Metric
                        label={t.metric_unreviewed}
                        value={query.data.unreviewedCount}
                        theme={theme}
                        tone={query.data.unreviewedCount ? "warning" : "normal"}
                      />
                    </View>

                    <Section title={t.label_projects} subtitle={t.projects_subtitle} theme={theme}>
                      {query.data.projects.length
                        ? query.data.projects.map((item) => (
                          <Card
                            key={item.id}
                            theme={theme}
                            accent={item.unreviewedCount > 0}
                            onPress={() => setSelected(item.id)}
                          >
                            <Row
                              theme={theme}
                              chevron
                              left={
                                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                                  {/* 身份色只回答"这是哪个项目"，不参与排序 */}
                                  <View style={{ marginTop: 4 }}><IdentityDot color={item.color} /></View>
                                  <View style={{ flex: 1, gap: 2 }}>
                                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                                      <Text style={{ color: theme.colors.foreground, fontWeight: "800", fontSize: 15 }}>
                                        {item.name}
                                      </Text>
                                      <StatusDot bucket={item.bucket} theme={theme} size={7} />
                                    </View>
                                    <Mono text={item.root} theme={theme} />
                                  </View>
                                </View>
                              }
                              right={<MasteryBar score={item.averageMastery} debt={item.totalDebt} theme={theme} t={t} />}
                            />
                            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                                {t.project_tech_count(item.techCount)} ·{" "}
                                {item.lastScanAt
                                  ? t.project_last_scan(relativeTime(t, item.lastScanAt, now))
                                  : t.project_last_scan(t.label_never)}
                              </Text>
                              {item.unreviewedCount
                                ? <Pill text={t.review_pending(item.unreviewedCount)} theme={theme} tone="warning" />
                                : null}
                              {item.truncated ? <Pill text={t.project_scan_truncated} theme={theme} tone="warning" /> : null}
                            </View>
                          </Card>
                        ))
                        : <Empty text={t.projects_empty} theme={theme} />}
                    </Section>
                  </>
                )
                : null}
            </>
          )}
      </ScrollView>
    </View>
  );
}
