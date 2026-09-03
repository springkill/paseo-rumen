/**
 * Workspace 面板：在某个 workspace 里就地看 Rumen。
 *
 * 壳而已 —— 六个一级入口的内容在 `views.client.tsx`，与全局界面共用同一批组件。
 * 这个壳的特别之处只有两点：能拿到 `cwd` 所以能首次绑定并扫描，
 * 以及"现在"页能看到这个 workspace 里正在跑的 agent。
 */

import { Icon, type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { dashboardRpc, type RumenTarget } from "./contracts.shared";
import { Empty, ErrorCard, IdentityDot, useLocale } from "./ui.client";
import { ProjectBody, ScanButton, type ViewContext } from "./views.client";

export function RumenWorkspacePanel({ theme, host, layout, workspaceId }: PluginWorkspacePanelProps) {
  const { locale, t, clientLocale, settings, refetch: refetchLocale } = useLocale(host.id);
  const workspace = useWorkspace(workspaceId, (item) => ({
    name: item.name,
    directory: item.directory,
    projectDisplayName: item.projectDisplayName,
  }));
  const getDashboard = useRpc(dashboardRpc);
  const queryClient = useQueryClient();
  const cwd = workspace?.directory ?? "";
  const key = ["rumen", "dashboard", host.id, workspaceId, locale];

  const dashboard = useQuery({
    queryKey: key,
    queryFn: () => getDashboard({ workspaceId, cwd, clientLocale }),
    enabled: Boolean(cwd),
    retry: 0,
    staleTime: 20_000,
    refetchInterval: 45_000,
  });

  const target: RumenTarget = { workspaceId, cwd };
  const view: ViewContext = { target, clientLocale, locale, theme, t, compact: layout.compact };
  const data = dashboard.data;
  const styles = useMemo(() => ({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 } as const,
    content: { padding: layout.compact ? 12 : 20, gap: 16, paddingBottom: 44 } as const,
  }), [theme, layout.compact]);

  if (!workspace) {
    return <View style={styles.screen}><Empty text={t.err_workspace_unavailable} theme={theme} /></View>;
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View
          style={{
            flexDirection: layout.compact ? "column" : "row",
            justifyContent: "space-between",
            alignItems: layout.compact ? "stretch" : "center",
            gap: 10,
          }}
        >
          <View style={{ gap: 3 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {data ? <IdentityDot color={data.project.color} size={12} /> : <Icon name="BrainCircuit" size={20} color={theme.colors.accent} />}
              <Text style={{ color: theme.colors.foreground, fontSize: 21, fontWeight: "900" }}>{t.app_name}</Text>
            </View>
            {/* 项目名用 Paseo 的 projectDisplayName，不是 workspace 的会话标题 */}
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {data?.project.name ?? workspace.projectDisplayName ?? workspace.name}
            </Text>
          </View>
          <ScanButton view={view} onScanned={(value) => queryClient.setQueryData(key, value)} />
        </View>

        {dashboard.isLoading
          ? (
            <View style={{ padding: 28, gap: 8, alignItems: "center" }}>
              <ActivityIndicator color={theme.colors.accent} />
              <Text style={{ color: theme.colors.foregroundMuted }}>{t.scan_first_snapshot}</Text>
            </View>
          )
          : null}
        {dashboard.error ? <ErrorCard error={dashboard.error} theme={theme} t={t} onRetry={() => void dashboard.refetch()} /> : null}

        {data
          ? (
            <ProjectBody
              data={data}
              view={view}
              settings={settings}
              onRefetch={() => void dashboard.refetch()}
              onLocaleChanged={refetchLocale}
            />
          )
          : null}
      </ScrollView>
    </View>
  );
}
