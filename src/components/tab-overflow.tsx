/**
 * UI-CR052-v1 / UI-TAB-001：页签条溢出统一规则（共享 hook + 「更多」下拉）。
 * 移植设计基准 `workbench-v4/tab-overflow.js`／`tab-overflow.css`
 * （sha256 见 docs/Test/cr052-design-baseline.json），React 化为声明式接入：
 * - 页签条不出现横向滚动条（overflow:hidden 由各页签条样式与 .tab-more 机制保证）；
 * - 放不下时在末尾出现 26px 下箭头「更多」图标按钮；放得下时不显示、不占位；
 * - 收缩算法保序且优先保留选中页签：选中项先占额度，其余从前往后填充至可用宽
 *   （容器宽 − 26px），放不下的页签置 `hidden`（元素仍在 DOM，原有事件不变）；
 * - 被收起数量写入「更多」按钮 aria-label；
 * - 点击「更多」悬浮下拉按原顺序列出全部页签（当前项高亮），选择即切换并关闭；
 *   点击外部、再次点击图标、Escape 关闭；容器宽度变化（含拖宽/窄屏）重新计算。
 * 下拉自身 `overflow-y:auto`，滚动条显隐由 UI-CR049 共享规则承担。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icons";

export interface TabOverflowItem {
  /** 页签稳定 key，同时作为下拉项 key 与 onPick 参数。 */
  key: string;
  /** 下拉项标题（单行省略）。 */
  label: string;
  /** 可选编号（需求页签），弱化等宽展示。 */
  sub?: string;
  /** 当前是否选中。 */
  active?: boolean;
}

const MORE_WIDTH = 26;

export function useTabOverflow<E extends HTMLElement = HTMLDivElement>(options: {
  /** 相对宿主（无宿主时为页签条本身）的直接子页签选择器，如 ".pw-tab"。 */
  tabSelector: string;
  /** 与 DOM 页签顺序一致的数据；仅用于下拉列表与选中项定位。 */
  items: TabOverflowItem[];
  /** 重新测量的数据依据（页签集合、标题、选中项变化）。 */
  deps: React.DependencyList;
}) {
  const { tabSelector, items } = options;
  const barRef = useRef<E | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const layout = useCallback(() => {
    const host = hostRef.current ?? barRef.current;
    const more = moreRef.current;
    if (!host || !more) return;
    const tabs = Array.from(host.querySelectorAll<HTMLElement>(`:scope > ${tabSelector}`));
    tabs.forEach(tab => { tab.hidden = false; });
    more.style.display = "none";
    host.classList.remove("is-overflow");
    if (!tabs.length) return;
    const avail = host.clientWidth;
    const widths = tabs.map(tab => tab.offsetWidth);
    const total = widths.reduce((sum, w) => sum + w, 0);
    if (total <= avail) return;
    host.classList.add("is-overflow");
    more.style.display = "grid";
    const usable = Math.max(0, avail - MORE_WIDTH);
    const active = itemsRef.current.findIndex(item => item.active);
    const keep = new Set<number>();
    let used = 0;
    if (active >= 0 && active < widths.length && widths[active] <= usable) { keep.add(active); used += widths[active]; }
    for (let i = 0; i < tabs.length; i++) {
      if (keep.has(i)) continue;
      if (used + widths[i] > usable) break;
      keep.add(i); used += widths[i];
    }
    tabs.forEach((tab, i) => { tab.hidden = !keep.has(i); });
    const hidden = tabs.length - keep.size;
    more.dataset.hiddenCount = String(hidden);
    more.setAttribute("aria-label", hidden ? `显示全部页签（另有 ${hidden} 个）` : "显示全部页签");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabSelector]);

  useLayoutEffect(() => { layout(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [layout, ...options.deps]);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => layout());
    observer.observe(bar);
    return () => observer.disconnect();
  }, [layout]);

  const relayout = useCallback(() => layout(), [layout]);
  useEffect(() => {
    window.addEventListener("resize", relayout);
    return () => window.removeEventListener("resize", relayout);
  }, [relayout]);

  // 下拉打开期间：Escape / 外部按下 / 窗口缩放关闭。
  useEffect(() => {
    if (!dropdownOpen) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); setDropdownOpen(false); }
    };
    const press = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target instanceof Element && target.closest(".tab-more-pop")) return;
      if (moreRef.current?.contains(target)) return; // 图标按钮自身 toggle
      setDropdownOpen(false);
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("mousedown", press, true);
    window.addEventListener("resize", relayout);
    const close = () => setDropdownOpen(false);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("mousedown", press, true);
      window.removeEventListener("resize", relayout);
      window.removeEventListener("blur", close);
    };
  }, [dropdownOpen, relayout]);

  const moreProps = {
    ref: moreRef,
    className: "tab-more",
    type: "button" as const,
    "aria-haspopup": "menu" as const,
    "aria-expanded": dropdownOpen,
    onClick: (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDropdownOpen(value => !value);
    },
  };

  return { barRef, hostRef, moreRef, moreProps, dropdownOpen, closeDropdown: useCallback(() => setDropdownOpen(false), []) };
}

/** 「更多」悬浮下拉：右对齐图标、r.bottom+4，超出视口底部翻转；左右 8px 安全边距。 */
export function TabMoreDropdown({ anchorRef, items, onPick, onClose }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  items: TabOverflowItem[];
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement | null>(null);
  const posRef = useRef<{ left: number; top: number } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const pop = popRef.current, anchor = anchorRef.current;
    if (!pop || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = pop.offsetWidth, height = pop.offsetHeight;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
    if (posRef.current?.left !== left || posRef.current?.top !== top) {
      posRef.current = { left, top };
      setPos({ left, top });
    }
  }, [items.length, anchorRef]);
  return createPortal(
    <div ref={popRef} className="tab-more-pop" role="menu" style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}>
      <div className="tab-more-pop-h">共 {items.length} 个页签</div>
      {items.map((item, index) => (
        <button key={`${item.key}:${index}`} type="button" role="menuitem" className={`tab-more-item ${item.active ? "on" : ""}`}
          title={item.label} onClick={() => { onPick(item.key); onClose(); }}>
          {item.sub ? <span className="tab-more-key">{item.sub}</span> : null}
          <span className="ellipsis">{item.label}</span>
        </button>
      ))}
    </div>, document.body);
}

/** 「更多」图标按钮的图标内容（下箭头，与设计基准一致）。 */
export function TabMoreIcon() {
  return <Icon name="down" size={14} />;
}
