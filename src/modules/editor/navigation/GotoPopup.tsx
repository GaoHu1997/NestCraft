/**
 * GotoPopup.tsx —— 多目标选择器（SC-090-08）。
 *
 * 绝对定位浮层（fixed，水平居中 + 距顶 120px）。每项：图标、符号名、相对路径:行、该行源码预览。
 * 支持输入过滤（名字/路径）、↑↓ 高亮、Enter/点击选择、Esc 关闭、点击外部关闭。
 * 宽 min(440px,92vw)，列表 max-height 300px 内部滚动；滚动条按 UI-SCROLL-001（全局 scrollbar.ts）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "@/components/icons";
import "./navigation.css";

export interface GotoTarget {
  name: string;
  kind: string;
  path: string;
  line: number;
  col: number;
  preview: string;
  /** CR-094：关系标注，如「直接实现」「间接 · 经 BaseService」「父类型」。 */
  note?: string;
}

function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

export function GotoPopup(props: {
  open: boolean;
  title: string;
  targets: GotoTarget[];
  onPick: (t: GotoTarget) => void;
  onClose: () => void;
}): JSX.Element | null {
  const { open, title, targets, onPick, onClose } = props;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((t) => {
      return t.name.toLowerCase().includes(q) || t.path.toLowerCase().includes(q);
    });
  }, [targets, query]);

  // 打开时重置过滤与高亮并聚焦输入
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  // 目标变化时把高亮夹回有效范围
  useEffect(() => {
    setActive((i) => Math.min(Math.max(0, i), Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDocDown, true);
    return () => document.removeEventListener("mousedown", onDocDown, true);
  }, [open, onClose]);

  // 让高亮项保持在可视区内
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.children[active] as HTMLElement | undefined;
    if (item && typeof item.scrollIntoView === "function") item.scrollIntoView({ block: "nearest" });
  }, [active, open, filtered.length]);

  if (!open) return null;

  const safeActive = Math.min(Math.max(0, active), Math.max(0, filtered.length - 1));

  const pick = (target: GotoTarget) => {
    onPick(target);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(filtered.length - 1, safeActive + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(0, safeActive - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = filtered[safeActive];
      if (target) pick(target);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      ref={rootRef}
      className="cda-nav-picker"
      role="dialog"
      aria-label={title}
      onKeyDown={onKeyDown}
    >
      <div className="cda-nav-picker-head">
        <Icon name="code" size={14} />
        <span>{title}</span>
      </div>
      <input
        ref={inputRef}
        className="cda-nav-picker-filter"
        type="text"
        value={query}
        placeholder="输入以过滤符号或路径"
        aria-label="过滤跳转目标"
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
      />
      <div className="cda-nav-picker-list" ref={listRef}>
        {filtered.length === 0 ? (
          <div className="cda-nav-picker-empty">无匹配</div>
        ) : (
          filtered.map((target, index) => (
            <button
              key={`${target.path}:${target.line}:${target.col}:${index}`}
              type="button"
              className={`cda-nav-pick${index === safeActive ? " active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(target)}
            >
              <span className="cda-nav-pick-ico" aria-hidden="true">
                <Icon name="code" size={13} />
              </span>
              <span className="cda-nav-pick-main">
                <span className="cda-nav-pick-name">{target.name}</span>
                {target.note ? <span className="cda-nav-pick-note">{target.note}</span> : null}
                <span className="cda-nav-pick-loc">
                  {shortPath(target.path)}:{target.line}
                </span>
                {target.preview ? <span className="cda-nav-pick-src">{target.preview}</span> : null}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
