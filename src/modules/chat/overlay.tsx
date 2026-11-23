import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode, RefObject } from "react";

/** 一个可见聊天 scope 只有一个浮层；外点只关闭，不阻止原目标的点击。 */
export type ChatOverlay = "history" | "agents" | "bg" | "runner" | "cli" | "perm" | "model" | "session" | "tokens" | "context" | "@" | "/" | "+";
export type ChatConfigOverlay = "runner" | "cli" | "perm" | "model";
const isConfig = (name: ChatOverlay): name is ChatConfigOverlay => name === "runner" || name === "cli" || name === "perm" || name === "model";
interface OverlayController {
  activeOverlay: ChatOverlay | null;
  scopeRef: RefObject<HTMLDivElement>;
  scopeId: string;
  registerTrigger: (name: ChatConfigOverlay, trigger: HTMLButtonElement | null) => void;
  getTrigger: (name: ChatConfigOverlay) => HTMLButtonElement | null;
  open: (name: ChatOverlay, trigger?: HTMLElement | null) => void;
  toggle: (name: ChatOverlay, trigger: HTMLElement) => void;
  close: (restoreFocus?: boolean) => void;
}
const Context = createContext<OverlayController | null>(null);

export function ChatOverlayProvider({ visible = true, children }: { visible?: boolean; children: ReactNode }) {
  const [activeOverlay, setActiveOverlay] = useState<ChatOverlay | null>(null);
  const activeRef = useRef<ChatOverlay | null>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const scopeId = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const configTriggers = useRef<Partial<Record<ChatConfigOverlay, HTMLButtonElement>>>({});
  const registerTrigger = useCallback((name: ChatConfigOverlay, trigger: HTMLButtonElement | null) => {
    if (trigger) configTriggers.current[name] = trigger;
    else delete configTriggers.current[name];
  }, []);
  const getTrigger = useCallback((name: ChatConfigOverlay) => configTriggers.current[name] ?? null, []);
  const close = useCallback((restoreFocus = false) => {
    activeRef.current = null;
    setActiveOverlay(null);
    if (!restoreFocus || !visible) return;
    const trigger = triggerRef.current;
    if (trigger?.isConnected && trigger.getClientRects().length && !(trigger instanceof HTMLButtonElement && trigger.disabled)) trigger.focus({ preventScroll: true });
    else scopeRef.current?.querySelector<HTMLTextAreaElement>("textarea.chat-ta")?.focus({ preventScroll: true });
  }, [visible]);
  useEffect(() => {
    if (!visible) close(false);
  }, [visible, close]);
  useEffect(() => {
    if (!visible || !activeOverlay) return;
    const outside = (event: PointerEvent) => {
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      // Confirm/系统弹窗由自身管理，不能被历史浮层的外点逻辑卸载。
      if (target.closest('[aria-modal="true"], .modal-backdrop')) return;
      // portal 不在 scope DOM 内，必须核对自己的 owner，不能把其它会话弹层当作内部。
      if (event.composedPath().some(node => node instanceof HTMLElement && node.dataset.chatOverlayOwner === scopeId && node.dataset.chatOverlay === activeOverlay)) return;
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
  }, [activeOverlay, visible, scopeId, close]);
  const open = useCallback((name: ChatOverlay, trigger?: HTMLElement | null) => {
    if (!visible) return;
    // 配置菜单与直接点击共用真实 button；不接受 textarea／菜单行作为配置锚点。
    const anchor = isConfig(name) ? getTrigger(name) : trigger ?? scopeRef.current?.querySelector<HTMLTextAreaElement>("textarea.chat-ta") ?? null;
    if (isConfig(name) && (!(anchor instanceof HTMLButtonElement) || !anchor.isConnected || anchor.disabled)) return;
    triggerRef.current = anchor;
    activeRef.current = name;
    setActiveOverlay(name);
  }, [visible, getTrigger]);
  const toggle = useCallback((name: ChatOverlay, trigger: HTMLElement) => {
    if (activeRef.current === name) close(true);
    else open(name, trigger);
  }, [close, open]);
  return <Context.Provider value={{ activeOverlay: visible ? activeOverlay : null, scopeRef, scopeId, registerTrigger, getTrigger, open, close, toggle }}>{children}</Context.Provider>;
}
export function useChatOverlay(): OverlayController {
  const value = useContext(Context);
  if (!value) throw new Error("聊天控件必须在同一 ChatOverlayProvider 中使用");
  return value;
}

/** UI-CR045-v1：上方优先、gap 6、视口 margin 8；只定位，不修改模型／权限。 */
export function ChatConfigPopup({ name, className, label, children }: {
  name: ChatConfigOverlay;
  className: string;
  label: string;
  children: ReactNode;
}) {
  const { scopeRef, scopeId, getTrigger } = useChatOverlay();
  const popupRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popup = popupRef.current, trigger = getTrigger(name);
    if (!popup || !trigger) return;
    let frame = 0;
    const viewport = window.visualViewport;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
    const position = () => {
      frame = 0;
      const rect = trigger.getBoundingClientRect();
      const leftBound = (viewport?.offsetLeft ?? 0) + 8, topBound = (viewport?.offsetTop ?? 0) + 8;
      const rightBound = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - 8;
      const bottomBound = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 8;
      if (!trigger.isConnected || !rect.width || !rect.height || rect.bottom < topBound || rect.top > bottomBound || rect.right < leftBound || rect.left > rightBound) {
        popup.style.visibility = "hidden";
        return;
      }
      // 临时放宽测量不能清掉长列表当前位置；恢复后再回填各滚动容器。
      const scrollPositions = [popup, ...popup.querySelectorAll<HTMLElement>("*")].filter(node => node.scrollTop || node.scrollLeft).map(node => ({ node, top: node.scrollTop, left: node.scrollLeft }));
      // 每次先恢复视口限制再测量，避免上次被限高的尺寸导致错误翻转。
      popup.style.maxWidth = `${Math.max(1, rightBound - leftBound)}px`;
      popup.style.maxHeight = `${Math.max(1, bottomBound - topBound)}px`;
      const size = popup.getBoundingClientRect();
      const left = clamp(name === "model" ? rect.right - size.width : rect.left, leftBound, rightBound - size.width);
      const above = Math.max(0, rect.top - 6 - topBound), below = Math.max(0, bottomBound - rect.bottom - 6);
      const up = size.height <= above || (size.height > below && above >= below);
      popup.style.maxHeight = `${Math.max(1, up ? above : below)}px`;
      const finalSize = popup.getBoundingClientRect();
      popup.style.left = `${left}px`;
      popup.style.top = `${clamp(up ? rect.top - 6 - finalSize.height : rect.bottom + 6, topBound, bottomBound - finalSize.height)}px`;
      popup.dataset.chatPlacement = up ? "top" : "bottom";
      popup.dataset.chatPositioned = "true";
      popup.style.visibility = "";
      for (const { node, top, left } of scrollPositions) { node.scrollTop = top; node.scrollLeft = left; }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(position); };
    position();
    if (popup.style.visibility !== "hidden") (popup.querySelector<HTMLElement>("input:not(:disabled)") ?? popup.querySelector<HTMLElement>("button:not(:disabled)") ?? popup).focus({ preventScroll: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(popup);
    // 观察按钮到工作区祖先：输入区高度、栏宽／pane变化与隐藏状态均重算。
    for (let node: HTMLElement | null = trigger; node; node = node.parentElement) observer?.observe(node);
    if (scopeRef.current) observer?.observe(scopeRef.current);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
    };
  }, [name, scopeRef, getTrigger]);
  return createPortal(<div ref={popupRef} id={`${scopeId}-config-${name}`} className={`chat-config-pop ${className}`} data-chat-overlay={name} data-chat-overlay-owner={scopeId} role="dialog" aria-label={label} tabIndex={-1}>{children}</div>, document.body);
}
