import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import * as api from "@/api";

const isNative = () => Boolean(window.__TAURI_INTERNALS__) && !(window as Window & { __DESIGN_PREVIEW__?: boolean }).__DESIGN_PREVIEW__;

export function useWindowChrome() {
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const [closeToken, setCloseToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const native = isNative();
  useEffect(() => {
    if (!native) return;
    let alive = true;
    const cleanups: (() => void)[] = [];
    const current = getCurrentWindow();
    const refresh = () => current.isMaximized().then(value => { if (alive) setMaximized(value); });
    void refresh().catch(reason => { if (alive) setError(String(reason)); });
    void current.onResized(() => void refresh().catch(() => {})).then(cleanup => { if (alive) cleanups.push(cleanup); else cleanup(); });
    void current.onFocusChanged(event => { if (alive) setFocused(event.payload); }).then(cleanup => { if (alive) cleanups.push(cleanup); else cleanup(); });
    void listen<{ token: string }>("app:close-requested", event => {
      if (alive && event.payload.token) setCloseToken(event.payload.token);
    }).then(async cleanup => {
      if (!alive) { cleanup(); return; }
      cleanups.push(cleanup);
      const pending = await api.invoke<string | null>("window_pending_close");
      if (alive && pending) setCloseToken(pending);
    }).catch(reason => { if (alive) setError(String(reason)); });
    return () => { alive = false; cleanups.forEach(cleanup => cleanup()); };
  }, [native]);
  const act = async (action: "minimize" | "maximize" | "close" | "drag") => {
    setError("");
    if (!native) {
      if (action === "maximize") setMaximized(value => !value);
      if (action === "close") setCloseToken("browser-demo");
      if (action === "minimize") setError("浏览器预览仅展示最小化状态，不操作真实桌面窗口。");
      return;
    }
    try {
      const current = getCurrentWindow();
      if (action === "minimize") await current.minimize();
      if (action === "maximize") { await current.toggleMaximize(); setMaximized(await current.isMaximized()); }
      if (action === "drag") await current.startDragging();
      if (action === "close") await api.invoke("window_request_close");
    } catch (reason) { setError(String(reason)); }
  };
  const cancelClose = async () => {
    if (!closeToken) return;
    try {
      if (native) await api.invoke("window_cancel_close", { token: closeToken });
      setCloseToken(null);
    } catch (reason) {
      setError(String(reason));
      if (native) {
        try {
          setCloseToken(await api.invoke<string | null>("window_pending_close"));
        } catch (queryError) {
          setError(`${String(reason)}；关闭请求状态未确认：${String(queryError)}`);
        }
      }
    }
  };
  const confirmClose = async () => {
    if (!closeToken) return;
    try {
      if (native) await api.invoke("window_confirm_close", { token: closeToken });
      else setError("关闭是原型仿真；未关闭浏览器，也未写入文件。");
      setCloseToken(null);
    } catch (reason) {
      setError(String(reason));
      if (native) {
        try {
          setCloseToken(await api.invoke<string | null>("window_pending_close"));
        } catch (queryError) {
          setError(`${String(reason)}；关闭请求状态未确认：${String(queryError)}`);
        }
      }
    }
  };
  return { native, maximized, focused, closeToken, error, act, cancelClose, confirmClose, clearError: () => setError("") };
}
