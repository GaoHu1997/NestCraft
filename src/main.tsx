import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppProvider } from "./store/app";
import { ToastProvider } from "./components/ui";
import { invoke } from "./api";
import { installScrollbarReveal } from "./components/scrollbar";
import "./theme/tokens.css";
import "./theme/base.css";
import "./theme/workbench.css";
import "./theme/icons.css";
import "./theme/cr044.css";
import "./theme/tab-overflow.css";
// CR-051：内置图标砖、文件类型色与头像 5 风格样式（UI-CR051-v1）。
import "./theme/cr051.css";
// CR-051 r6：50 图标分组、10 整块色卡、头像框与固定尺寸更换弹窗（UI-CR051-v6）。
import "./theme/cr051-v6.css";

// UI-CR049 / UI-SCROLL-001：滚动条按需显示机制在应用启动时安装一次。
installScrollbarReveal();

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
  // 历史全量冒烟含外部动作，必须显式双重授权才允许启动：
  // ① 进程带 TAURI_SMOKE=1；② 要么 URL 带 ?smoke=legacy，要么进程再带 SMOKE_AUTORUN=1。
  // 两者缺一不可；autorun 只是省掉手工在窗口里输入 URL，不降低授权要求。
  if (native && !preview) {
    const search = new URLSearchParams(location.search);
    const requested = search.get("smoke") === "legacy";
    // 聚焦套件（执行账本 + 双向同步）：单独入口，同样要求 TAURI_SMOKE=1 且 SMOKE_EXEC_SUITE=1。
    const execSuite = await invoke<boolean>("smoke_exec_suite_flag").catch(() => false);
    if (execSuite && (await invoke<boolean>("smoke_should_run").catch(() => false))) {
      const module = await import("./smoke/execution-runner");
      await module.runExecutionSmoke();
      return;
    }
    // 死锁回归（CR-065 pin / fork）：TAURI_SMOKE=1 且 SMOKE_PIN_SUITE=1。
    const pinSuite = await invoke<boolean>("smoke_pin_suite_flag").catch(() => false);
    if (pinSuite && (await invoke<boolean>("smoke_should_run").catch(() => false))) {
      const module = await import("./smoke/pin-suite");
      await module.runPinSuite();
      return;
    }
    // grok 真实链路（产品代码 dispatch 注入）：TAURI_SMOKE=1 且 SMOKE_GROK_SUITE=1。
    const grokSuite = await invoke<boolean>("smoke_grok_suite_flag").catch(() => false);
    if (grokSuite && (await invoke<boolean>("smoke_should_run").catch(() => false))) {
      const module = await import("./smoke/grok-suite");
      await module.runGrokSuite();
      return;
    }
    // 双协议单供应商专项（claude/codex/grok × 同供应商 openai+anthropic 端点）：
    // TAURI_SMOKE=1 且 SMOKE_DUAL_SUITE=1（需 TIERFLOW_SMOKE_KEY）。
    const dualSuite = await invoke<boolean>("smoke_dual_suite_flag").catch(() => false);
    if (dualSuite && (await invoke<boolean>("smoke_should_run").catch(() => false))) {
      const module = await import("./smoke/dual-protocol-suite");
      await module.runDualProtocolSuite();
      return;
    }
    // 子 CLI token 消耗统计专项：TAURI_SMOKE=1 且 SMOKE_TOKEN_SUITE=1（需 TIERFLOW_SMOKE_KEY）。
    const tokenSuite = await invoke<boolean>("smoke_token_suite_flag").catch(() => false);
    if (tokenSuite && (await invoke<boolean>("smoke_should_run").catch(() => false))) {
      const module = await import("./smoke/token-suite");
      await module.runTokenSuite();
      return;
    }
    const autorun = await invoke<boolean>("smoke_autorun_flag").catch(() => false);
    if (requested || autorun) {
      const run = await invoke<boolean>("smoke_should_run");
      if (run) {
        const module = await import("./smoke/runner");
        await module.runSmoke();
      }
    }
  }
}
void mountApp().catch(error => {
  const root = document.getElementById("root");
  if (root) root.textContent = `界面加载失败：${String(error)}`;
});
