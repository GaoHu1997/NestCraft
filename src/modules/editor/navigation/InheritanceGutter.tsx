/**
 * InheritanceGutter.tsx —— 继承关系 gutter 标记（CR-094 SC-094-05）。
 *
 * 在类型声明行（class / interface / enum / record / struct）旁显示：
 * - `↓` 该类型有实现或子类（悬停显示数量，点击跳到第一个实现）
 * - `↑` 该类型有父类型（悬停显示来源，点击跳到第一个父类型）
 * - `↓↑` 两者都有
 *
 * 精度约束：数据来自语法索引，匿名类 / Lambda / 泛型实参 / 外部依赖中的实现看不到；
 * 因此 tooltip 一律附带「基于语法索引」的限定，不谎称完整。
 *
 * 性能：文档变化与视口变化后 400ms 防抖重算；只处理本文件的类型声明（通常个位数到几十个）。
 */
import { RangeSet, StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter } from "@codemirror/view";
import type { SymbolIndex } from "./symbols";
import "./navigation.css";

interface MarkerInfo {
  /** 1-based 行号（类型声明行）。 */
  line: number;
  implCount: number;
  superCount: number;
  /** 点击 ↓ 的目标。 */
  implTarget: { path: string; line: number; col: number } | null;
  /** 点击 ↑ 的目标。 */
  superTarget: { path: string; line: number; col: number } | null;
  title: string;
}

const setMarkers = StateEffect.define<MarkerInfo[]>();

const markersField = StateField.define<MarkerInfo[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setMarkers)) return effect.value;
    if (!tr.docChanged || !value.length) return value;
    // 编辑后按位置映射到新行，避免标记跳错行；下一次防抖重算会覆盖。
    return value.map((m) => {
      const pos = tr.state.doc.line(Math.min(m.line, tr.state.doc.lines)).from;
      return { ...m, line: tr.state.doc.lineAt(tr.changes.mapPos(pos, -1)).number };
    });
  },
});

class InheritanceMarker extends GutterMarker {
  constructor(readonly info: MarkerInfo, readonly kind: "down" | "up" | "both") {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof InheritanceMarker &&
      other.kind === this.kind &&
      other.info.title === this.info.title
    );
  }
  override toDOM(): Node {
    const el = document.createElement("span");
    el.className = `cda-nav-gutter-mark cda-nav-gutter-${this.kind}`;
    el.textContent = this.kind === "down" ? "↓" : this.kind === "up" ? "↑" : "↓↑";
    el.title = this.info.title;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", this.info.title);
    return el;
  }
}

const markerSets = new WeakMap<MarkerInfo[], RangeSet<GutterMarker>>();

function markerSet(items: readonly MarkerInfo[]): RangeSet<GutterMarker> {
  let set = markerSets.get(items as MarkerInfo[]);
  if (!set) {
    const ranges = items.map((info) => {
      const kind = info.implCount > 0 && info.superCount > 0 ? "both" : info.implCount > 0 ? "down" : "up";
      return new InheritanceMarker(info, kind).range(info.line - 1);
    });
    set = RangeSet.of(ranges, true);
    markerSets.set(items as MarkerInfo[], set);
  }
  return set;
}

interface GutterDeps {
  index: () => Promise<SymbolIndex | null>;
  currentPath: () => string | null;
  openAt: (path: string, line: number, col?: number) => void;
}

/** 收集当前文件的继承标记（纯函数，便于排查）。 */
export function collectMarkers(path: string, index: SymbolIndex): MarkerInfo[] {
  const out: MarkerInfo[] = [];
  let types;
  try {
    types = index.typesInFile(path);
  } catch {
    return out;
  }
  for (const type of types) {
    let impls, supers;
    try {
      impls = index.implementationsOf(type.name, path);
      supers = index.supertypesOf(type.name, path);
    } catch {
      continue;
    }
    if (!impls.length && !supers.length) continue;
    const parts: string[] = [];
    if (impls.length) parts.push(`${impls.length} 个实现或子类`);
    if (supers.length) {
      const names = [...new Set(supers.map((s) => s.name))].slice(0, 3).join(", ");
      parts.push(`父类型 ${names}`);
    }
    parts.push("基于语法索引，可能不全");
    out.push({
      line: type.line,
      implCount: impls.length,
      superCount: supers.length,
      implTarget: impls[0] ? { path: impls[0].path, line: impls[0].line, col: impls[0].col } : null,
      superTarget: supers[0] ? { path: supers[0].path, line: supers[0].line, col: supers[0].col } : null,
      title: `${type.name}：${parts.join(" · ")}`,
    });
  }
  return out;
}

class MarkersPlugin {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor(private readonly view: EditorView, private readonly deps: GutterDeps) {
    this.refresh();
  }

  update(update: { docChanged: boolean; viewportChanged: boolean }): void {
    if (update.docChanged || update.viewportChanged) this.refresh();
  }

  refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), 400);
  }

  private async run(): Promise<void> {
    const view = this.view;
    if (!view.dom.isConnected) return;
    const path = this.deps.currentPath();
    if (!path) return;
    const generation = ++this.generation;
    try {
      const index = await this.deps.index();
      if (!index || generation !== this.generation || !view.dom.isConnected) return;
      if (!index.supports(path)) {
        this.apply([]);
        return;
      }
      this.apply(collectMarkers(path, index));
    } catch {
      // 索引不可用时静默降级：不显示标记，不打断编辑。
      this.apply([]);
    }
  }

  private apply(items: MarkerInfo[]): void {
    const current = this.view.state.field(markersField);
    const same =
      current.length === items.length &&
      current.every((m, i) => m.line === items[i]!.line && m.title === items[i]!.title);
    if (same) return;
    try {
      this.view.dispatch({ effects: setMarkers.of(items) });
    } catch {
      /* 视图已销毁 */
    }
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.generation++;
  }
}

function markerAtLine(view: EditorView, lineNumber: number, dom: Element | null): MarkerInfo | null {
  const items = view.state.field(markersField, false) ?? [];
  const hit = items.find((m) => m.line === lineNumber);
  if (!hit) return null;
  const kind = (dom?.closest(".cda-nav-gutter-mark") as HTMLElement | null)?.className ?? "";
  // 点 ↓ 优先跳实现，点 ↑ 优先跳父类型，点合并标记则先实现。
  if (kind.includes("cda-nav-gutter-up") && hit.superTarget) return { ...hit, implTarget: null };
  return hit;
}

/** 继承 gutter 扩展；`index()` 可返回 null（索引尚未就绪）时静默不显示。 */
export function inheritanceGutter(deps: GutterDeps): Extension {
  return [
    markersField,
    ViewPlugin.fromClass(
      class extends MarkersPlugin {
        constructor(view: EditorView) {
          super(view, deps);
        }
      }
    ),
    gutter({
      class: "cda-nav-gutter",
      markers: (view) => markerSet(view.state.field(markersField)),
      domEventHandlers: {
        mousedown(view, line, event) {
          const e = event as MouseEvent;
          if (e.button !== 0) return false;
          const lineNumber = view.state.doc.lineAt(line.from).number;
          const info = markerAtLine(view, lineNumber, e.target instanceof Element ? e.target : null);
          if (!info) return false;
          const target = info.implTarget ?? info.superTarget;
          if (!target) return false;
          e.preventDefault();
          deps.openAt(target.path, target.line, target.col);
          return true;
        },
      },
    }),
  ];
}
