/**
 * 还债：读 agent 写的代码。
 *
 * ⭐ **这是整个产品的核心闭环。** agent 写了、你没读 → 记一笔知识债，掌握度不涨；
 * 你真的读过 → `agent_wrote_reviewed` 证据（权重 0.4），债还掉。
 *
 * 两条产品判断写在交互里：
 *
 * 1. **不展开就不给标记。** 标记的是"我读懂了"，不是"我知道有这回事"。
 *    一个点两下就能清空的债务列表，等于没有债务列表。
 * 2. **代码只在本地读。** 还债要看的是真实文件内容，它一个字都不出这台机器。
 */

import { type PluginTheme, useRpc } from "@getpaseo/plugin";
import { useToast } from "@getpaseo/plugin/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import {
  markReviewedRpc,
  reviewSourceRpc,
  type ReviewItem,
} from "./contracts.shared";
import { relativeTime, type Translator } from "./i18n.shared";
import { Button, Card, Empty, MasteryBar, Mono, Pill, Row, Section } from "./ui.client";

function SourceView({ workspaceId, cwd, clientLocale, reviewId, theme, t }: {
  workspaceId: string;
  cwd: string;
  clientLocale: string | undefined;
  reviewId: string;
  theme: PluginTheme;
  t: Translator;
}) {
  const getSource = useRpc(reviewSourceRpc);
  const query = useQuery({
    queryKey: ["rumen", "review-source", workspaceId, reviewId],
    queryFn: () => getSource({ workspaceId, cwd, clientLocale, reviewId }),
    retry: 0,
    staleTime: 30_000,
  });

  if (query.isLoading) return <ActivityIndicator color={theme.colors.accent} />;
  if (query.error || !query.data?.available) {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{t.review_diff_unavailable}</Text>;
  }
  const anchors = new Set(query.data.anchorLines);
  return (
    <ScrollView
      horizontal={false}
      style={{ maxHeight: 320, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 8 }}
    >
      {query.data.lines.map((line) => (
        <View key={line.line} style={{ flexDirection: "row", gap: 8, backgroundColor: anchors.has(line.line) ? theme.colors.surface2 : "transparent" }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 10, minWidth: 34, textAlign: "right" }}>
            {line.line}
          </Text>
          <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 10, flex: 1 }}>
            {line.text}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

function ReviewCard({ review, workspaceId, cwd, clientLocale, theme, t, now, onMark, marking }: {
  review: ReviewItem;
  workspaceId: string;
  cwd: string;
  clientLocale: string | undefined;
  theme: PluginTheme;
  t: Translator;
  now: number;
  onMark(id: string): void;
  marking: boolean;
}) {
  const [open, setOpen] = useState(false);
  // ⭐ 展开过才允许标记。这条不是防作弊，是让"我读懂了"这个动作对得上它的含义
  const [read, setRead] = useState(false);

  return (
    <Card theme={theme} accent={!review.reviewedAt}>
      <Row
        theme={theme}
        left={
          <View style={{ gap: 3 }}>
            <Mono text={review.file} theme={theme} color={theme.colors.foreground} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {t.review_agent_wrote(review.agentId.slice(0, 8), relativeTime(t, review.observedAt, now))}
            </Text>
          </View>
        }
        right={review.reviewedAt ? <Pill text={t.review_marked} theme={theme} tone="success" /> : null}
      />

      {review.nodes.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t.review_touched_nodes}</Text>
          {review.nodes.slice(0, 4).map((node) => (
            <Row
              key={node.groupId}
              theme={theme}
              left={<Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12 }}>{node.title}</Text>}
              right={<MasteryBar score={node.mastery.score} debt={node.mastery.debt} theme={theme} t={t} />}
            />
          ))}
        </View>
      ) : null}

      <View style={{ flexDirection: "row", gap: 7, flexWrap: "wrap" }}>
        <Button
          label={open ? t.action_collapse_diff : t.action_expand_diff}
          icon={open ? "ChevronUp" : "Code"}
          theme={theme}
          subtle
          onPress={() => {
            setOpen((value) => !value);
            setRead(true);
          }}
        />
        {!review.reviewedAt ? (
          <Button
            label={t.action_mark_reviewed}
            icon="Check"
            theme={theme}
            disabled={!read || marking}
            onPress={() => onMark(review.id)}
          />
        ) : null}
        {!read && !review.reviewedAt ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, alignSelf: "center" }}>
            {t.review_read_first}
          </Text>
        ) : null}
      </View>

      {open ? (
        <SourceView
          workspaceId={workspaceId}
          cwd={cwd}
          clientLocale={clientLocale}
          reviewId={review.id}
          theme={theme}
          t={t}
        />
      ) : null}
    </Card>
  );
}

export function ReviewView({ reviews, workspaceId, cwd, clientLocale, theme, t, onChanged }: {
  reviews: ReviewItem[];
  workspaceId: string;
  cwd: string;
  clientLocale: string | undefined;
  theme: PluginTheme;
  t: Translator;
  onChanged(): void;
}) {
  const markDone = useRpc(markReviewedRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = Date.now();

  const mark = useMutation({
    mutationFn: (reviewId: string) => markDone({ workspaceId, cwd, clientLocale, reviewId }),
    onSuccess() {
      toast.show(t.review_marked, { variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["rumen"] });
      onChanged();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  return (
    <Section
      title={t.review_title}
      subtitle={t.review_subtitle}
      theme={theme}
      action={reviews.length ? <Pill text={t.review_pending(reviews.length)} theme={theme} tone="warning" /> : undefined}
    >
      {reviews.length === 0 ? (
        <Empty text={t.review_empty} theme={theme} />
      ) : (
        <View style={{ gap: 10 }}>
          {reviews.map((review) => (
            <ReviewCard
              key={review.id}
              review={review}
              workspaceId={workspaceId}
              cwd={cwd}
              clientLocale={clientLocale}
              theme={theme}
              t={t}
              now={now}
              marking={mark.isPending}
              onMark={(id) => mark.mutate(id)}
            />
          ))}
        </View>
      )}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>
        {t.agent_observation_only_when_open}
      </Text>
    </Section>
  );
}
