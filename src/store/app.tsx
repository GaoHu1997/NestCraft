import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as api from "@/api";

export type Route =
  | { page: "workbench" }
  | { page: "projects" }
  | { page: "project"; projectId: string; tab: "workbench" | "requirements" | "design" | "tasks" | "code" }
  | { page: "knowledge" }
  | { page: "knowledge-lib"; libId: string; noteId?: string }
  | { page: "servers" }
  | { page: "server"; hostId: string };

export interface WorkspaceWindow {
  key: string;
  route: Route;
  open?: boolean;
}

export function routeKey(route: Route): string {
  if (route.page === "project") return `project:${route.projectId}`;
  if (route.page === "knowledge-lib") return `knowledge:${route.libId}`;
  if (route.page === "server") return `server:${route.hostId}`;
  return "home";
}

interface AppState {
  route: Route;
  go: (route: Route) => void;
  openObject: (route: Route) => void;
  windows: WorkspaceWindow[];
  activateWindow: (key: string) => void;
  closeWindow: (key: string) => void;
  settingsOpen: boolean;
  setSettingsOpen: (value: boolean) => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  aiVisible: boolean;
  setAiVisible: (value: boolean) => void;
  aiWidth: number;
  setAiWidth: (value: number) => void;
  /** CR-047：各项目当前选定的特性；仅用于显式新建执行会话，不自动改写已有会话。 */
  featureTargets: Record<string, { featureId: string; featureTitle: string } | null>;
  setFeatureTarget: (projectId: string, target: { featureId: string; featureTitle: string } | null) => void;
}

const AppCtx = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [windows, setWindows] = useState<WorkspaceWindow[]>([{ key: "home", route: { page: "workbench" } }]);
  const [activeKey, setActiveKey] = useState("home");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [aiPreferences, setAiPreferences] = useState<Record<string, { visible: boolean; width: number }>>({});
  const [featureTargets, setFeatureTargets] = useState<Record<string, { featureId: string; featureTitle: string } | null>>({});
  const route = windows.find(window => window.key === activeKey)?.route ?? windows[0].route;
  const aiPreference = aiPreferences[activeKey] ?? { visible: true, width: 372 };

  useEffect(() => {
    api.getTheme().then(value => {
      const next = value === "dark" ? "dark" : "light";
      setTheme(next);
      document.documentElement.dataset.theme = next;
    }).catch(() => {});
  }, []);

  const go = useCallback((next: Route) => {
    const key = routeKey(next);
    setWindows(previous => {
      const existing = previous.find(window => window.key === key);
      if (!existing) return [...previous, { key, route: next, open: true }];
      return previous.map(window => window.key === key ? { ...window, route: next, open: true } : window);
    });
    setActiveKey(key);
  }, []);

  const openObject = useCallback((next: Route) => {
    const key = routeKey(next);
    setWindows(previous => {
      const existing = previous.find(window => window.key === key);
      if (!existing) return [...previous, { key, route: next, open: true }];
      return previous.map(window => window.key === key ? { ...window, open: true } : window);
    });
    setActiveKey(key);
  }, []);
  const activateWindow = useCallback((key: string) => setActiveKey(key), []);
  const closeWindow = useCallback((key: string) => {
    if (key === "home") return;
    /* CR-075：关闭服务器工作台页签即断开该主机；切换页签不触发，断开失败不影响界面状态。 */
    if (key.startsWith("server:")) {
      const hostId = key.slice("server:".length);
      if (hostId) void api.serverDisconnect(hostId).catch(() => {});
    }
    // 关闭可见Tab，保留内存实例；不隐式停止后台或销毁未保存内容。
    setWindows(previous => previous.map(window => window.key === key ? { ...window, open: false } : window));
    setActiveKey(previous => previous === key ? "home" : previous);
  }, []);

  const setAiVisible = useCallback((visible: boolean) => {
    setAiPreferences(previous => ({
      ...previous,
      [activeKey]: { width: previous[activeKey]?.width ?? 372, visible },
    }));
  }, [activeKey]);
  const setAiWidth = useCallback((width: number) => {
    setAiPreferences(previous => ({
      ...previous,
      [activeKey]: { visible: previous[activeKey]?.visible ?? true, width: Math.min(620, Math.max(320, width)) },
    }));
  }, [activeKey]);
  const setFeatureTarget = useCallback((projectId: string, target: { featureId: string; featureTitle: string } | null) => {
    setFeatureTargets(previous => ({ ...previous, [projectId]: target }));
  }, []);
  const toggleTheme = useCallback(() => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    api.setThemeCmd(next).catch(() => {});
  }, [theme]);

  const value = useMemo(() => ({
    route, go, openObject, windows, activateWindow, closeWindow, settingsOpen, setSettingsOpen,
    theme, toggleTheme, aiVisible: aiPreference.visible, setAiVisible,
    aiWidth: aiPreference.width, setAiWidth,
    featureTargets, setFeatureTarget,
  }), [route, go, openObject, windows, activateWindow, closeWindow, settingsOpen, theme, toggleTheme, aiPreference.visible, setAiVisible, aiPreference.width, setAiWidth, featureTargets, setFeatureTarget]);

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
