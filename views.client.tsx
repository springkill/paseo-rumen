/**
 * 项目视图：六个一级入口的内容。
 *
 * 这些组件被**两个壳**共用：
 *
 * - workspace 面板（`workspace.client.tsx`）—— 目标是 `{workspaceId, cwd}`
 * - 全局 Rumen 界面的项目详情（`main.client.tsx`）—— 目标是 `{projectId}`
 *
 * 抽出来而不是各写一份：两套实现必然漂移，然后同一个项目在两个地方显示不同的
 * 掌握度，而没人知道哪个是对的。
 */

import { type PluginTheme, useRpc } from "@getpaseo/plugin";
import { useToast } from "@getpaseo/plugin/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { bucketLabel } from "./buckets.shared";
import {
  classifyRpc,
  evidenceRpc,
  exportRpc,
  generateWikiRpc,
  privacyRpc,
  quizAnswerRpc,
  quizNextRpc,
  scanRpc,
  updateSettingsRpc,
  wikiRpc,
  type Dashboard,
  type KnowledgeNode,
  type RumenTarget,
  type Settings,
  type Technology,
} from "./contracts.shared";
import { LOCALES, LOCALE_NATIVE_NAME, relativeTime, type Locale, type Translator } from "./i18n.shared";
import { ReviewView } from "./review.client";
import {
  Button,
  Card,
  Empty,
  ErrorCard,
  MasteryBar,
  Metric,
  Mono,
  Pill,
  Row,
  Section,
  Segmented,
  StatusDot,
  Switch,
  Tabs,
} from "./ui.client";

export type Tab = "now" | "tech" | "learn" | "review" | "commits" | "settings";

export interface ViewContext {
  target: RumenTarget;
  clientLocale: string | undefined;
  locale: Locale;
  theme: PluginTheme;
  t: Translator;
  compact: boolean;
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

// ── 行 ──────────────────────────────────────────────────────────────

function NodeRow({ node, theme, t, onRead, onQuiz }: {
  node: KnowledgeNode;
  theme: PluginTheme;
  t: Translator;
  onRead(node: KnowledgeNode): void;
  onQuiz(node: KnowledgeNode): void;
}) {
  return (
    <Card theme={theme} accent={node.mastery.debt > 0}>
      <Row
        theme={theme}
        left={
          <View style={{ gap: 3 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Text style={{ color: theme.colors.foreground, fontWeight: "700" }}>{node.title}</Text>
              {node.origin === "fallback" ? <Pill text={t.wiki_absent} theme={theme} /> : null}
            </View>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{node.summary}</Text>
            {node.blockedBy > 0
              ? <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>{t.learn_locked(node.blockedBy)}</Text>
              : null}
          </View>
        }
        right={<MasteryBar score={node.mastery.score} confidence={node.mastery.confidence} debt={node.mastery.debt} theme={theme} t={t} />}
      />
      <View style={{ flexDirection: "row", gap: 7, flexWrap: "wrap" }}>
        <Button label={t.action_mark_read} theme={theme} subtle onPress={() => onRead(node)} />
        <Button label={t.action_quiz_me} theme={theme} subtle onPress={() => onQuiz(node)} />
      </View>
    </Card>
  );
}

function TechRow({ technology, theme, t, onPress }: {
  technology: Technology;
  theme: PluginTheme;
  t: Translator;
  onPress(): void;
}) {
  return (
    <Card theme={theme} onPress={onPress}>
      <Row
        theme={theme}
        chevron
        left={
          <View style={{ gap: 3 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
              <Text style={{ color: theme.colors.foreground, fontWeight: "800" }}>{technology.name}</Text>
              {/* 版本贴在名字右边，不是窗口右边 —— 眼睛不用横跨整屏去对行 */}
              {technology.version ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{technology.version}</Text> : null}
              {!technology.worthLearning ? <Pill text="tooling" theme={theme} /> : null}
              {!technology.hasWiki ? <Pill text={t.wiki_absent} theme={theme} /> : null}
            </View>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {t.label_confidence} {Math.round(technology.confidence * 100)}% · {t.stack_evidence_count(technology.evidence.length)}
            </Text>
          </View>
        }
        right={<MasteryBar score={technology.mastery.score} confidence={technology.mastery.confidence} debt={technology.mastery.debt} theme={theme} t={t} />}
      />
    </Card>
  );
}

// ── 现在 ────────────────────────────────────────────────────────────

function NowView({ data, theme, t, onOpenTech, onGoReview }: {
  data: Dashboard;
  theme: PluginTheme;
  t: Translator;
  onOpenTech(id: string): void;
  onGoReview(): void;
}) {
  const weak = data.technologies.filter((item) => item.worthLearning && item.mastery.score < 60).slice(0, 8);
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Metric label={t.metric_technologies} value={data.project.techCount} theme={theme} />
        <Metric label={t.metric_avg_mastery} value={`${Math.round(data.project.averageMastery)}%`} theme={theme} tone="accent" />
        <Metric label={t.metric_debt} value={data.project.totalDebt} theme={theme} tone={data.project.totalDebt ? "warning" : "normal"} />
        <Metric label={t.metric_unreviewed} value={data.project.unreviewedCount} theme={theme} tone={data.project.unreviewedCount ? "warning" : "normal"} />
      </View>

      <Section title={t.now_live_agents} theme={theme}>
        {data.liveAgents.length === 0
          ? <Empty text={t.now_no_live_agents} theme={theme} />
          : data.liveAgents.map((agent) => (
            <Card key={agent.agentId} theme={theme} accent={agent.bucket === "new_knowledge"}>
              <Row
                theme={theme}
                left={
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <StatusDot bucket={agent.bucket} theme={theme} />
                    <View style={{ gap: 2, flex: 1 }}>
                      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontWeight: "700" }}>
                        {agent.title ?? agent.agentId.slice(0, 8)}
                      </Text>
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                        {agent.provider} · {bucketLabel(agent.bucket, t)}
                      </Text>
                    </View>
                  </View>
                }
              />
              {agent.newKnowledge.length > 0 ? (
                <View style={{ gap: 4 }}>
                  <Text style={{ color: theme.colors.statusWarning, fontSize: 12, fontWeight: "700" }}>
                    {t.now_new_knowledge(agent.newKnowledge.length)}
                  </Text>
                  <Mono text={agent.newKnowledge.join(", ")} theme={theme} />
                </View>
              ) : null}
            </Card>
          ))}
      </Section>

      {data.project.unreviewedCount > 0 ? (
        <Card theme={theme} accent onPress={onGoReview}>
          <Row
            theme={theme}
            chevron
            left={
              <View style={{ gap: 2 }}>
                <Text style={{ color: theme.colors.foreground, fontWeight: "800" }}>{t.review_title}</Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  {t.review_pending(data.project.unreviewedCount)}
                </Text>
              </View>
            }
          />
        </Card>
      ) : null}

      <Section title={t.now_attention_title} subtitle={t.now_attention_subtitle} theme={theme}>
        {weak.length
          ? weak.map((item) => <TechRow key={item.id} technology={item} theme={theme} t={t} onPress={() => onOpenTech(item.id)} />)
          : <Empty text={t.now_attention_empty} theme={theme} />}
      </Section>

      {data.readyNodes.length > 0 ? (
        <Section title={t.now_next_nodes} theme={theme}>
          {data.readyNodes.slice(0, 5).map((node) => (
            <Card key={node.groupId} theme={theme}>
              <Text style={{ color: theme.colors.foreground, fontWeight: "700" }}>{node.title}</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{node.summary}</Text>
            </Card>
          ))}
        </Section>
      ) : null}
    </View>
  );
}

// ── 技术栈 ──────────────────────────────────────────────────────────

function TechView({ data, view, onSelect, onClassify, classifying }: {
  data: Dashboard;
  view: ViewContext;
  onSelect(id: string): void;
  onClassify(): void;
  classifying: boolean;
}) {
  const { theme, t } = view;
  const groups = new Map<string, Technology[]>();
  for (const item of data.technologies) {
    groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
  }
  if (data.technologies.length === 0 && data.pending.length === 0) {
    return <Empty text={data.project.lastScanAt ? t.stack_empty : t.detail_scan_first} theme={theme} />;
  }
  return (
    <View style={{ gap: 16 }}>
      {[...groups.entries()].map(([category, items]) => (
        <Section key={category} title={category} subtitle={t.stack_detected(items.length)} theme={theme}>
          {items.map((item) => <TechRow key={item.id} technology={item} theme={theme} t={t} onPress={() => onSelect(item.id)} />)}
        </Section>
      ))}

      {data.pending.length > 0 ? (
        <Section
          title={t.stack_pending_group}
          subtitle={t.scan_pending_hint}
          theme={theme}
          action={data.generation.available
            ? (
              <Button
                label={classifying ? t.action_classifying : t.action_classify}
                theme={theme}
                subtle
                disabled={classifying}
                onPress={onClassify}
              />
            )
            : undefined}
        >
          <Card theme={theme}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
              {data.pending.slice(0, 40).map((item) => item.pkg).join(" · ")}
            </Text>
          </Card>
        </Section>
      ) : null}
    </View>
  );
}

// ── Wiki ────────────────────────────────────────────────────────────

function WikiBox({ tech, view, onRead }: {
  tech: Technology;
  view: ViewContext;
  onRead(node: KnowledgeNode): void;
}) {
  const { target, clientLocale, locale, theme, t } = view;
  const getWiki = useRpc(wikiRpc);
  const generate = useRpc(generateWikiRpc);
  const queryClient = useQueryClient();
  const toast = useToast();

  const wiki = useQuery({
    queryKey: ["rumen", "wiki", tech.id, locale, JSON.stringify(target)],
    queryFn: () => getWiki({ ...target, clientLocale, techId: tech.id, lang: locale }),
    retry: 0,
  });
  const generating = useMutation({
    mutationFn: (lang: Locale) => generate({ ...target, clientLocale, techId: tech.id, lang, force: false }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["rumen"] }),
    onError: (error) => toast.error(errorText(error)),
  });

  const doc = wiki.data;
  return (
    <Section
      title={t.wiki_title(tech.name)}
      subtitle={t.wiki_subtitle}
      theme={theme}
      action={
        <Button
          label={generating.isPending ? t.wiki_generating : doc ? t.action_regenerate_wiki : t.action_generate_wiki}
          theme={theme}
          subtle={Boolean(doc)}
          disabled={generating.isPending}
          onPress={() => generating.mutate(locale)}
        />
      }
    >
      {generating.isPending
        ? (
          <Card theme={theme}>
            <ActivityIndicator color={theme.colors.accent} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{t.wiki_generating_hint}</Text>
          </Card>
        )
        : null}
      {generating.error ? <ErrorCard error={generating.error} theme={theme} t={t} /> : null}
      {wiki.isLoading ? <ActivityIndicator color={theme.colors.accent} /> : null}

      {doc
        ? (
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: "row", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
              <Pill
                text={t.wiki_sourced_ratio(Math.round(doc.sourcedRatio * 100))}
                theme={theme}
                tone={doc.trustworthy ? "success" : "warning"}
              />
              {!doc.trustworthy ? <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>{t.wiki_low_sourced}</Text> : null}
              {doc.lang !== locale
                ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                    {t.wiki_content_lang_notice(LOCALE_NATIVE_NAME[doc.lang], LOCALE_NATIVE_NAME[locale])}
                  </Text>
                )
                : null}
            </View>

            <Card theme={theme}>
              <Text selectable style={{ color: theme.colors.foreground, lineHeight: 21 }}>{doc.summary}</Text>
            </Card>

            {doc.sections.map((section, index) => {
              const unsourced = section.sourceRefs.length === 0;
              return (
                <Card key={`${section.heading}-${index}`} theme={theme}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={{ color: unsourced ? theme.colors.foregroundMuted : theme.colors.foreground, fontWeight: "700" }}>
                      {section.heading}
                    </Text>
                    {/* 挂不上来源的段落灰化 + 角标。不删除，但不可信 */}
                    {unsourced ? <Pill text={t.wiki_unsourced_section} theme={theme} tone="warning" /> : null}
                  </View>
                  <Text selectable style={{ color: unsourced ? theme.colors.foregroundMuted : theme.colors.foreground, lineHeight: 21 }}>
                    {section.body}
                  </Text>
                  {section.sourceRefs.length > 0 ? (
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                      {t.label_sources}: {section.sourceRefs.map((ref) => `[${ref + 1}]`).join(" ")}
                    </Text>
                  ) : null}
                </Card>
              );
            })}

            {doc.sources.length > 0 ? (
              <Section title={t.label_sources} theme={theme}>
                {doc.sources.map((source, index) => (
                  <Card key={source.url} theme={theme}>
                    <Text selectable style={{ color: theme.colors.foreground, fontSize: 12 }}>
                      [{index + 1}] {source.title}
                    </Text>
                    <Mono text={source.url} theme={theme} color={theme.colors.accent} />
                  </Card>
                ))}
              </Section>
            ) : null}
          </View>
        )
        : !generating.isPending ? <Empty text={t.wiki_absent} theme={theme} /> : null}

      <Section title={t.wiki_in_this_project} subtitle={t.stack_evidence_count(tech.evidence.length)} theme={theme}>
        {tech.evidence.slice(0, 15).map((anchor) => (
          <Card key={`${anchor.file}:${anchor.line}`} theme={theme}>
            <Mono text={`${anchor.file}:${anchor.line}`} theme={theme} color={theme.colors.accent} />
            <Mono text={anchor.snippet} theme={theme} />
          </Card>
        ))}
      </Section>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
        {tech.nodes.map((node) => (
          <Button key={node.groupId} label={`${t.action_mark_read} · ${node.title}`} theme={theme} subtle onPress={() => onRead(node)} />
        ))}
      </View>
    </Section>
  );
}

// ── 检验题 ──────────────────────────────────────────────────────────

function QuizBox({ tech, view, codeQuizAllowed, onChanged }: {
  tech: Technology;
  view: ViewContext;
  codeQuizAllowed: boolean;
  onChanged(): void;
}) {
  const { target, clientLocale, theme, t } = view;
  const nextQuiz = useRpc(quizNextRpc);
  const answerQuiz = useRpc(quizAnswerRpc);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<{ passed: boolean; text: string; local: boolean } | null>(null);

  const question = useQuery({
    queryKey: ["rumen", "quiz", tech.id, JSON.stringify(target)],
    queryFn: () => nextQuiz({ ...target, clientLocale, techId: tech.id }),
    enabled: false,
    retry: 0,
  });
  const submit = useMutation({
    mutationFn: () => answerQuiz({ ...target, clientLocale, questionId: question.data!.id, answer }),
    onSuccess(value) {
      setResult({
        passed: value.passed,
        local: value.gradedLocally,
        text: `${t.quiz_result(value.passed ? t.quiz_passed : t.quiz_failed, Math.round(value.score * 100))}${
          value.feedback ? `\n\n${value.feedback}` : ""
        }`,
      });
      setAnswer("");
      onChanged();
    },
  });

  const degraded = question.data?.degraded ?? !codeQuizAllowed;
  return (
    <Section
      title={t.quiz_title}
      subtitle={degraded ? t.quiz_subtitle_concept : t.quiz_subtitle_code}
      theme={theme}
      action={
        <Button
          label={question.isFetching ? t.wiki_generating : t.action_new_question}
          theme={theme}
          subtle
          disabled={question.isFetching}
          onPress={() => {
            setResult(null);
            void question.refetch();
          }}
        />
      }
    >
      {question.error ? <ErrorCard error={question.error} theme={theme} t={t} /> : null}
      {question.data
        ? (
          <Card theme={theme}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{question.data.nodeTitle}</Text>
            <Text selectable style={{ color: theme.colors.foreground, lineHeight: 21 }}>{question.data.prompt}</Text>
            <TextInput
              multiline
              value={answer}
              onChangeText={setAnswer}
              placeholder={t.quiz_placeholder}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                minHeight: 110,
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface0,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 9,
                padding: 10,
                textAlignVertical: "top",
              }}
            />
            <Button
              label={submit.isPending ? t.quiz_grading : t.action_submit_answer}
              theme={theme}
              disabled={!answer.trim() || submit.isPending}
              onPress={() => submit.mutate()}
            />
            {submit.error ? <ErrorCard error={submit.error} theme={theme} t={t} /> : null}
            {result
              ? (
                <View style={{ gap: 5 }}>
                  <Text style={{ color: result.passed ? theme.colors.statusSuccess : theme.colors.statusWarning, lineHeight: 20 }}>
                    {result.text}
                  </Text>
                  {/* 降级判分必须明说 —— 静默降级会让用户高估这次通过的含金量 */}
                  {result.local
                    ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{t.quiz_graded_locally}</Text>
                    : null}
                </View>
              )
              : null}
          </Card>
        )
        : <Empty text={t.quiz_empty} theme={theme} />}
    </Section>
  );
}

// ── 学习 ────────────────────────────────────────────────────────────

function LearnView({ data, theme, t, onRead, onQuiz }: {
  data: Dashboard;
  theme: PluginTheme;
  t: Translator;
  onRead(node: KnowledgeNode): void;
  onQuiz(node: KnowledgeNode): void;
}) {
  const debt = data.technologies
    .flatMap((technology) => technology.nodes)
    .filter((node) => node.mastery.debt > 0 && !node.mastery.grasped)
    .sort((left, right) => right.mastery.debt - left.mastery.debt);
  return (
    <View style={{ gap: 16 }}>
      {debt.length > 0 ? (
        <Section title={t.learn_debt_title} subtitle={t.learn_debt_subtitle} theme={theme}>
          {debt.slice(0, 20).map((node) => (
            <NodeRow key={node.groupId} node={node} theme={theme} t={t} onRead={onRead} onQuiz={onQuiz} />
          ))}
        </Section>
      ) : null}
      <Section title={t.learn_ready_title} subtitle={t.learn_ready_subtitle} theme={theme}>
        {data.readyNodes.length
          ? data.readyNodes.map((node) => (
            <NodeRow key={node.groupId} node={node} theme={theme} t={t} onRead={onRead} onQuiz={onQuiz} />
          ))
          : <Empty text={t.learn_ready_empty} theme={theme} />}
      </Section>
    </View>
  );
}

// ── 提交 ────────────────────────────────────────────────────────────

function CommitsView({ data, theme, t }: { data: Dashboard; theme: PluginTheme; t: Translator }) {
  const [openSignals, setOpenSignals] = useState<string | null>(null);
  const now = Date.now();
  if (!data.project.isGit) return <Empty text={t.commits_not_git} theme={theme} />;

  const agentCount = data.commits.filter((c) => c.authorship === "agent" || c.authorship === "mixed").length;
  const label = (authorship: string) =>
    authorship === "agent" ? t.authorship_agent
      : authorship === "human" ? t.authorship_human
        : authorship === "mixed" ? t.authorship_mixed
          : t.authorship_unknown;

  return (
    <Section
      title={t.commits_title}
      subtitle={t.commits_subtitle}
      theme={theme}
      action={agentCount ? <Pill text={t.commits_agent_share(agentCount)} theme={theme} tone="warning" /> : undefined}
    >
      {data.commits.length === 0
        ? <Empty text={t.commits_empty} theme={theme} />
        : data.commits.map((commit) => {
          const isAgent = commit.authorship === "agent" || commit.authorship === "mixed";
          return (
            <Card key={commit.sha} theme={theme} accent={commit.knowledgeDebt > 0}>
              <Row
                theme={theme}
                left={
                  <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
                    {/* 人写的实心、agent 写的空心 —— 一眼看出这个项目里有多少代码我其实不懂 */}
                    <View
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: 5,
                        marginTop: 5,
                        borderWidth: 1.5,
                        borderColor: isAgent ? theme.colors.accent : theme.colors.foregroundMuted,
                        backgroundColor: isAgent ? "transparent" : theme.colors.foregroundMuted,
                      }}
                    />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontWeight: "700" }}>{commit.subject}</Text>
                      <Mono
                        text={`${commit.sha.slice(0, 8)} · +${commit.insertions}/−${commit.deletions} · ${commit.filesChanged} · ${relativeTime(t, commit.authoredAt, now)}`}
                        theme={theme}
                      />
                    </View>
                  </View>
                }
                right={
                  <Text style={{ color: isAgent ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 11 }}>
                    {label(commit.authorship)} {Math.round(commit.confidence * 100)}%
                  </Text>
                }
              />
              {commit.touchedTechs.length > 0
                ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{t.commits_touches(commit.touchedTechs.join(", "))}</Text>
                : null}
              {commit.knowledgeDebt > 0
                ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{t.label_debt}: {commit.knowledgeDebt}</Text>
                : null}
              <Pressable onPress={() => setOpenSignals(openSignals === commit.sha ? null : commit.sha)}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t.commits_why}</Text>
              </Pressable>
              {openSignals === commit.sha
                ? (
                  <View style={{ gap: 3, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: theme.colors.border }}>
                    {commit.signals.map((signal, index) => (
                      <Text key={index} style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>· {signal}</Text>
                    ))}
                  </View>
                )
                : null}
            </Card>
          );
        })}
    </Section>
  );
}

// ── 设置 ────────────────────────────────────────────────────────────

function SettingsView({ data, settings, view, onLocaleChanged }: {
  data: Dashboard;
  settings: Settings | undefined;
  view: ViewContext;
  onLocaleChanged(): void;
}) {
  const { target, clientLocale, theme, t } = view;
  const setPrivacy = useRpc(privacyRpc);
  const update = useRpc(updateSettingsRpc);
  const exportKnowledge = useRpc(exportRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = Date.now();

  const privacy = useMutation({
    mutationFn: (value: "public" | "private" | "airgapped") => setPrivacy({ ...target, clientLocale, privacy: value }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["rumen"] }),
    onError: (error) => toast.error(errorText(error)),
  });
  const settingsMutation = useMutation({
    mutationFn: (patch: { locale?: "auto" | Locale; deferToUserAgents?: boolean; provider?: string | null }) =>
      update({ clientLocale, ...patch }),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["rumen"] });
      onLocaleChanged();
    },
    onError: (error) => toast.error(errorText(error)),
  });
  const exportMutation = useMutation({
    mutationFn: () => exportKnowledge({ clientLocale }),
    onSuccess: (value) => toast.show(t.export_done(value.records, value.path), { variant: "success", durationMs: 6000 }),
    onError: (error) => toast.error(errorText(error)),
  });

  const privacyDetail = {
    public: t.privacy_public_detail,
    private: t.privacy_private_detail,
    airgapped: t.privacy_airgapped_detail,
  }[data.project.privacy];

  return (
    <View style={{ gap: 18 }}>
      <Section title={t.settings_language} subtitle={t.settings_language_subtitle} theme={theme}>
        <Card theme={theme}>
          <Segmented
            theme={theme}
            disabled={settings?.lockedByEnv || settingsMutation.isPending}
            active={settings?.locale ?? "auto"}
            onChange={(value) => settingsMutation.mutate({ locale: value })}
            items={[
              { id: "auto" as const, label: t.settings_language_auto },
              ...LOCALES.map((locale) => ({ id: locale, label: LOCALE_NATIVE_NAME[locale] })),
            ]}
          />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>
            {settings?.lockedByEnv
              ? t.settings_language_forced_by_env
              : t.settings_language_auto_detail(LOCALE_NATIVE_NAME[settings?.resolvedLocale ?? "en"])}
          </Text>
        </Card>
      </Section>

      <Section title={t.settings_privacy} subtitle={t.settings_privacy_subtitle} theme={theme}>
        <Card theme={theme}>
          <Segmented
            theme={theme}
            disabled={privacy.isPending}
            active={data.project.privacy}
            onChange={(value) => privacy.mutate(value)}
            items={[
              { id: "public" as const, label: t.privacy_public },
              { id: "private" as const, label: t.privacy_private },
              { id: "airgapped" as const, label: t.privacy_airgapped },
            ]}
          />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{privacyDetail}</Text>
        </Card>
      </Section>

      <Section title={t.settings_generation} subtitle={t.settings_generation_subtitle} theme={theme}>
        <Card theme={theme}>
          {settings?.availableProviders.length
            ? (
              <View style={{ gap: 6 }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t.settings_provider}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                  {[{ id: "", label: t.settings_language_auto }, ...settings.availableProviders].map((provider) => (
                    <Pressable
                      key={provider.id || "auto"}
                      onPress={() => settingsMutation.mutate({ provider: provider.id || null })}
                      style={{
                        paddingVertical: 6,
                        paddingHorizontal: 10,
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: (settings.provider ?? "") === provider.id ? theme.colors.accent : theme.colors.border,
                        backgroundColor: (settings.provider ?? "") === provider.id ? theme.colors.surface2 : theme.colors.surface1,
                      }}
                    >
                      <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>{provider.label}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            )
            : <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{t.settings_provider_none}</Text>}
          <Switch
            theme={theme}
            value={settings?.deferToUserAgents ?? true}
            onChange={(value) => settingsMutation.mutate({ deferToUserAgents: value })}
            label={t.settings_defer_to_user}
            detail={t.settings_defer_detail}
          />
        </Card>
      </Section>

      <Section title={t.settings_data} subtitle={t.settings_data_subtitle} theme={theme}>
        <Card theme={theme}>
          <Mono text={data.project.root} theme={theme} color={theme.colors.foreground} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {data.project.lastScanAt
              ? t.project_last_scan(relativeTime(t, data.project.lastScanAt, now))
              : t.project_last_scan(t.label_never)}
          </Text>
          {data.project.truncated ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{t.project_scan_truncated}</Text> : null}
          {data.project.identityKind === "path" ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{t.project_identified_by_path}</Text> : null}
          <Button
            label={exportMutation.isPending ? t.action_exporting : t.action_export}
            theme={theme}
            subtle
            disabled={exportMutation.isPending}
            onPress={() => exportMutation.mutate()}
          />
        </Card>
      </Section>
    </View>
  );
}

// ── 壳共用的主体 ────────────────────────────────────────────────────

/**
 * 六个一级入口的内容主体。
 *
 * 两个壳共用它：workspace 面板包一层 workspace 头，全局界面包一层项目详情头。
 */
export function ProjectBody({ data, view, settings, onRefetch, onLocaleChanged }: {
  data: Dashboard;
  view: ViewContext;
  settings: Settings | undefined;
  onRefetch(): void;
  onLocaleChanged(): void;
}) {
  const { target, clientLocale, theme, t } = view;
  const [tab, setTab] = useState<Tab>("now");
  const [selectedTech, setSelectedTech] = useState<string | null>(null);
  const classifyPending = useRpc(classifyRpc);
  const addEvidence = useRpc(evidenceRpc);
  const queryClient = useQueryClient();
  const toast = useToast();

  const classify = useMutation({
    mutationFn: () => classifyPending({ ...target, clientLocale }),
    onSuccess(value) {
      toast.show(t.classify_done(value.merged), { variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["rumen"] });
    },
    onError: (error) => toast.error(errorText(error)),
  });
  const evidence = useMutation({
    mutationFn: (node: KnowledgeNode) => addEvidence({ ...target, clientLocale, nodeGroupId: node.groupId, kind: "wiki_read" }),
    onSuccess() {
      toast.show(t.evidence_recorded, { variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["rumen"] });
    },
    onError: (error) => toast.error(errorText(error)),
  });

  const selected = data.technologies.find((item) => item.id === selectedTech) ?? null;

  return (
    <View style={{ gap: 16 }}>
      <Tabs
        theme={theme}
        active={tab}
        onChange={(value) => {
          setTab(value);
          setSelectedTech(null);
        }}
        items={[
          { id: "now" as const, label: t.tab_now },
          { id: "tech" as const, label: t.tab_stack, badge: data.project.pendingCount || undefined },
          { id: "learn" as const, label: t.tab_learn },
          { id: "review" as const, label: t.tab_review, badge: data.project.unreviewedCount || undefined },
          { id: "commits" as const, label: t.tab_commits },
          { id: "settings" as const, label: t.tab_settings },
        ]}
      />

      {!data.generation.available && tab !== "settings"
        ? (
          <Card theme={theme}>
            <Text style={{ color: theme.colors.statusWarning, fontSize: 12, lineHeight: 18 }}>
              {data.generation.reason === "airgapped" ? t.err_airgapped : t.err_no_provider}
            </Text>
          </Card>
        )
        : null}

      {tab === "now"
        ? <NowView data={data} theme={theme} t={t} onOpenTech={(id) => { setSelectedTech(id); setTab("tech"); }} onGoReview={() => setTab("review")} />
        : null}

      {tab === "tech"
        ? selected
          ? (
            <View style={{ gap: 16 }}>
              <Button label={t.stack_back} icon="ChevronLeft" theme={theme} subtle onPress={() => setSelectedTech(null)} />
              <WikiBox tech={selected} view={view} onRead={(node) => evidence.mutate(node)} />
              <QuizBox tech={selected} view={view} codeQuizAllowed={data.generation.codeQuizAllowed} onChanged={onRefetch} />
            </View>
          )
          : (
            <TechView
              data={data}
              view={view}
              onSelect={setSelectedTech}
              onClassify={() => classify.mutate()}
              classifying={classify.isPending}
            />
          )
        : null}

      {tab === "learn"
        ? (
          <LearnView
            data={data}
            theme={theme}
            t={t}
            onRead={(node) => evidence.mutate(node)}
            onQuiz={(node) => { setSelectedTech(node.techId); setTab("tech"); }}
          />
        )
        : null}

      {tab === "review"
        ? <ReviewView reviews={data.reviews} target={target} clientLocale={clientLocale} theme={theme} t={t} onChanged={onRefetch} />
        : null}

      {tab === "commits" ? <CommitsView data={data} theme={theme} t={t} /> : null}

      {tab === "settings" ? <SettingsView data={data} settings={settings} view={view} onLocaleChanged={onLocaleChanged} /> : null}
    </View>
  );
}

/** 扫描按钮。两个壳都要，逻辑一样。 */
export function ScanButton({ view, onScanned }: { view: ViewContext; onScanned(data: Dashboard): void }) {
  const { target, clientLocale, theme, t } = view;
  const scanWorkspace = useRpc(scanRpc);
  const toast = useToast();
  const scan = useMutation({
    mutationFn: () => scanWorkspace({ ...target, clientLocale }),
    onSuccess(value) {
      onScanned(value);
      toast.show(t.scan_complete, { variant: "success" });
    },
    onError: (error) => toast.error(errorText(error)),
  });
  return (
    <Button
      label={scan.isPending ? t.action_scanning : t.action_scan}
      icon="ScanSearch"
      theme={theme}
      disabled={scan.isPending}
      onPress={() => scan.mutate()}
    />
  );
}
