import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppProvider } from "./store/app";
import { ToastProvider } from "./components/ui";
import { invoke } from "./api";
import "./theme/tokens.css";
import "./theme/base.css";
import "./theme/workbench.css";
import "./theme/icons.css";
import "./theme/cr044.css";

async function mountApp() {
  const preview = new URLSearchParams(location.search).get("preview") === "design";
  const native = Boolean(window.__TAURI_INTERNALS__);
  if (preview && native) throw new Error("桌面真实环境不能进入隔离设计预览；请使用独立浏览器预览地址。");
  if (preview && !native) {
    const module = await import("./smoke/design-preview");
    await module.installDesignPreview();
  }
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppProvider>
        <ToastProvider><App /></ToastProvider>
      </AppProvider>
    </React.StrictMode>
  );
  // 历史全量冒烟含外部动作，本轮必须显式双重授权才允许启动。
  if (native && !preview && new URLSearchParams(location.search).get("smoke") === "legacy") {
    const run = await invoke<boolean>("smoke_should_run");
    if (run) {
      const module = await import("./smoke/runner");
      await module.runSmoke();
    }
  }
}
void mountApp().catch(error => {
  const root = document.getElementById("root");
  if (root) root.textContent = `界面加载失败：${String(error)}`;
});
