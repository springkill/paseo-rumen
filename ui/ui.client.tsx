/**
 * 组件原语与语言 hook。
 *
 * 布局单元照 Paseo 的 **section → card → row**：
 *
 * ```
 * section   分组，带一个 muted 的小标题 + 可选的右侧动作
 *   card    surface1 底 + 1px border + 圆角
 *     row   flex，左右两端对齐
 * ```
 *
 * card 的边框把一组信息**圈起来**，眼睛不用横跨整个窗口去对齐；
 * row 内部左右对齐的跨度被限制在卡片宽度内。这治的是"名字和版本隔着 1400px"
 * 那个毛病 —— 裸列表在宽窗口下必然得这个病。
 *
 * 两条不动摇的约束：
 * - **不用 box-shadow 做层级**，用 surface 与 border
 * - **前端不做判断**。该不该打断、折叠优先级、掌握度算法全在服务端，
 *   前端再判一遍必然算出不一样的结果
 */

import { Icon, type PluginTheme, useRpc } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
// ⚠️ 具名导入 `useMemo`，**不要** `React.useMemo`。
// esbuild 会把它编成 `import_react.default.useMemo` —— 依赖 `__toESM` interop
// 合成出来的 `.default`。宿主在 web 与原生（Hermes）两端各自提供 react 模块，
// 两边 interop 形状不保证一样：安卓上这条整片界面变成
// `Plugin failed: Object is not a function`，web 端完全正常。
// `React` 本体仍需保留给 `React.ReactNode` 这类**类型**位置（编译后会被擦掉）。
import React, { useMemo } from "react";
import { ActivityIndicator, NativeModules, Pressable, Text, View } from "react-native";
import { settingsRpc, type Settings } from "../domain/contracts.shared";
import { bucketStyle, masteryColor, type StatusBucket } from "../domain/buckets.shared";
import { translator, type Locale, type Translator } from "../domain/i18n.shared";

// ── 语言 ────────────────────────────────────────────────────────────

/**
 * 客户端自己是什么语言 —— **对齐 Paseo 自己的取法**。
 *
 * Paseo 的原逻辑（web-ui bundle 里读出来的）：
 *
 * ```js
 * isWeb && navigator.languages.length > 0
 *   ? [...navigator.languages]              // web：浏览器语言列表
 *   : getLocales().map(e => e.languageTag)  // 原生：expo-localization 取系统 locale
 * ```
 *
 * 插件拿不到 `expo-localization`（它不在宿主提供的 external 列表里），
 * 所以原生那半边用 `react-native` 的 `NativeModules` 取同一个系统值，
 * 最后再退到 `Intl`。顺序刻意与 Paseo 一致，免得同一台机器上
 * Paseo 显示一种语言、插件显示另一种。
 *
 * ⚠️ 只负责**报告**，判定在服务端 —— 两边各判一次必然判出不一样的结果。
 */
export function detectClientLocale(): string | undefined {
  // ① web：与 Paseo 完全同源
  try {
    const globals = globalThis as unknown as {
      navigator?: { language?: string; languages?: readonly string[] };
    };
    const languages = globals.navigator?.languages;
    if (languages && languages.length > 0) return languages[0];
    if (globals.navigator?.language) return globals.navigator.language;
  } catch {
    // 沙箱里可能没有 navigator
  }

  // ② 原生：expo-localization 读的就是这两个系统值
  try {
    const modules = (NativeModules ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const ios = modules.SettingsManager?.settings as
      | { AppleLocale?: string; AppleLanguages?: string[] }
      | undefined;
    const fromIos = ios?.AppleLocale ?? ios?.AppleLanguages?.[0];
    if (typeof fromIos === "string" && fromIos) return fromIos;
    const android = modules.I18nManager?.localeIdentifier;
    if (typeof android === "string" && android) return android;
  } catch {
    // 非原生环境没有 NativeModules
  }

  // ③ 兜底
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale; // hermes-ok: 整段在 try/catch 里，Hermes 没有 Intl 时抛出后返回 undefined，调用方继续往下找
  } catch {
    return undefined;
  }
}

export interface LocaleContext {
  locale: Locale;
  t: Translator;
  clientLocale: string | undefined;
  settings: Settings | undefined;
  refetch(): void;
}

/**
 * 取当前界面语言和文案表。
 *
 * 服务端设置没读回来之前用客户端检测的结果兜着 —— 首帧显示英文再闪成中文，
 * 比首帧空白好。
 */
export function useLocale(hostId: string): LocaleContext {
  const clientLocale = useMemo(() => detectClientLocale(), []);
  const getSettings = useRpc(settingsRpc);
  const query = useQuery({
    queryKey: ["rumen", "settings", hostId],
    queryFn: () => getSettings({ clientLocale }),
    staleTime: 300_000,
    retry: 0,
  });
  const fallback: Locale = clientLocale?.toLowerCase().startsWith("zh") ? "zh" : "en";
  const locale = query.data?.resolvedLocale ?? fallback;
  return {
    locale,
    t: translator(locale),
    clientLocale,
    settings: query.data,
    refetch: () => void query.refetch(),
  };
}

// ── 原语 ────────────────────────────────────────────────────────────

export function Button({ label, theme, onPress, disabled, subtle, danger, icon }: {
  label: string;
  theme: PluginTheme;
  onPress(): void;
  disabled?: boolean;
  subtle?: boolean;
  danger?: boolean;
  icon?: string;
}) {
  const backgroundColor = danger
    ? theme.colors.statusDanger
    : subtle
      ? theme.colors.surface1
      : theme.colors.accent;
  const color = subtle ? theme.colors.foreground : theme.colors.accentForeground;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderRadius: 9,
        borderWidth: subtle ? 1 : 0,
        borderColor: theme.colors.border,
        backgroundColor,
        opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={14} color={color} /> : null}
      <Text style={{ color, fontWeight: "700", textAlign: "center" }}>{label}</Text>
    </Pressable>
  );
}

export function Card({ theme, children, accent, onPress }: {
  theme: PluginTheme;
  children: React.ReactNode;
  accent?: boolean;
  onPress?(): void;
}) {
  const style = {
    gap: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: accent ? theme.colors.accent : theme.colors.border,
    backgroundColor: theme.colors.surface1,
  } as const;
  if (!onPress) return <View style={style}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ ...style, opacity: pressed ? 0.8 : 1 })}>
      {children}
    </Pressable>
  );
}

/** 左右两端对齐的行。右侧默认带一个"可以进去"的 chevron。 */
export function Row({ theme, left, right, chevron }: {
  theme: PluginTheme;
  left: React.ReactNode;
  right?: React.ReactNode;
  chevron?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <View style={{ flex: 1, minWidth: 0 }}>{left}</View>
      {right}
      {chevron ? <Icon name="ChevronRight" size={16} color={theme.colors.foregroundMuted} /> : null}
    </View>
  );
}

export function Section({ title, subtitle, theme, children, action }: {
  title: string;
  subtitle?: string;
  theme: PluginTheme;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <View style={{ gap: 9 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "800" }}>{title}</Text>
          {subtitle ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{subtitle}</Text> : null}
        </View>
        {action}
      </View>
      {children}
    </View>
  );
}

export function Metric({ label, value, theme, tone = "normal" }: {
  label: string;
  value: string | number;
  theme: PluginTheme;
  tone?: "normal" | "accent" | "warning" | "danger";
}) {
  const color = tone === "accent"
    ? theme.colors.accent
    : tone === "warning"
      ? theme.colors.statusWarning
      : tone === "danger"
        ? theme.colors.statusDanger
        : theme.colors.foreground;
  return (
    <View style={{ flex: 1, minWidth: 108, padding: 10, borderRadius: 10, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, gap: 3 }}>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
      <Text style={{ color, fontSize: 19, fontWeight: "800" }}>{value}</Text>
    </View>
  );
}

/**
 * 掌握度 / 置信度 / 知识债是**三个量**。
 *
 * 这个组件只画掌握度那一个条，另外两个用文字并排 —— 混成一个条就什么也说不清了。
 */
export function MasteryBar({ score, confidence, debt, theme, t }: {
  score: number;
  confidence?: number;
  debt?: number;
  theme: PluginTheme;
  t: Translator;
}) {
  return (
    <View style={{ gap: 4, minWidth: 110 }}>
      <View style={{ height: 6, borderRadius: 4, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        <View style={{ height: 6, width: `${Math.max(0, Math.min(100, score))}%`, backgroundColor: masteryColor(score, theme) }} />
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
        {Math.round(score)}%
        {confidence === undefined ? "" : ` · ${t.label_confidence} ${Math.round(confidence * 100)}%`}
        {debt ? ` · ${t.label_debt} ${debt}` : ""}
      </Text>
    </View>
  );
}

/**
 * 状态点。
 *
 * ⭐ `needs_input` 与 `running` 同为 amber —— 它们不冲突，因为
 * `needs_input` **永远画告警字形，从不画裸点**。
 */
export function StatusDot({ bucket, theme, size = 8 }: { bucket: StatusBucket; theme: PluginTheme; size?: number }) {
  const style = bucketStyle(bucket, theme);
  if (!style.color || style.glyph === "none") return null;
  if (style.glyph === "loader") return <ActivityIndicator size="small" color={style.color} />;
  if (style.glyph === "alert") return <Icon name="TriangleAlert" size={size + 5} color={style.color} />;
  if (style.glyph === "spark") return <Icon name="Sparkles" size={size + 5} color={style.color} />;
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: style.color }} />;
}

/** 身份色方块。**只回答"这是哪个项目"**，不参与排序，不带语义。 */
export function IdentityDot({ color, size = 10 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: 3, backgroundColor: color }} />;
}

export function Empty({ text, theme, action }: { text: string; theme: PluginTheme; action?: React.ReactNode }) {
  return (
    <View style={{ paddingVertical: 20, gap: 10, alignItems: "center" }}>
      <Text style={{ color: theme.colors.foregroundMuted, textAlign: "center", lineHeight: 20 }}>{text}</Text>
      {action}
    </View>
  );
}

export function Tabs<T extends string>({ items, active, onChange, theme }: {
  items: Array<{ id: T; label: string; badge?: number }>;
  active: T;
  onChange(value: T): void;
  theme: PluginTheme;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <Pressable
            key={item.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(item.id)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingVertical: 7,
              paddingHorizontal: 10,
              borderRadius: 8,
              backgroundColor: selected ? theme.colors.accent : theme.colors.surface1,
              borderWidth: 1,
              borderColor: selected ? theme.colors.accent : theme.colors.border,
            }}
          >
            <Text style={{ color: selected ? theme.colors.accentForeground : theme.colors.foreground, fontWeight: "700", fontSize: 12 }}>
              {item.label}
            </Text>
            {item.badge ? (
              <View style={{ minWidth: 16, paddingHorizontal: 4, borderRadius: 8, backgroundColor: selected ? theme.colors.accentForeground : theme.colors.statusWarning }}>
                <Text style={{ fontSize: 10, fontWeight: "800", textAlign: "center", color: selected ? theme.colors.accent : theme.colors.surface0 }}>
                  {item.badge}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** 分段选择器。选项少且互斥时用它，不要用一排 button 假装。 */
export function Segmented<T extends string>({ items, active, onChange, theme, disabled }: {
  items: Array<{ id: T; label: string }>;
  active: T;
  onChange(value: T): void;
  theme: PluginTheme;
  disabled?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", borderRadius: 9, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden", alignSelf: "flex-start" }}>
      {items.map((item, index) => {
        const selected = item.id === active;
        return (
          <Pressable
            key={item.id}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(item.id)}
            style={{
              paddingVertical: 7,
              paddingHorizontal: 13,
              backgroundColor: selected ? theme.colors.accent : theme.colors.surface1,
              borderLeftWidth: index === 0 ? 0 : 1,
              borderLeftColor: theme.colors.border,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <Text style={{ color: selected ? theme.colors.accentForeground : theme.colors.foreground, fontWeight: "700", fontSize: 12 }}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Switch({ value, onChange, theme, label, detail }: {
  value: boolean;
  onChange(next: boolean): void;
  theme: PluginTheme;
  label: string;
  detail?: string;
}) {
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: value }} onPress={() => onChange(!value)}>
      <Row
        theme={theme}
        left={
          <View style={{ gap: 2 }}>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{label}</Text>
            {detail ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{detail}</Text> : null}
          </View>
        }
        right={
          <View style={{ width: 38, height: 22, borderRadius: 11, padding: 2, backgroundColor: value ? theme.colors.accent : theme.colors.surface2, borderWidth: 1, borderColor: theme.colors.border }}>
            <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: value ? theme.colors.accentForeground : theme.colors.foregroundMuted, marginLeft: value ? 16 : 0 }} />
          </View>
        }
      />
    </Pressable>
  );
}

/** 错误直陈状态，不道歉不评价。 */
export function ErrorCard({ error, theme, t, onRetry }: {
  error: unknown;
  theme: PluginTheme;
  t: Translator;
  onRetry?(): void;
}) {
  return (
    <Card theme={theme}>
      <Text style={{ color: theme.colors.statusDanger, lineHeight: 19 }}>
        {error instanceof Error ? error.message : String(error)}
      </Text>
      {onRetry ? <Button label={t.action_retry} theme={theme} subtle onPress={onRetry} /> : null}
    </Card>
  );
}

export function Pill({ text, theme, tone = "muted" }: {
  text: string;
  theme: PluginTheme;
  tone?: "muted" | "warning" | "accent" | "success";
}) {
  const color = tone === "warning"
    ? theme.colors.statusWarning
    : tone === "accent"
      ? theme.colors.accent
      : tone === "success"
        ? theme.colors.statusSuccess
        : theme.colors.foregroundMuted;
  return (
    <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: color, alignSelf: "flex-start" }}>
      <Text style={{ color, fontSize: 10, fontWeight: "700" }}>{text}</Text>
    </View>
  );
}

export function Mono({ text, theme, color }: { text: string; theme: PluginTheme; color?: string }) {
  return (
    <Text selectable numberOfLines={1} style={{ color: color ?? theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 10 }}>
      {text}
    </Text>
  );
}
