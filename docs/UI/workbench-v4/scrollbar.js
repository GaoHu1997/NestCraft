/* CR-049：共享滚动状态，不重绘正文或改变业务状态。 */
(() => {
  "use strict";
  const idleDelay = 700;
  const timers = new Map();

  document.addEventListener("scroll", e => {
    const el = e.target === document ? document.scrollingElement : e.target;
    if (!(el instanceof Element)) return;
    if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) return;
    clearTimeout(timers.get(el));
    el.classList.add("scrollbar-active");
    timers.set(el, setTimeout(() => {
      el.classList.remove("scrollbar-active");
      timers.delete(el);
    }, idleDelay));
  }, { capture: true, passive: true });

  window.addEventListener("pagehide", () => {
    timers.forEach((timer, el) => {
      clearTimeout(timer);
      el.classList.remove("scrollbar-active");
    });
    timers.clear();
  });
})();
