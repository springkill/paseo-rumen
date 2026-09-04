/**
 * 时间线卡片：agent 改了一个会影响知识地图的文件。
 *
 * 它是**就地的一次提示**，不是持久入口 —— 持久入口是左侧栏的 Rumen 项。
 * 时间线上塞持久状态会让人往回翻着找"现在怎么样了"。
 */

import { Icon, type PluginTimelineItemProps } from "@getpaseo/plugin";
import React from "react";
import { Text, View } from "react-native";
import type { TimelineImpact } from "../domain/contracts.shared";
import { useLocale } from "./ui.client";

export function RumenTimelineCard({ item, theme, host }: PluginTimelineItemProps<TimelineImpact>) {
  const { t } = useLocale(host.id);
  const manifest = item.data.signal === "manifest";
  const color = manifest ? theme.colors.statusWarning : theme.colors.accent;
  return (
    <View style={{ gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: color, backgroundColor: theme.colors.surface1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name={manifest ? "PackageSearch" : "BrainCircuit"} size={17} color={color} />
        <Text style={{ color: theme.colors.foreground, fontWeight: "800" }}>
          {t.app_name} · {manifest ? t.timeline_manifest_label : t.timeline_source_label}
        </Text>
      </View>
      <Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11 }}>
        {item.data.target}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
        {manifest ? t.timeline_manifest_body : t.timeline_source_body}
      </Text>
    </View>
  );
}
