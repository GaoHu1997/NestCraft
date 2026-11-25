import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icons";

/** 右键菜单条目：分隔线用 { kind: "sep" }，其余为可执行菜单项。 */
export type ContextMenuEntry =
  | { kind: "item"; key: string; label: string; icon: string; danger?: boolean }
  | { kind: "sep" };

type ItemEntry = Extract<ContextMenuEntry, { kind: "item" }>;

/**
 * CR-090 文件树右键菜单：指针处出现并夹紧视口，↑↓ 移动、Enter 执行、Esc 关闭、点击外部关闭。
 * 容器最小宽 196px、最大高 380px 内部滚动；滚动条按 UI-SCROLL-001：滚动时显示、停止约 700ms 后隐藏。
 */
export function FileContextMenu({ x, y, entries, onSelect, onClose }: {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
  const items = entries.filter((entry): entry is ItemEntry => entry.kind === "item");

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
    setPos({ left, top, ready: true });
    element.focus();
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [onClose]);

  const run = (index: number) => {
    const entry = items[index];
    if (entry) onSelect(entry.key);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = items.length;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); setActive(a => count ? (a + 1) % count : 0); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); event.stopPropagation(); setActive(a => count ? (a - 1 + count) % count : 0); return; }
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); run(active); }
  };

  const onScroll = () => {
    const element = ref.current;
    if (!element) return;
    element.classList.add("ft-scrolling");
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => element.classList.remove("ft-scrolling"), 700);
  };

  return createPortal(
    <div
      ref={ref}
      className="ft-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
      onKeyDown={onKeyDown}
      onScroll={onScroll}
      onContextMenu={event => event.preventDefault()}
    >
      {entries.map((entry, index) => {
        if (entry.kind === "sep") return <div key={`sep-${index}`} className="ft-menu-sep" role="separator" />;
        const itemIndex = items.indexOf(entry);
        return (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            className={`ft-menu-item${entry.danger ? " danger" : ""}${itemIndex === active ? " kb" : ""}`}
            onMouseEnter={() => setActive(itemIndex)}
            onClick={() => onSelect(entry.key)}
          >
            <Icon name={entry.icon} size={14} />
            <span>{entry.label}</span>
          </button>
        );
      })}
    </div>,
    document.body
  );
}
