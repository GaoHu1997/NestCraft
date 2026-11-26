// CR-097 / SC-097-03：知识库图片查看器。支持缩放（10%–800%）、拖拽平移与同目录多图切换。
// 只读：不写回原件、不发起写操作；关闭后焦点回到触发元素（UI-CR097-v1）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icons";
import "./image-zoom.css";

export interface ZoomItem { src: string; name: string; }

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const STEP = 1.1;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function ImageZoomViewer({ items, index, onIndexChange, onClose, origin, label }: {
  items: ZoomItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  origin?: HTMLElement | null;
  label?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const originRef = useRef<HTMLElement | null>(origin ?? null);
  originRef.current = origin ?? null;
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const count = items.length;
  const safeIndex = count ? Math.min(Math.max(index, 0), count - 1) : 0;
  const current = items[safeIndex];

  const reset = useCallback(() => { setScale(1); setPan({ x: 0, y: 0 }); }, []);
  useEffect(() => { reset(); }, [safeIndex, reset]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      const owns = active === document.body || (active !== null && element.contains(active));
      if (element.open) element.close();
      const back = originRef.current;
      if (owns && back?.isConnected && !back.closest("[hidden], [inert]") && back.getClientRects().length) back.focus({ preventScroll: true });
    };
  }, []);

  // 滚轮缩放：只改查看倍率，不触发页面滚动。
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? STEP : 1 / STEP;
      setScale(value => clamp(Number((value * factor).toFixed(3)), MIN_SCALE, MAX_SCALE));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const step = (direction: number) => { if (count > 1) onIndexChange((safeIndex + direction + count) % count); };
  const zoomBy = (factor: number) => setScale(value => clamp(Number((value * factor).toFixed(3)), MIN_SCALE, MAX_SCALE));

  const onKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (count > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      step(event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (event.key === "0") { event.preventDefault(); reset(); return; }
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomBy(STEP); return; }
    if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomBy(1 / STEP); }
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const started = drag.current;
    if (!started) return;
    setPan({ x: started.panX + (event.clientX - started.x), y: started.panY + (event.clientY - started.y) });
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  if (!current) return null;
  const percent = Math.round(scale * 100);
  return createPortal(<dialog ref={dialog} className="kw-zoom" aria-label={label ?? "图片查看"} onKeyDown={onKeyDown}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="kw-zoom-bar">
      <span className="kw-zoom-name" title={current.name}>{current.name}</span>
      <span className="kw-zoom-percent" data-testid="zoom-percent">{percent}%</span>
      <button type="button" className="kw-zoom-btn" aria-label="缩小" disabled={scale <= MIN_SCALE} onClick={() => zoomBy(1 / STEP)}>−</button>
      <button type="button" className="kw-zoom-btn" aria-label="放大" disabled={scale >= MAX_SCALE} onClick={() => zoomBy(STEP)}>＋</button>
      <button type="button" className="kw-zoom-btn" aria-pressed={scale === 1 && pan.x === 0 && pan.y === 0} onClick={reset}>适应窗口</button>
      <button type="button" className="kw-zoom-btn" aria-pressed={scale === 1} onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}>100%</button>
      <span className="kw-zoom-spacer" />
      {count > 1 && <span className="kw-zoom-count" aria-live="polite">{safeIndex + 1} / {count}</span>}
      <button ref={closeButton} type="button" className="kw-zoom-close" aria-label="关闭查看器" onClick={onClose}>
        <Icon name="x" size={16} />
      </button>
    </div>
    <div ref={stage} className={`kw-zoom-stage ${dragging ? "dragging" : ""}`} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <img className="kw-zoom-image" src={current.src} alt={current.name} draggable={false}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }} />
      {count > 1 && <>
        <button type="button" className="kw-zoom-nav prev" aria-label="上一张" onClick={event => { event.stopPropagation(); step(-1); }}>‹</button>
        <button type="button" className="kw-zoom-nav next" aria-label="下一张" onClick={event => { event.stopPropagation(); step(1); }}>›</button>
      </>}
    </div>
    <p className="kw-zoom-foot">滚轮缩放 · 拖拽平移 · ←/→ 切换 · Esc 关闭 · 不修改原文件</p>
  </dialog>, document.body);
}
