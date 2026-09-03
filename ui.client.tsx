import type { PluginTheme } from "@getpaseo/plugin";
import React from "react";
import { Pressable, Text, View } from "react-native";

export function Button({ label, theme, onPress, disabled, subtle, danger }: { label: string; theme: PluginTheme; onPress(): void; disabled?: boolean; subtle?: boolean; danger?: boolean }) {
  const backgroundColor = danger ? theme.colors.statusDanger : subtle ? theme.colors.surface1 : theme.colors.accent;
  const color = subtle ? theme.colors.foreground : theme.colors.accentForeground;
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => ({
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: 9,
      borderWidth: subtle ? 1 : 0,
      borderColor: theme.colors.border,
      backgroundColor,
      opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
    })}>
      <Text style={{ color, fontWeight: "700", textAlign: "center" }}>{label}</Text>
    </Pressable>
  );
}

export function Card({ theme, children, accent }: { theme: PluginTheme; children: React.ReactNode; accent?: boolean }) {
  return <View style={{ gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: accent ? theme.colors.accent : theme.colors.border, backgroundColor: theme.colors.surface1 }}>{children}</View>;
}

export function Section({ title, subtitle, theme, children, action }: { title: string; subtitle?: string; theme: PluginTheme; children: React.ReactNode; action?: React.ReactNode }) {
  return <View style={{ gap: 9 }}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 17, fontWeight: "800" }}>{title}</Text>
        {subtitle ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{subtitle}</Text> : null}
      </View>
      {action}
    </View>
    {children}
  </View>;
}

export function Metric({ label, value, theme, tone = "normal" }: { label: string; value: string | number; theme: PluginTheme; tone?: "normal" | "accent" | "warning" | "danger" }) {
  const color = tone === "accent" ? theme.colors.accent : tone === "warning" ? theme.colors.statusWarning : tone === "danger" ? theme.colors.statusDanger : theme.colors.foreground;
  return <View style={{ flex: 1, minWidth: 105, padding: 10, borderRadius: 10, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, gap: 3 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
    <Text style={{ color, fontSize: 19, fontWeight: "800" }}>{value}</Text>
  </View>;
}

export function MasteryBar({ score, confidence, theme }: { score: number; confidence?: number; theme: PluginTheme }) {
  const color = score >= 60 ? theme.colors.statusSuccess : score >= 30 ? theme.colors.statusWarning : theme.colors.accent;
  return <View style={{ gap: 4, minWidth: 100 }}>
    <View style={{ height: 6, borderRadius: 4, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      <View style={{ height: 6, width: `${Math.max(0, Math.min(100, score))}%`, backgroundColor: color }} />
    </View>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{Math.round(score)}%{confidence === undefined ? "" : ` · confidence ${Math.round(confidence * 100)}%`}</Text>
  </View>;
}

export function Empty({ text, theme }: { text: string; theme: PluginTheme }) {
  return <Text style={{ color: theme.colors.foregroundMuted, paddingVertical: 16, textAlign: "center" }}>{text}</Text>;
}

export function Tabs<T extends string>({ items, active, onChange, theme }: { items: Array<{ id: T; label: string }>; active: T; onChange(value: T): void; theme: PluginTheme }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
    {items.map((item) => <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: item.id === active }} onPress={() => onChange(item.id)} style={{ paddingVertical: 7, paddingHorizontal: 10, borderRadius: 8, backgroundColor: item.id === active ? theme.colors.accent : theme.colors.surface1, borderWidth: 1, borderColor: item.id === active ? theme.colors.accent : theme.colors.border }}>
      <Text style={{ color: item.id === active ? theme.colors.accentForeground : theme.colors.foreground, fontWeight: "700", fontSize: 12 }}>{item.label}</Text>
    </Pressable>)}
  </View>;
}
