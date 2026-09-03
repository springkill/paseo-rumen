/**
 * 全局 surface：跨项目的知识总览。
 *
 * 这一屏回答"我整体上欠了多少知识债"。具体到某个项目的操作全在 workspace 面板里 ——
 * 这里只做导航，不做第二套操作入口。
 */

import { Icon, type PluginSurfaceProps, useRpc } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { overviewRpc } from "./contracts.shared";
import { relativeTime } from "./i18n.shared";
import {
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

export function MainSurface({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const { t, clientLocale, locale } = useLocale(host.id);
  const getOverview = useRpc(overviewRpc);
  const query = useQuery({
    queryKey: ["rumen", "overview", host.id, locale],
    queryFn: () => getOverview({ clientLocale }),
    refetchInterval: 60_000,
    retry: 0,
  });
  const now = Date.now();

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView contentContainerStyle={{ padding: layout.compact ? 12 : 22, gap: 18, paddingBottom: 48 }}>
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
                  ? query.data.projects.map((project) => (
                    <Card
                      key={project.id}
                      theme={theme}
                      accent={project.unreviewedCount > 0}
                      onPress={navigation && project.workspaceId
                        ? () => navigation.openWorkspace({ workspaceId: project.workspaceId })
                        : undefined}
                    >
                      <Row
                        theme={theme}
                        chevron={Boolean(navigation && project.workspaceId)}
                        left={
                          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                            {/* 身份色只回答"这是哪个项目"，不参与排序 */}
                            <View style={{ marginTop: 4 }}><IdentityDot color={project.color} /></View>
                            <View style={{ flex: 1, gap: 2 }}>
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                                <Text style={{ color: theme.colors.foreground, fontWeight: "800", fontSize: 15 }}>
                                  {project.name}
                                </Text>
                                <StatusDot bucket={project.bucket} theme={theme} size={7} />
                              </View>
                              <Mono text={project.root} theme={theme} />
                            </View>
                          </View>
                        }
                        right={
                          <MasteryBar
                            score={project.averageMastery}
                            debt={project.totalDebt}
                            theme={theme}
                            t={t}
                          />
                        }
                      />
                      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                          {t.project_tech_count(project.techCount)} ·{" "}
                          {project.lastScanAt
                            ? t.project_last_scan(relativeTime(t, project.lastScanAt, now))
                            : t.project_last_scan(t.label_never)}
                        </Text>
                        {project.unreviewedCount
                          ? <Pill text={t.review_pending(project.unreviewedCount)} theme={theme} tone="warning" />
                          : null}
                        {project.truncated ? <Pill text={t.project_scan_truncated} theme={theme} tone="warning" /> : null}
                      </View>
                    </Card>
                  ))
                  : <Empty text={t.projects_empty} theme={theme} />}
              </Section>
            </>
          )
          : null}
      </ScrollView>
    </View>
  );
}
