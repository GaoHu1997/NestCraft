import "./turn-navigator.css";

/**
 * 回合导航小地图（纯展示组件）。
 *
 * 用途：在聊天区右侧渲染一条竖排刻度条，每个刻度对应一轮对话，点击调用 onJump 跳转；
 * 当前回合（activeId）高亮；条目较多时容器限高并纵向滚动。
 *
 * 约束：
 * - 纯展示、无副作用、无外部依赖，仅接收 props 并回调 onJump；
 * - 样式全部在 turn-navigator.css，类名前缀 `.chat-turn-nav-*`，颜色取既有 CSS 变量；
 * - 滚动遵守 UI-SCROLL-001：仅使用原生 overflow-y:auto，静止时滚动条透明，
 *   实际滚动由全局共享机制 src/components/scrollbar.ts 加 `.scrollbar-active` 着色，
 *   不在此文件切换宽度/display 实现显隐；
 * - 悬停标签：CSS 轻量 HoverCard（.chat-turn-nav-label），并以原生 title 兜底（无新依赖）。
 */

export type TurnNavKind = "user" | "assistant" | "tool";

export interface TurnNavItem {
  /** 回合唯一标识，与 onJump 回传值、activeId 比较一致。 */
  id: string;
  /** 悬停显示的回合摘要。 */
  label: string;
  /** 刻度样式类型；缺省按 assistant 处理。 */
  kind?: TurnNavKind;
}

export interface TurnNavigatorProps {
  items: TurnNavItem[];
  activeId?: string;
  onJump: (id: string) => void;
}

export function TurnNavigator(props: TurnNavigatorProps) {
  const { items, activeId, onJump } = props;
  if (items.length === 0) return null;

  return (
    <nav className="chat-turn-nav" aria-label="回合导航">
      {items.map(item => {
        const active = item.id === activeId;
        const kind: TurnNavKind = item.kind ?? "assistant";
        return (
          <button
            key={item.id}
            type="button"
            className={`chat-turn-nav-item kind-${kind}${active ? " is-active" : ""}`}
            title={item.label}
            aria-label={item.label}
            aria-current={active ? "true" : undefined}
            data-turn-id={item.id}
            onClick={() => onJump(item.id)}
          >
            <span className="chat-turn-nav-tick" aria-hidden="true" />
            <span className="chat-turn-nav-label">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
