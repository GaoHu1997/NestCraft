import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

/** 一个可见聊天 scope 只有一个浮层；外点只关闭，不阻止原目标的点击。 */
export type ChatOverlay = "history" | "agents" | "bg" | "cli" | "perm" | "model" | "session" | "tokens" | "context" | "@" | "/" | "+";
interface OverlayController {
  activeOverlay: ChatOverlay | null;
  scopeRef: RefObject<HTMLDivElement>;
  open: (name: ChatOverlay, trigger?: HTMLElement | null) => void;
  toggle: (name: ChatOverlay, trigger: HTMLElement) => void;
  close: (restoreFocus?: boolean) => void;
}
const Context = createContext<OverlayController | null>(null);

export function ChatOverlayProvider({ visible = true, children }: { visible?: boolean; children: ReactNode }) {
  const [activeOverlay, setActiveOverlay] = useState<ChatOverlay | null>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const close = (restoreFocus = false) => {
    setActiveOverlay(null);
    if (!restoreFocus || !visible) return;
    const trigger = triggerRef.current;
    if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus();
    else scopeRef.current?.querySelector<HTMLTextAreaElement>("textarea.chat-ta")?.focus();
  };
  useEffect(() => {
    if (!visible) setActiveOverlay(null);
  }, [visible]);
  useEffect(() => {
    if (!visible || !activeOverlay) return;
    const outside = (event: PointerEvent) => {
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      // Confirm/系统弹窗由自身管理，不能被历史浮层的外点逻辑卸载。
      if (target.closest('[aria-modal="true"], .modal-backdrop')) return;
      if (scopeRef.current?.contains(target)) {
        if (target.closest(`[data-chat-overlay="${activeOverlay}"]`)) return;
        if (target.closest("[data-chat-overlay-trigger]")) return;
      }
      close(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [activeOverlay, visible]);
  const open = (name: ChatOverlay, trigger?: HTMLElement | null) => {
    if (!visible) return;
    triggerRef.current = trigger ?? scopeRef.current?.querySelector<HTMLTextAreaElement>("textarea.chat-ta") ?? null;
    setActiveOverlay(name);
  };
  return <Context.Provider value={{ activeOverlay, scopeRef, open, close, toggle: (name, trigger) => {
    if (activeOverlay === name) close(false);
    else open(name, trigger);
  } }}>{children}</Context.Provider>;
}
export function useChatOverlay(): OverlayController {
  const value = useContext(Context);
  if (!value) throw new Error("聊天控件必须在同一 ChatOverlayProvider 中使用");
  return value;
}
