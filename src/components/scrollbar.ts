/**
 * UI-CR049-v1 / UI-SCROLL-001：滚动条按需显示共享机制。
 * 移植设计基准 `workbench-v4/scrollbar.js`（sha256 78c43b2f…，见 docs/Test/cr049-design-baseline.json）：
 * - document 捕获阶段被动监听 scroll，按事件目标区分容器（嵌套/动态容器分别计时）；
 * - 实际滚动事件的容器加 `.scrollbar-active`，最后事件 700ms 后移除（连续滚动重置计时）；
 * - 悬停／聚焦不是唤醒条件；不取消默认行为、不改 overflow/宽度，textarea、contenteditable
 *   的光标、选区、撤销与自动保存保持原生机制；
 * - 主题色由 `src/theme/base.css` 的 `.scrollbar-active` 与 `::-webkit-scrollbar-*` 规则承担。
 * 在应用启动时安装一次（`src/main.tsx`），不绑定业务控件、不修改业务状态。
 */

const IDLE_DELAY_MS = 700;
const timers = new Map<Element, number>();
let installed = false;

function onScroll(event: Event): void {
  const raw = event.target;
  const el = raw === document ? document.scrollingElement : raw;
  if (!(el instanceof Element)) return;
  // 无溢出的容器不需要滑块（设计状态表 SC「无溢出／空内容」）。
  if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) return;
  const pending = timers.get(el);
  if (pending !== undefined) window.clearTimeout(pending);
  el.classList.add("scrollbar-active");
  timers.set(el, window.setTimeout(() => {
    el.classList.remove("scrollbar-active");
    timers.delete(el);
  }, IDLE_DELAY_MS));
}

export function installScrollbarReveal(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("pagehide", () => {
    timers.forEach((timer, el) => {
      window.clearTimeout(timer);
      el.classList.remove("scrollbar-active");
    });
    timers.clear();
  });
}
