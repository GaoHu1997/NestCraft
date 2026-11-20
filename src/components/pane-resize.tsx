import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./pane-resize.css";

/** UI-CR045-v1 / SC-045-08. Width/visibility preferences live only in this session. */
export type PaneSide = "left" | "right";
export type PaneBudget = number | (() => number);
export interface PaneWidthOptions {
  default: number;
  min: number;
  max: number;
  side: PaneSide;
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Controlled visibility. Omit for automatic narrow-layout collapse + session toggles. */
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
  /** Other panes + fixed rails/gaps, excluding this pane and minCenter. */
  reserve?: PaneBudget;
  /** Optional final inline width budget, in addition to container - reserve - minCenter. */
  maxAvailable?: PaneBudget;
  minCenter?: number;
  /** Always float instead of occupying horizontal layout space (e.g. history). */
  overlay?: boolean;
  overlayInset?: number;
  disabled?: boolean;
}

export interface PaneLayout {
  preferred: number;
  effective: number;
  min: number;
  max: number;
  visible: boolean;
  overlay: boolean;
}

export interface PaneWidthController extends PaneLayout {
  scope: string;
  pane: string;
  side: PaneSide;
  width: number;
  disabled: boolean;
  isResizing: boolean;
  style: React.CSSProperties;
  paneProps: React.HTMLAttributes<HTMLElement> & {
    "data-pane-side": PaneSide;
    "data-pane-scope": string;
    "data-pane-name": string;
  };
  setWidth: (width: number | ((preferred: number) => number)) => void;
  reset: () => void;
  setVisible: (visible: boolean) => void;
  toggle: () => void;
  refresh: () => void;
  /** Stable for this object/pane/side/container; used to reject stale captured gestures. */
  readonly identity: object;
  /** Used by ResizeHandle; applications normally only read isResizing. */
  setResizing: (resizing: boolean) => void;
}

interface Preference { width?: number; visible?: boolean }
const preferences = new Map<string, Preference>();
const subscribers = new Map<string, Set<() => void>>();
const activeHandles = new Set<HTMLElement>();
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const finite = (value: number | undefined, fallback: number) => Number.isFinite(value) ? value! : fallback;
const readBudget = (value: PaneBudget | undefined, fallback: number) => {
  const result = typeof value === "function" ? value() : value;
  return Math.max(0, finite(result, fallback));
};

/** Pure layout calculation, also usable in dependency-free unit tests. Never writes preferences. */
export function getPaneLayout(
  options: PaneWidthOptions,
  preferred: number,
  containerWidth?: number,
  visible = options.visible,
): PaneLayout {
  const min = Math.max(0, finite(options.min, 0));
  const max = Math.max(min, finite(options.max, min));
  preferred = clamp(finite(preferred, finite(options.default, min)), min, max);
  const measured = Number.isFinite(containerWidth) && containerWidth! > 0;
  const containerBudget = measured
    ? Math.max(0, containerWidth! - readBudget(options.reserve, 0) - Math.max(0, finite(options.minCenter, 320)))
    : max;
  const budget = Math.min(max, containerBudget, readBudget(options.maxAvailable, max));
  const open = visible ?? (options.overlay || budget >= min);
  const overlay = Boolean(open && (options.overlay || budget < min));
  const upper = overlay
    ? Math.min(max, measured ? Math.max(0, containerWidth! - Math.max(0, finite(options.overlayInset, 16))) : max)
    : budget;
  const lower = Math.min(min, upper);
  return { preferred, effective: open ? clamp(preferred, lower, upper) : 0, min: lower, max: upper, visible: Boolean(open), overlay };
}

function savePreference(key: string, patch: Preference) {
  preferences.set(key, { ...preferences.get(key), ...patch });
  subscribers.get(key)?.forEach(notify => notify());
}

export function usePaneWidth(scope: string, pane: string, options: PaneWidthOptions): PaneWidthController {
  const key = JSON.stringify([scope, pane]);
  const identity = useMemo(() => ({}), [key, options.side, options.containerRef]);
  const [revision, rerender] = useState(0);
  const [isResizing, setResizing] = useState(false);
  const measure = useRef<{ element: HTMLElement | null; width?: number }>({ element: null });
  const current = useRef({ key, options });
  current.current = { key, options };
  const refresh = useCallback(() => {
    const element = current.current.options.containerRef?.current ?? null;
    const width = element?.getBoundingClientRect().width;
    if (measure.current.element !== element) measure.current = { element };
    // A hidden/zero-sized observer notification is not a new user width or a useful budget.
    if (width && Number.isFinite(width)) measure.current.width = width;
    rerender(value => value + 1);
  }, []);

  useLayoutEffect(() => {
    const notify = () => rerender(value => value + 1);
    const listeners = subscribers.get(key) ?? new Set<() => void>();
    listeners.add(notify); subscribers.set(key, listeners);
    return () => { listeners.delete(notify); if (!listeners.size) subscribers.delete(key); };
  }, [key]);

  // Check ref identity after each commit, including a pane whose container was mounted later.
  const observed = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (observed.current !== (options.containerRef?.current ?? null)) refresh();
  });
  useLayoutEffect(() => {
    const element = options.containerRef?.current ?? null;
    observed.current = element;
    const win = element?.ownerDocument.defaultView ?? (typeof window !== "undefined" ? window : null);
    if (!win) return;
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = win.requestAnimationFrame(() => { frame = 0; refresh(); });
    };
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    const observe = () => {
      observer?.disconnect();
      if (element) {
        observer?.observe(element);
        // Neighbour widths can change without resizing the container itself.
        Array.from(element.children).forEach(child => observer?.observe(child));
      }
    };
    const mutation = element && typeof MutationObserver !== "undefined" ? new MutationObserver(() => { observe(); schedule(); }) : null;
    observe(); mutation?.observe(element!, { childList: true });
    win.addEventListener("resize", schedule);
    refresh();
    return () => {
      observer?.disconnect(); mutation?.disconnect(); win.removeEventListener("resize", schedule);
      if (frame) win.cancelAnimationFrame(frame);
    };
  }, [identity, options.containerRef?.current, refresh]);

  const preference = preferences.get(key);
  const requestedVisibility = options.visible ?? preference?.visible;
  const fallbackWidth = Math.max(0, finite(options.default, options.min));
  const layout = getPaneLayout(options, preference?.width ?? fallbackWidth, measure.current.width, requestedVisibility);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const setWidth = useCallback((value: number | ((preferred: number) => number)) => {
    const { key: liveKey, options: spec } = current.current;
    const old = preferences.get(liveKey)?.width ?? spec.default;
    const next = typeof value === "function" ? value(old) : value;
    if (!Number.isFinite(next)) return;
    const lower = Math.max(0, finite(spec.min, 0));
    savePreference(liveKey, { width: clamp(next, lower, Math.max(lower, finite(spec.max, lower))) });
  }, []);
  const reset = useCallback(() => setWidth(current.current.options.default), [setWidth]);
  const setVisible = useCallback((visible: boolean) => {
    const { key: liveKey, options: spec } = current.current;
    if (spec.visible === undefined) savePreference(liveKey, { visible });
    spec.onVisibleChange?.(visible);
  }, []);
  const toggle = useCallback(() => setVisible(!layoutRef.current.visible), [setVisible]);
  const style: React.CSSProperties = {
    width: layout.effective, minWidth: 0, maxWidth: "none", flexShrink: 0,
    "--pane-width": `${layout.effective}px`,
  } as React.CSSProperties;
  // revision is deliberately used only to sample session preferences/DOM-derived budgets.
  void revision;
  return {
    ...layout, scope, pane, side: options.side, width: layout.effective,
    disabled: Boolean(options.disabled), isResizing, identity, style,
    paneProps: {
      className: `resizable-pane${layout.overlay ? " pane-overlay" : ""}${layout.visible ? "" : " pane-collapsed"}`,
      style, hidden: !layout.visible, "aria-hidden": layout.visible ? undefined : true,
      "data-pane-side": options.side, "data-pane-scope": scope, "data-pane-name": pane,
    },
    setWidth, reset, setVisible, toggle, refresh, setResizing,
  };
}

export interface ResizeHandleProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  pane: PaneWidthController;
  label: string;
  controls?: string;
}
interface Gesture {
  element: HTMLDivElement;
  id: number;
  identity: object;
  side: PaneSide;
  startX: number;
  startWidth: number;
  nextX: number;
  moved: boolean;
  frame: number;
  cleanup: () => void;
}

function rendered(element: HTMLElement) {
  return element.isConnected && !element.ownerDocument.hidden && element.getClientRects().length > 0
    && element.ownerDocument.defaultView?.getComputedStyle(element).visibility !== "hidden";
}
function draggingClass(element: HTMLElement, active: boolean) {
  if (active) activeHandles.add(element); else activeHandles.delete(element);
  const body = element.ownerDocument.body;
  body.classList.toggle("pane-dragging", Array.from(activeHandles).some(handle => handle.ownerDocument === element.ownerDocument));
}

export function ResizeHandle({ pane, label, controls, className = "", ...props }: ResizeHandleProps) {
  const latest = useRef(pane); latest.current = pane;
  const gesture = useRef<Gesture | null>(null);
  const alive = useRef(true);
  const stop = useCallback(() => {
    const old = gesture.current;
    if (!old) return;
    gesture.current = null;
    const win = old.element.ownerDocument.defaultView;
    if (old.frame) win?.cancelAnimationFrame(old.frame);
    old.cleanup(); draggingClass(old.element, false);
    try { if (old.element.hasPointerCapture(old.id)) old.element.releasePointerCapture(old.id); } catch { /* removed WebView target */ }
    if (alive.current) latest.current.setResizing(false);
  }, []);
  const valid = useCallback((g: Gesture) => {
    const live = latest.current;
    return live.identity === g.identity && live.visible && !live.disabled && rendered(g.element);
  }, []);
  const flush = useCallback(() => {
    const g = gesture.current;
    if (!g || !g.moved) return;
    g.frame = 0;
    if (!valid(g)) { stop(); return; }
    const live = latest.current;
    live.setWidth(clamp(g.startWidth + (g.nextX - g.startX) * (g.side === "right" ? -1 : 1), live.min, live.max));
  }, [stop, valid]);

  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; stop(); };
  }, [stop]);
  useLayoutEffect(() => { stop(); }, [pane.identity, pane.visible, pane.disabled, stop]);

  if (!pane.visible) return null;
  return <div
    {...props}
    className={`pane-handle ${pane.side}${pane.isResizing ? " is-resizing" : ""} ${className}`.trim()}
    role="separator" tabIndex={pane.disabled ? -1 : (props.tabIndex ?? 0)}
    aria-orientation="vertical" aria-label={props["aria-label"] ?? `调整${label}宽度`}
    aria-controls={controls ?? props["aria-controls"]} aria-valuemin={pane.min} aria-valuemax={pane.max}
    aria-valuenow={pane.effective} aria-disabled={pane.disabled || undefined}
    title={props.title ?? "拖动调整宽度；方向键调整，Home/End 到边界，双击恢复默认"}
    onPointerDown={event => {
      props.onPointerDown?.(event);
      if (event.defaultPrevented || event.button !== 0 || !event.isPrimary || latest.current.disabled || !rendered(event.currentTarget)) return;
      stop(); event.preventDefault(); event.stopPropagation();
      const element = event.currentTarget; // capture belongs to the handle, never the pane/event.target.
      element.focus({ preventScroll: true });
      try { element.setPointerCapture(event.pointerId); } catch { return; }
      const doc = element.ownerDocument, win = doc.defaultView!;
      const g: Gesture = {
        element, id: event.pointerId, identity: latest.current.identity, side: latest.current.side,
        startX: event.clientX, startWidth: latest.current.effective, nextX: event.clientX, moved: false, frame: 0, cleanup: () => {},
      };
      const checkHidden = () => { if (!valid(g)) stop(); };
      const observer = typeof MutationObserver !== "undefined" ? new MutationObserver(checkHidden) : null;
      for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
        observer?.observe(parent, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
      }
      const sizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(checkHidden) : null;
      sizeObserver?.observe(element);
      win.addEventListener("blur", stop); doc.addEventListener("visibilitychange", checkHidden);
      g.cleanup = () => {
        observer?.disconnect(); sizeObserver?.disconnect();
        win.removeEventListener("blur", stop); doc.removeEventListener("visibilitychange", checkHidden);
      };
      gesture.current = g; draggingClass(element, true); latest.current.setResizing(true);
    }}
    onPointerMove={event => {
      props.onPointerMove?.(event);
      const g = gesture.current;
      if (!g || g.element !== event.currentTarget || g.id !== event.pointerId) return;
      if (!valid(g)) { stop(); return; }
      g.nextX = event.clientX;
      g.moved = g.moved || g.nextX !== g.startX;
      if (g.moved && !g.frame) g.frame = g.element.ownerDocument.defaultView!.requestAnimationFrame(flush);
    }}
    onPointerUp={event => {
      props.onPointerUp?.(event);
      const g = gesture.current;
      if (!g || g.element !== event.currentTarget || g.id !== event.pointerId) return;
      if (g.frame) g.element.ownerDocument.defaultView?.cancelAnimationFrame(g.frame);
      g.nextX = event.clientX;
      g.moved = g.moved || g.nextX !== g.startX;
      if (g.moved) flush();
      stop();
    }}
    onPointerCancel={event => { props.onPointerCancel?.(event); if (gesture.current?.id === event.pointerId) stop(); }}
    onLostPointerCapture={event => { props.onLostPointerCapture?.(event); if (gesture.current?.id === event.pointerId) stop(); }}
    onDoubleClick={event => {
      props.onDoubleClick?.(event);
      if (event.defaultPrevented || latest.current.disabled) return;
      event.preventDefault(); event.stopPropagation(); stop(); latest.current.reset();
    }}
    onKeyDown={event => {
      props.onKeyDown?.(event);
      if (event.defaultPrevented || latest.current.disabled || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "Escape" && gesture.current) { event.preventDefault(); stop(); return; }
      const live = latest.current, step = event.shiftKey ? 20 : 10;
      const direction = live.side === "right" ? -1 : 1;
      const value = event.key === "Home" ? live.min : event.key === "End" ? live.max
        : event.key === "ArrowLeft" ? live.effective - step * direction
        : event.key === "ArrowRight" ? live.effective + step * direction : undefined;
      if (value === undefined) return;
      event.preventDefault(); event.stopPropagation(); stop(); live.setWidth(clamp(value, live.min, live.max));
    }}
  />;
}

export interface PaneToggleProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  pane: PaneWidthController;
  label: string;
  controls?: string;
}
export function PaneToggle({ pane, label, controls, children, className = "", onClick, ...props }: PaneToggleProps) {
  return <button {...props} type="button" className={`pane-toggle ${className}`.trim()}
    aria-controls={controls ?? props["aria-controls"]} aria-expanded={pane.visible}
    aria-label={props["aria-label"] ?? `${pane.visible ? "收起" : "展开"}${label}`}
    title={props.title ?? `${pane.visible ? "收起" : "展开"}${label}`}
    onClick={event => { onClick?.(event); if (!event.defaultPrevented) { event.stopPropagation(); pane.toggle(); } }}
  >{children ?? label}</button>;
}
export function PaneClose({ pane, label, controls, children, className = "", onClick, ...props }: PaneToggleProps) {
  return <button {...props} type="button" className={`pane-toggle pane-close ${className}`.trim()}
    aria-controls={controls ?? props["aria-controls"]} aria-label={props["aria-label"] ?? `收起${label}`}
    title={props.title ?? `收起${label}`}
    onClick={event => { onClick?.(event); if (!event.defaultPrevented) { event.stopPropagation(); pane.setVisible(false); } }}
  >{children ?? "×"}</button>;
}
