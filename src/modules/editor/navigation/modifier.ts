/**
 * modifier.ts —— window 级主修饰键（Ctrl/⌘）状态。
 *
 * 主修饰键单独按下判定：Windows/Linux 为 ctrlKey 且 !metaKey；macOS 为 metaKey 且 !ctrlKey；
 * 两者都必须 !altKey && !shiftKey，避免与多选/组合键冲突。
 *
 * onNavModifier 使用 capture 监听 keydown/keyup/mousemove/blur，窗口 blur 时复位为未按住，
 * 防止切换应用后修饰键状态悬挂。模块级保存当前状态，navModifierHeld() 可直接读取。
 */

/** 是否 macOS（仅用于解释主修饰键是 ⌘ 还是 Ctrl）。 */
function isMac(): boolean {
  try {
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    const platform = String(nav?.platform ?? "");
    const ua = String(nav?.userAgent ?? "");
    return /Mac|iPhone|iPad|iPod/i.test(platform) || /Mac OS X/i.test(ua);
  } catch {
    return false;
  }
}

function gesture(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  if (e.altKey || e.shiftKey) return false;
  return isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** 主修饰键是否处于导航手势（Ctrl/⌘ 且无 Alt/Shift）。 */
export function isNavGesture(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return gesture(e);
}

let held = false;
let installed = false;
const listeners = new Set<(held: boolean) => void>();

function notify(next: boolean): void {
  if (held === next) return;
  held = next;
  for (const fn of Array.from(listeners)) {
    try {
      fn(next);
    } catch {
      /* 单个订阅异常不得影响其他订阅或编辑器 */
    }
  }
}

function fromEvent(e: KeyboardEvent | MouseEvent): boolean {
  return gesture({ ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey });
}

function onKeyDown(e: KeyboardEvent): void {
  notify(fromEvent(e));
}
function onKeyUp(e: KeyboardEvent): void {
  notify(fromEvent(e));
}
function onMouseMove(e: MouseEvent): void {
  // 鼠标移动时核对修饰键，可捕获「按下 Ctrl 后焦点丢失再松开」的情况。
  notify(fromEvent(e));
}
function onBlur(): void {
  notify(false);
}

function install(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("blur", onBlur, true);
}

function uninstall(): void {
  if (!installed) return;
  installed = false;
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("keyup", onKeyUp, true);
  window.removeEventListener("mousemove", onMouseMove, true);
  window.removeEventListener("blur", onBlur, true);
  notify(false);
}

/** 订阅主修饰键按下/松开；返回取消订阅函数。 */
export function onNavModifier(fn: (held: boolean) => void): () => void {
  listeners.add(fn);
  install();
  try {
    fn(held);
  } catch {
    /* 忽略订阅者首次回调异常 */
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) uninstall();
  };
}

/** 当前主修饰键是否按住。 */
export function navModifierHeld(): boolean {
  return held;
}
