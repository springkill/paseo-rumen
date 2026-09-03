import { Icon, type PluginTimelineItemProps } from "@getpaseo/plugin";
import React from "react";
import { Text, View } from "react-native";
import type { TimelineImpact } from "./contracts.shared";

export function RumenTimelineCard({ item, theme }: PluginTimelineItemProps<TimelineImpact>) {
  const manifest = item.data.signal === "manifest";
  const color = manifest ? theme.colors.statusWarning : theme.colors.accent;
  return <View style={{ gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: color, backgroundColor: theme.colors.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Icon name={manifest ? "PackageSearch" : "BrainCircuit"} size={17} color={color} /><Text style={{ color: theme.colors.foreground, fontWeight: "800" }}>Rumen · {item.data.label}</Text></View>
    <Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11 }}>{item.data.target}</Text>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{manifest ? "This can introduce new technology or change the project's knowledge map. Run Rumen Scan after the turn." : "Rumen will correlate this file target with detected technology evidence and personal mastery."}</Text>
  </View>;
}
