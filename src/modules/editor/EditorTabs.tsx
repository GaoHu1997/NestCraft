import { Icon } from "@/components/icons";
import { TabMoreDropdown, TabMoreIcon, useTabOverflow } from "@/components/tab-overflow";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import "./editor-tabs-drag.css";
/**
 * 编辑器页签（CR-014 AC-09）：文件名、脏标记圆点、× 关闭。
 * 多页签切换由 CodeArea 保留各自内容与滚动位置。
 * CR-052 / UI-TAB-001：溢出统一走共享「更多」下拉，不出现横向滚动条。
 * CR-090 / SC-090-05、06：预览态（斜体）与指针拖拽排序（Pointer Events，不用 HTML5 DnD）。
 */

export interface TabInfo {
  path: string;
  dirty: boolean;
  /** 预览页签（UI-CR090 SC-090-05）：斜体表达，可被下一次预览替换。 */
  preview?: boolean;
}

export function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 落点：gap 为原 tabs 数组中的插入缝隙下标（0..tabs.length），index/side 用于渲染指示线。 */
type DropTarget = { gap: number; index: number; side: "before" | "after" };

const DRAG_THRESHOLD = 4;

export function EditorTabs({
  tabs,
  active,
  onSelect,
  onClose,
  onReorder,
  onKeep,
}: {
  tabs: TabInfo[];
  active: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /** 拖拽完成回调：from/to 为 tabs 数组下标，to 为「重排后」的位置（把 tabs[from] 插入到 to）。 */
  onReorder?: (from: number, to: number) => void;
  /** 双击页签：预览转正式。 */
  onKeep?: (path: string) => void;
}) {
  const items = tabs.map(t => ({ key: t.path, label: baseName(t.path), active: active === t.path }));
  const sig = items.map(item => `${item.key}:${item.label}:${item.active ? 1 : 0}`).join("|");
  const overflow = useTabOverflow({ tabSelector: ".cda-tab", items, deps: [sig] });

  // 拖拽状态：dragIndex 让被拖页签半透明；drop 渲染插入指示线。
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const dragRef = useRef<{ from: number; startX: number; startY: number; active: boolean; pointerId: number; el: HTMLElement } | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  const draggingRef = useRef(false); // 拖拽已激活（供关闭按钮拦截）
  const suppressClickUntilRef = useRef(0); // 拖拽后短时抑制 click，避免误触 onSelect / 关闭
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  useEffect(() => {
    const clearDropMark = () => {
      dropRef.current = null;
      setDrop(null);
    };
    const reset = () => {
      const drag = dragRef.current;
      if (drag?.active) {
        try {
          if (drag.el.hasPointerCapture(drag.pointerId)) drag.el.releasePointerCapture(drag.pointerId);
        } catch { /* 捕获已释放 */ }
      }
      dragRef.current = null;
      draggingRef.current = false;
      clearDropMark();
      setDragIndex(null);
    };

    // 计算落点：按指针 x 与各「可见」页签中线比较，落在前/后即为该页签的插入缝。
    const computeDrop = (clientX: number): DropTarget | null => {
      const bar = overflow.barRef.current;
      if (!bar) return null;
      const els = Array.from(bar.querySelectorAll<HTMLElement>(":scope > .cda-tab")).filter(el => !el.hidden);
      if (!els.length) return null;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const idx = Number(el.dataset.index);
        if (clientX < r.left + r.width / 2) return { gap: idx, index: idx, side: "before" };
      }
      const last = els[els.length - 1];
      const lastIdx = Number(last.dataset.index);
      return { gap: lastIdx + 1, index: lastIdx, side: "after" };
    };

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        // 移动超过阈值才进入拖拽，避免与单击冲突。
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
        drag.active = true;
        draggingRef.current = true;
        // 指针捕获：保证拖出页签/窗口后仍能收到 pointerup、pointercancel。
        try { drag.el.setPointerCapture(e.pointerId); } catch { /* 不支持时退化为文档监听 */ }
        setDragIndex(drag.from);
      }
      const next = computeDrop(e.clientX);
      if (next) {
        const prev = dropRef.current;
        if (!prev || prev.index !== next.index || prev.side !== next.side || prev.gap !== next.gap) {
          dropRef.current = next;
          setDrop(next);
        }
      }
    };

    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const wasActive = drag.active;
      const from = drag.from;
      const target = dropRef.current;
      if (wasActive) suppressClickUntilRef.current = Date.now() + 300;
      reset();
      if (wasActive && target) {
        // 插入缝转「重排后」下标：把 tabs[from] 插入到 to。
        const to = target.gap > from ? target.gap - 1 : target.gap;
        if (to !== from) onReorderRef.current?.(from, to);
      }
    };

    const onCancel = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (drag.active) suppressClickUntilRef.current = Date.now() + 300;
      reset();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragRef.current) {
        if (dragRef.current.active) suppressClickUntilRef.current = Date.now() + 300;
        reset();
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [overflow.barRef]);

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>, index: number) => {
    if (e.button !== 0) return; // 仅左键
    const target = e.target as HTMLElement;
    if (target.closest(".cda-tab-close")) return; // 关闭按钮独立命中，不参与拖拽
    if (dragRef.current) return; // 已有拖拽会话
    dragRef.current = { from: index, startX: e.clientX, startY: e.clientY, active: false, pointerId: e.pointerId, el: e.currentTarget };
  };

  return (
    <>
      <div ref={overflow.barRef} className="cda-tabs" role="tablist" aria-label="打开的文件">
        {tabs.length === 0 && <span className="cda-tabs-empty muted small">无打开文件</span>}
        {tabs.map((t, i) => {
          const isDragging = dragIndex === i;
          const dropSide = drop && drop.index === i ? drop.side : null;
          return (
            <div
              key={t.path}
              role="tab"
              aria-selected={active === t.path}
              aria-grabbed={isDragging || undefined}
              data-index={i}
              title={t.path}
              className={`cda-tab clickable ${active === t.path ? "active" : ""} ${t.preview ? "cda-tab-preview" : ""} ${isDragging ? "cda-tab-dragging" : ""} ${dropSide === "before" ? "cda-tab-drop-before" : ""} ${dropSide === "after" ? "cda-tab-drop-after" : ""}`}
              onPointerDown={e => handlePointerDown(e, i)}
              onClick={() => {
                if (Date.now() < suppressClickUntilRef.current) return; // 拖拽后不触发选中
                onSelect(t.path);
              }}
              onDoubleClick={() => onKeep?.(t.path)}
            >
              <span className="cda-tab-name ellipsis">{baseName(t.path)}</span>
              {t.dirty && <span className="cda-dirty" title="有未保存修改" />}
              <button
                className="cda-tab-close"
                aria-label={`关闭 ${t.path}`}
                onClick={e => {
                  e.stopPropagation();
                  // 拖拽已激活或刚结束时不误触关闭。
                  if (draggingRef.current || Date.now() < suppressClickUntilRef.current) return;
                  onClose(t.path);
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          );
        })}
        {tabs.length > 0 && <button {...overflow.moreProps}><TabMoreIcon /></button>}
      </div>
      {overflow.dropdownOpen && <TabMoreDropdown anchorRef={overflow.moreRef} items={items} onPick={onSelect} onClose={overflow.closeDropdown} />}
    </>
  );
}
