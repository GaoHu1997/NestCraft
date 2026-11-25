/**
 * goto.ts —— 跳转编排（纯逻辑 + CodeMirror 扩展装配）。
 *
 * - gotoDefinitionAt(deps, offset)：0 → 「未找到定义」；1 → openAt；N → 打开多目标选择器；
 *   >20 → 「匹配过多，请更精确」；不支持语言 → 「当前文件类型暂不支持跳转」。
 * - 历史：跳转前记录起点、跳转后记录目标，供 historyBack/Forward 使用。
 * - 多目标选择器通过 onGotoPicker 通知宿主渲染 GotoPopup；pickGotoTarget/closeGotoPicker 供宿主回调。
 * - navigationExtension(opts)：把 Ctrl 悬停下划线装饰、mousedown 跳转挂到 CodeMirror；
 *   索引懒加载并缓存 Promise；只读导航，不 dispatch 文档变更。
 */
import { EditorView, ViewPlugin, Decoration } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { isNavGesture, onNavModifier } from "./modifier";
import { sharedIndex } from "./symbols";
import type { SymbolDef, SymbolIndex, TypeTarget } from "./symbols";
import { historyOf } from "./history";
import type { GotoTarget } from "./GotoPopup";
import "./navigation.css";

export interface GotoDeps {
  index: () => Promise<SymbolIndex>;
  openAt: (path: string, line: number, col?: number) => void;
  notify: (msg: string, kind?: "info" | "warn") => void;
  currentPath: () => string | null;
}

/* ---------------- 文本来源（由扩展在视图创建时注入） ---------------- */

let textProvider: (() => string | null) | null = null;

/** 注册当前编辑缓冲的文本来源（扩展内部使用；宿主通常无需调用）。 */
export function setGotoTextProvider(fn: (() => string | null) | null): void {
  textProvider = fn;
}

/* ---------------- 多目标选择器通道 ---------------- */

export interface GotoPickerState {
  open: boolean;
  title: string;
  targets: GotoTarget[];
}

type PickerListener = (state: GotoPickerState) => void;
const pickerListeners = new Set<PickerListener>();
let pickerState: GotoPickerState = { open: false, title: "", targets: [] };
let lastOpenAt: ((path: string, line: number, col?: number) => void) | null = null;

/** 订阅选择器状态；返回取消订阅函数。宿主用它驱动 <GotoPopup>。 */
export function onGotoPicker(fn: PickerListener): () => void {
  pickerListeners.add(fn);
  try {
    fn(pickerState);
  } catch {
    /* 忽略订阅者首次回调异常 */
  }
  return () => {
    pickerListeners.delete(fn);
  };
}

function emitPicker(state: GotoPickerState): void {
  pickerState = state;
  for (const fn of Array.from(pickerListeners)) {
    try {
      fn(state);
    } catch {
      /* 单个订阅异常不外抛 */
    }
  }
}

/** 宿主在 GotoPopup 的 onPick 中调用：记录目标位置并打开。 */
export function pickGotoTarget(target: GotoTarget): void {
  try {
    historyOf(target.path, target.line, target.col);
    const open = lastOpenAt;
    emitPicker({ open: false, title: "", targets: [] });
    if (open) open(target.path, target.line, target.col);
  } catch {
    /* 静默降级 */
  }
}

/** 宿主在 GotoPopup 的 onClose / 遮罩关闭中调用。 */
export function closeGotoPicker(): void {
  emitPicker({ open: false, title: "", targets: [] });
}

/* ---------------- 工具 ---------------- */

function lineColOfOffset(text: string, offset: number): { line: number; col: number } {
  const limit = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let start = 0;
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      start = i + 1;
    }
  }
  return { line, col: limit - start + 1 };
}

function wordRange(text: string, offset: number): { word: string; start: number; end: number } | null {
  const isId = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
  if (offset < 0 || offset > text.length) return null;
  let start = offset;
  if (start > 0 && isId(text[start - 1])) start--;
  else if (!(start < text.length && isId(text[start]))) return null;
  let end = start;
  while (start > 0 && isId(text[start - 1])) start--;
  while (end < text.length && isId(text[end])) end++;
  if (end <= start) return null;
  return { word: text.slice(start, end), start, end };
}

type ResolveResult = SymbolDef[] & { tooMany?: boolean };

function toTarget(def: SymbolDef): GotoTarget {
  const preview = (def as SymbolDef & { preview?: string }).preview ?? "";
  return { name: def.name, kind: def.kind, path: def.path, line: def.line, col: def.col, preview };
}

/** CR-094：继承关系目标 → 选择器条目，附带「直接实现 / 间接实现 / 父类型」标注。 */
function typeTargetToGoto(t: TypeTarget): GotoTarget {
  const note =
    t.relation === "super" ? "父类型" : t.relation === "indirect" ? `间接 · 经 ${t.via ?? "中间类"}` : "直接实现";
  return { ...toTarget(t), note };
}

/* ---------------- 跳转编排 ---------------- */

export async function gotoDefinitionAt(deps: GotoDeps, offset: number): Promise<void> {
  try {
    const path = deps.currentPath();
    if (!path) {
      deps.notify("未找到定义", "warn");
      return;
    }
    const index = await deps.index();
    if (!index.supports(path)) {
      deps.notify("当前文件类型暂不支持跳转", "warn");
      return;
    }
    const text = textProvider ? textProvider() : null;
    if (text == null) {
      deps.notify("未找到定义", "warn");
      return;
    }
    const defs = index.resolve(text, path, offset) as ResolveResult;
    if (defs.tooMany) {
      deps.notify("匹配过多，请更精确", "warn");
      return;
    }
    if (!defs.length) {
      deps.notify("未找到定义", "warn");
      return;
    }

    lastOpenAt = deps.openAt;
    const origin = lineColOfOffset(text, offset);
    historyOf(path, origin.line, origin.col);

    if (defs.length === 1) {
      const target = defs[0];
      historyOf(target.path, target.line, target.col);
      deps.openAt(target.path, target.line, target.col);
      return;
    }
    emitPicker({ open: true, title: `跳转到定义（${defs.length} 处）`, targets: defs.map(toTarget) });
  } catch {
    try {
      deps.notify("未找到定义", "warn");
    } catch {
      /* 提示失败也不得抛到编辑器外 */
    }
  }
}

/* ---------------- CR-094：实现类 / 父类型跳转 ---------------- */

/** 取光标处的标识符并交给查询函数，统一处理 0/1/N 三种结果。 */
async function gotoRelation(
  deps: GotoDeps,
  offset: number,
  query: (index: SymbolIndex, word: string, path: string) => TypeTarget[],
  labels: { empty: (word: string) => string; title: (word: string, count: number) => string }
): Promise<void> {
  try {
    const path = deps.currentPath();
    if (!path) {
      deps.notify(labels.empty(""), "warn");
      return;
    }
    const index = await deps.index();
    if (!index.supports(path)) {
      deps.notify("当前文件类型暂不支持跳转", "warn");
      return;
    }
    const text = textProvider ? textProvider() : null;
    if (text == null) {
      deps.notify(labels.empty(""), "warn");
      return;
    }
    const word = wordRange(text, offset);
    if (!word) {
      deps.notify(labels.empty(""), "warn");
      return;
    }
    const targets = query(index, word.word, path);
    if (!targets.length) {
      // 精度边界必须可见：不能静默给出「没有实现」的错觉。
      const note = index.precisionFor(path);
      deps.notify(note ? `${labels.empty(word.word)}（${note}）` : labels.empty(word.word), "warn");
      return;
    }

    lastOpenAt = deps.openAt;
    const origin = lineColOfOffset(text, offset);
    historyOf(path, origin.line, origin.col);

    if (targets.length === 1) {
      const t = targets[0]!;
      historyOf(t.path, t.line, t.col);
      deps.openAt(t.path, t.line, t.col);
      return;
    }
    emitPicker({ open: true, title: labels.title(word.word, targets.length), targets: targets.map(typeTargetToGoto) });
  } catch {
    try {
      deps.notify(labels.empty(""), "warn");
    } catch {
      /* 提示失败也不得抛到编辑器外 */
    }
  }
}

/** Ctrl+Alt+B：跳转到实现类 / 子类（含间接继承，标注在条目上）。 */
export function gotoImplementationsAt(deps: GotoDeps, offset: number): Promise<void> {
  return gotoRelation(deps, offset, (index, word, path) => index.implementationsOf(word, path), {
    empty: (word) => (word ? `未找到 ${word} 的实现` : "未找到实现"),
    title: (word, count) => `${word} 的实现（${count} 处）`,
  });
}

/** Ctrl+U：跳转到父类型（父类 / 接口）。 */
export function gotoSupertypesAt(deps: GotoDeps, offset: number): Promise<void> {
  return gotoRelation(deps, offset, (index, word, path) => index.supertypesOf(word, path), {
    empty: (word) => (word ? `未找到 ${word} 的父类型` : "未找到父类型"),
    title: (word, count) => `${word} 的父类型（${count} 处）`,
  });
}

/* ---------------- CodeMirror 扩展装配 ---------------- */

const setNavDeco = StateEffect.define<DecorationSet>();

const navDecoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setNavDeco)) return effect.value;
    }
    if (tr.docChanged) return Decoration.none;
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** 兜底索引：构建失败时支持全部语言但解析不到定义，避免误报「不支持」。 */
const FALLBACK_INDEX: SymbolIndex = {
  resolve: () => [],
  outline: () => [],
  supports: () => true,
  invalidate: () => {},
  implementationsOf: () => [],
  supertypesOf: () => [],
  precisionFor: () => null,
  typesInFile: () => [],
};

export function navigationExtension(opts: {
  rootUri: () => string;
  openAt: (path: string, line: number, col?: number) => void;
  notify: (msg: string, kind?: "info" | "warn") => void;
  currentPath: () => string | null;
}): Extension {
  let indexRoot = "";
  let indexPromise: Promise<SymbolIndex> | null = null;

  const getIndex = (): Promise<SymbolIndex> => {
    const root = opts.rootUri();
    if (!root) return Promise.resolve(FALLBACK_INDEX);
    if (!indexPromise || indexRoot !== root) {
      indexRoot = root;
      indexPromise = sharedIndex(root).catch(() => {
        indexPromise = null;
        return FALLBACK_INDEX;
      });
    }
    return indexPromise;
  };

  // 每个视图的悬停状态
  const generation = new WeakMap<EditorView, number>();
  const lastDeco = new WeakMap<EditorView, string>();
  let hoverHit: { from: number; to: number } | null = null;

  const setDeco = (view: EditorView, from: number, to: number): void => {
    const key = `${from}:${to}`;
    if (lastDeco.get(view) === key) return;
    lastDeco.set(view, key);
    try {
      view.dispatch({ effects: setNavDeco.of(Decoration.set([Decoration.mark({ class: "cda-nav-link" }).range(from, to)])) });
    } catch {
      /* 视图销毁等异常不抛 */
    }
  };

  const clearDeco = (view: EditorView): void => {
    hoverHit = null;
    if (lastDeco.get(view) === "") return;
    lastDeco.set(view, "");
    try {
      view.dispatch({ effects: setNavDeco.of(Decoration.none) });
    } catch {
      /* 忽略 */
    }
  };

  const handleHover = async (view: EditorView, event: MouseEvent): Promise<void> => {
    try {
      const gen = (generation.get(view) ?? 0) + 1;
      generation.set(view, gen);
      if (!isNavGesture(event)) {
        clearDeco(view);
        return;
      }
      if (event.buttons !== 0) return; // 拖拽选择时不加装饰
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) {
        clearDeco(view);
        return;
      }
      const text = view.state.doc.toString();
      const word = wordRange(text, pos);
      const path = opts.currentPath();
      if (!word || !path) {
        clearDeco(view);
        return;
      }
      const index = await getIndex();
      if (generation.get(view) !== gen) return;
      if (!index.supports(path)) {
        clearDeco(view);
        return;
      }
      let defs: SymbolDef[] = [];
      try {
        defs = index.resolve(text, path, word.start);
      } catch {
        defs = [];
      }
      if (generation.get(view) !== gen) return;
      if (defs.length > 0) {
        hoverHit = { from: word.start, to: word.end };
        setDeco(view, word.start, word.end);
      } else {
        clearDeco(view);
      }
    } catch {
      /* 悬停解析失败静默降级，不影响编辑 */
    }
  };

  class NavHoverPlugin {
    private off: () => void;
    constructor(private view: EditorView) {
      setGotoTextProvider(() => this.view.state.doc.toString());
      this.off = onNavModifier((held) => {
        if (!held) clearDeco(this.view);
      });
    }
    destroy(): void {
      this.off();
      hoverHit = null;
    }
    update(update: ViewUpdate): void {
      // 文档变化后装饰已被 StateField 清空，重置记录以便下次悬停重新装饰。
      if (update.docChanged) {
        lastDeco.delete(this.view);
        hoverHit = null;
      }
    }
  }

  const hoverPlugin = ViewPlugin.fromClass(NavHoverPlugin, {
    eventHandlers: {
      mousemove(event, view) {
        void handleHover(view, event);
      },
      mouseleave(_event, view) {
        clearDeco(view);
      },
    },
  });

  const clickHandler = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!isNavGesture(event) || event.button !== 0) return false;
      const hit = hoverHit;
      if (!hit) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      if (pos < hit.from - 1 || pos > hit.to + 1) return false;
      event.preventDefault();
      const offset = pos;
      clearDeco(view);
      void gotoDefinitionAt(
        { index: getIndex, openAt: opts.openAt, notify: opts.notify, currentPath: opts.currentPath },
        offset
      );
      return true;
    },
  });

  return [navDecoField, hoverPlugin, clickHandler];
}
