/**
 * Agent 面板：这个 agent 给你留下了多少知识债。
 *
 * 持久的可见入口是左侧栏的 Rumen 项；这里是"就地看一眼"的补充 ——
 * 你正在看这个 agent 的时间线，顺手看看它碰了什么你不懂的东西，
 * 并且可以当场把债还掉。
 */

import { type PluginAgentPanelProps, useRpc, useWorkspace } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { bucketLabel } from "./buckets.shared";
import { agentImpactRpc } from "./contracts.shared";
import { ReviewView } from "./review.client";
import {
  Card,
  Empty,
  ErrorCard,
  MasteryBar,
  Metric,
  Mono,
  Pill,
  Row,
  Section,
  StatusDot,
  useLocale,
} from "./ui.client";

export function RumenAgentPanel({ theme, host, layout, workspaceId, agentId }: PluginAgentPanelProps) {
  const { t, clientLocale, locale } = useLocale(host.id);
  const workspace = useWorkspace(workspaceId, (item) => ({ directory: item.directory }));
  const cwd = workspace?.directory ?? "";
  const getImpact = useRpc(agentImpactRpc);

  const query = useQuery({
    queryKey: ["rumen", "agent-impact", host.id, agentId, locale],
    queryFn: () => getImpact({ workspaceId, cwd, clientLocale, agentId }),
    enabled: Boolean(cwd),
    retry: 0,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const data = query.data;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView contentContainerStyle={{ padding: layout.compact ? 12 : 18, gap: 16, paddingBottom: 40 }}>
        <View style={{ gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {data ? <StatusDot bucket={data.bucket} theme={theme} /> : null}
            <Text style={{ color: theme.colors.foreground, fontSize: 19, fontWeight: "900" }}>{t.agent_panel_title}</Text>
          </View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{t.agent_panel_subtitle}</Text>
        </View>

        {query.isLoading ? <ActivityIndicator color={theme.colors.accent} /> : null}
        {query.error ? <ErrorCard error={query.error} theme={theme} t={t} onRetry={() => void query.refetch()} /> : null}

        {data
          ? (
            <>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <Metric label={t.bucket_running} value={bucketLabel(data.bucket, t)} theme={theme} />
                <Metric label={t.metric_debt} value={data.totalDebt} theme={theme} tone={data.totalDebt ? "warning" : "normal"} />
                <Metric label={t.metric_unreviewed} value={data.reviews.length} theme={theme} tone={data.reviews.length ? "warning" : "normal"} />
              </View>

              {/* ⭐ 唯一有资格打断你的信号：出现了项目里从没见过的依赖 */}
              {data.newKnowledge.length > 0
                ? (
                  <Card theme={theme} accent>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                      <StatusDot bucket="new_knowledge" theme={theme} />
                      <Text style={{ color: theme.colors.statusWarning, fontWeight: "800" }}>
                        {t.now_new_knowledge(data.newKnowledge.length)}
                      </Text>
                    </View>
                    <Mono text={data.newKnowledge.join(", ")} theme={theme} />
                  </Card>
                )
                : null}

              {data.touchedFiles.length === 0
                ? <Empty text={t.agent_no_impact} theme={theme} />
                : (
                  <Section
                    title={t.agent_touched_files(data.touchedFiles.length)}
                    subtitle={data.touchedTechs.length ? t.commits_touches(data.touchedTechs.join(", ")) : undefined}
                    theme={theme}
                  >
                    <Card theme={theme}>
                      {data.touchedFiles.slice(-14).map((file) => <Mono key={file} text={file} theme={theme} />)}
                    </Card>
                  </Section>
                )}

              {data.weakNodes.length > 0
                ? (
                  <Section title={t.learn_debt_title} subtitle={t.learn_debt_subtitle} theme={theme}>
                    {data.weakNodes.slice(0, 10).map((node) => (
                      <Card key={node.groupId} theme={theme} accent={node.mastery.debt > 0}>
                        <Row
                          theme={theme}
                          left={
                            <View style={{ gap: 2 }}>
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <Text style={{ color: theme.colors.foreground, fontWeight: "700" }}>{node.title}</Text>
                                {node.origin === "fallback" ? <Pill text={t.wiki_absent} theme={theme} /> : null}
                              </View>
                              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{node.techName}</Text>
                            </View>
                          }
                          right={<MasteryBar score={node.mastery.score} debt={node.mastery.debt} theme={theme} t={t} />}
                        />
                      </Card>
                    ))}
                  </Section>
                )
                : null}

              {/* 就地还债：不用切到 workspace 面板去 */}
              <ReviewView
                reviews={data.reviews}
                target={{ workspaceId, cwd }}
                clientLocale={clientLocale}
                theme={theme}
                t={t}
                onChanged={() => void query.refetch()}
              />
            </>
          )
          : null}
      </ScrollView>
    </View>
  );
}
