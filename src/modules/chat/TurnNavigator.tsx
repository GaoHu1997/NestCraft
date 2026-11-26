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
 * - 悬停卡片：CSS HoverCard（.chat-turn-nav-label）+ 原生 title 兜底（无新依赖）。
 *
 * CR-096 R2（UI-CR096-v1）：卡片拆为「第 N 轮」+ 摘要两行、12px／232px。
 * 卡片用 position:fixed 并在悬停/聚焦时按刻度按钮真实坐标定位（placeLabel），
 * 避免被 overflow:auto 的窄容器横向/纵向裁切；容器不带 transform（会让 fixed
 * 退化成相对容器定位）。
 */

export type TurnNavKind = "user" | "assistant" | "tool";

export interface TurnNavItem {
  /** 回合唯一标识，与 onJump 回传值、activeId 比较一致。 */
  id: string;
  /** 卡片小标题，如「第 1 轮」。 */
  title: string;
  /** 卡片摘要正文，超两行由 CSS 省略。 */
  summary: string;
  /** 刻度样式类型；缺省按 assistant 处理。 */
  kind?: TurnNavKind;
}

export interface TurnNavigatorProps {
  items: TurnNavItem[];
  activeId?: string;
  onJump: (id: string) => void;
}

/** 悬停/聚焦时把 fixed 卡片摆到刻度左侧（贴真实屏幕坐标），并做视口回落。 */
function placeLabel(item: HTMLElement) {
  const label = item.querySelector<HTMLElement>(".chat-turn-nav-label");
  if (!label) return;
  // 卡片默认 opacity/visibility 隐藏，首帧量尺寸可能拿到 0：先临时置为可布局，
  // 量完还原再写坐标（写 left/top 不依赖可见性）。
  const prevOpacity = label.style.opacity;
  const prevVisibility = label.style.visibility;
  label.style.opacity = "1";
  label.style.visibility = "visible";
  const tick = item.getBoundingClientRect();
  const box = label.getBoundingClientRect();
  const w = Math.max(120, Math.round(box.width) || 232);
  const h = Math.max(40, Math.round(box.height) || 60);
  const gap = 10;
  // 优先贴刻度左侧；左侧空间不足时改到右侧，再不行夹回视口内。
  let left = tick.left - w - gap;
  if (left < 8) {
    const rightSide = tick.right + gap;
    left = rightSide + w <= window.innerWidth - 8 ? rightSide : Math.max(8, window.innerWidth - w - 8);
  }
  // 垂直以刻度中线对齐，并限制在视口内。
  let top = tick.top + tick.height / 2 - h / 2;
  top = Math.max(8, Math.min(top, Math.max(8, window.innerHeight - h - 8)));
  label.style.left = Math.round(left) + "px";
  label.style.top = Math.round(top) + "px";
  label.style.opacity = prevOpacity;
  label.style.visibility = prevVisibility;
}

export function TurnNavigator(props: TurnNavigatorProps) {
  const { items, activeId, onJump } = props;
  if (items.length === 0) return null;

  return (
    <nav className="chat-turn-nav" aria-label="回合导航">
      {items.map(item => {
        const active = item.id === activeId;
        const kind: TurnNavKind = item.kind ?? "assistant";
        const fullLabel = `${item.title}：${item.summary}`;
        return (
          <button
            key={item.id}
            type="button"
            className={`chat-turn-nav-item kind-${kind}${active ? " is-active" : ""}`}
            title={fullLabel}
            aria-label={fullLabel}
            aria-current={active ? "true" : undefined}
            data-turn-id={item.id}
            onMouseEnter={e => placeLabel(e.currentTarget)}
            onFocus={e => placeLabel(e.currentTarget)}
            onClick={() => onJump(item.id)}
          >
            <span className="chat-turn-nav-tick" aria-hidden="true" />
            <span className="chat-turn-nav-label" role="tooltip">
              <span className="chat-turn-nav-idx">{item.title}</span>
              <span className="chat-turn-nav-summary">{item.summary}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
