/**
 * 编码区（CR-014 AC-09）：左文件树 + 右页签栏 + CodeMirror 6 编辑器。
 * - 语言按扩展名：md/js/jsx/ts/tsx/py/json；行号由 basicSetup 默认开启。
 * - 修改 mark dirty；Ctrl+S = fsWriteFile(rootUri, path, content)，成功清脏标记并 toast。
 * - 非文本扩展名（png/jpg/pdf/zip/exe…）显示只读提示 Empty。
 * - 主题跟随 html[data-theme]（MutationObserver）：深色 oneDark，浅色默认。
 * - 字号读取 setting editor.fontSize（默认 13）。
 * - 多页签：切换时保存各自 EditorState、模式与阅读/编辑滚动位置，切回恢复。
 * - UI-CR045-v1 / SC-045-04：Markdown 默认阅读，阅读只投影当前缓冲，CodeMirror 保活。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EditorView, keymap } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { onLocate, takePendingLocate } from "@/modules/locate";
import type { LocateDetail } from "@/modules/locate";
import { basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import * as api from "@/api";
import { Confirm, Empty, renderMarkdown, useToast } from "@/components/ui";
import { PaneClose, PaneToggle, ResizeHandle, usePaneWidth } from "@/components/pane-resize";
import { FileTree } from "./FileTree";
import { EditorTabs, baseName } from "./EditorTabs";
import "./CodeArea.css";

const DEFAULT_FONT_SIZE = 13;

/** 定位高亮（一次性）：目标行整行高亮，文档再次编辑即清除，避免陈旧标记。 */
const setLineHighlight = StateEffect.define<number | null>();
const lineHighlightField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLineHighlight)) return e.value;
    if (tr.docChanged) return null;
    return value;
  },
  provide: f =>
    EditorView.decorations.from(f, (v): DecorationSet =>
      v == null ? Decoration.set([]) : Decoration.set([Decoration.line({ class: "cda-line-hl" }).range(v)])
    ),
});

function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 非文本扩展名集合（只读提示，不进编辑器）。 */
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "icns", "tif", "tiff", "pdf",
  "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "iso", "dmg", "img", "apk",
  "exe", "dll", "so", "dylib", "bin", "dat", "msi", "obj", "o", "a", "lib", "pdb",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "wav", "flac", "ogg", "mp4", "avi",
  "mov", "mkv", "webm", "db", "sqlite", "sqlite3", "jar", "class", "pyc", "pyo", "wasm",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
]);

function extOf(path: string): string {
  const b = baseName(path);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
}

const isBinaryPath = (path: string) => BINARY_EXT.has(extOf(path));
const isMarkdownPath = (path: string) => ["md", "markdown"].includes(extOf(path));

/** 语言按扩展名选择（未识别的返回空数组 = 纯文本）。 */
function languageFor(path: string): Extension | Extension[] {
  switch (extOf(path)) {
    case "md":
    case "markdown":
      return markdown();
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "py":
      return python();
    case "json":
      return json();
    default:
      return [];
  }
}

const fontTheme = (px: number): Extension => EditorView.theme({ "&": { fontSize: `${px}px`, lineHeight: "1.6" } });

/** 跟随 html[data-theme]（MutationObserver）。 */
function useHtmlTheme(): "light" | "dark" {
  const read = (): "light" | "dark" => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const [theme, setTheme] = useState<"light" | "dark">(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

/** EditorState carries undo/selection; scroll and mode are independent per file. */
interface Tab {
  path: string;
  saved: string; // 已保存内容（脏标记基准）
  dirty: boolean;
  binary: boolean;
  state: EditorState | null;
  scroll: number;
  scrollLeft: number;
  readScroll: number;
  mode: "reading" | "editing";
}

function MarkdownReading({ tab, source }: { tab: Tab; source: string }) {
  const readerRef = useRef<HTMLElement | null>(null);
  const [result, setResult] = useState<{ source: string; html: string; error?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    renderMarkdown(source, { restrictResources: true })
      .then(html => { if (alive) setResult({ source, html }); })
      .catch(error => { if (alive) setResult({ source, html: "", error: errMsg(error) }); });
    return () => { alive = false; };
  }, [source]);
  const current = result?.source === source ? result : null;
  useLayoutEffect(() => {
    if (readerRef.current && current) readerRef.current.scrollTop = tab.readScroll;
  }, [current, tab]);
  return <article ref={readerRef} className="cda-md-reader" tabIndex={0} aria-label={`${baseName(tab.path)} 阅读正文`} aria-busy={!current}
    onScroll={event => { if (current) tab.readScroll = event.currentTarget.scrollTop; }}
    onClick={event => {
      const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      // Heading navigation stays in this document; never resolves another app panel's IDs.
      event.preventDefault();
      const href = anchor.getAttribute("href");
      if (!href?.startsWith("#")) return;
      let id: string;
      try { id = decodeURIComponent(href.slice(1)); } catch { return; }
      const heading = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"))
        .find(element => element.id === id);
      if (heading) event.currentTarget.scrollTop += heading.getBoundingClientRect().top - event.currentTarget.getBoundingClientRect().top;
    }}>
    {current?.error && <p className="cda-reading-error" role="alert">阅读渲染失败：{current.error}。当前草稿仍完整保留，可切回编辑。</p>}
    {current && !current.error ? <div dangerouslySetInnerHTML={{ __html: current.html }} /> : <pre className="cda-reading-source">{source}</pre>}
  </article>;
}

/* ---------- CodeArea ---------- */

export function CodeArea({ rootUri, projectId, className, hideTree = false, visible = true }: { rootUri: string; projectId?: string; className?: string; hideTree?: boolean; visible?: boolean }) {
  const toast = useToast();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const treeId = useId();
  const treePane = usePaneWidth(`code:${projectId ?? rootUri}:${rootUri}`, "files", {
    default: 260, min: 180, max: 480, side: "left", containerRef, minCenter: 320,
    visible: hideTree ? false : undefined, disabled: !visible || hideTree,
  });
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const openingRef = useRef(new Map<string, Promise<void>>());
  const fileRequestRef = useRef(0);
  const [, setVer] = useState(0);
  const rerender = useCallback(() => setVer(v => v + 1), []);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const tabsRef = useRef<Tab[]>([]);
  const activeRef = useRef<string | null>(null);
  const rootUriRef = useRef(rootUri);

  const langComp = useRef(new Compartment()).current;
  const themeComp = useRef(new Compartment()).current;
  const fontComp = useRef(new Compartment()).current;
  const themeRef = useRef<"light" | "dark">("light");
  const fontRef = useRef(DEFAULT_FONT_SIZE);

  const theme = useHtmlTheme();

  /* ---------- 保存（Ctrl+S）/ 脏标记 ---------- */

  const saveActive = useCallback(async () => {
    const path = activeRef.current;
    const view = viewRef.current;
    const tab = path ? tabsRef.current.find(t => t.path === path) : null;
    if (!path || !view || !tab || tab.binary) return;
    const root = rootUriRef.current;
    const content = view.state.doc.toString();
    try {
      await api.fsWriteFile(root, path, content);
      // A save completing after a root change/close must not mutate a different file session.
      if (rootUriRef.current !== root || !tabsRef.current.includes(tab)) return;
      tab.saved = content;
      tab.dirty = (activeRef.current === path && viewRef.current === view ? view.state : tab.state)?.doc.toString() !== content;
      rerender();
      toast(`已保存 ${path}`);
    } catch (e) {
      if (rootUriRef.current === root && tabsRef.current.includes(tab)) toast(errMsg(e), "err");
    }
  }, [toast, rerender]);

  // Reading has no focused CodeMirror; keep Ctrl+S scoped to the visible active buffer.
  useEffect(() => {
    const onSave = (event: KeyboardEvent) => {
      if (!visibleRef.current || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s") return;
      const tab = tabsRef.current.find(t => t.path === activeRef.current);
      if (!tab || tab.binary || tab.mode !== "reading") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input,textarea,[contenteditable='true'],[role='dialog']")) return;
      if (document.querySelector("dialog[open],[role='dialog']")) return;
      event.preventDefault();
      void saveActive();
    };
    window.addEventListener("keydown", onSave);
    return () => window.removeEventListener("keydown", onSave);
  }, [saveActive]);

  const onUpdate = useCallback(
    (u: ViewUpdate) => {
      if (!u.docChanged) return;
      const path = activeRef.current;
      const tab = path ? tabsRef.current.find(t => t.path === path) : null;
      if (!tab || tab.binary) return;
      tab.state = u.state;
      const dirty = u.state.doc.toString() !== tab.saved;
      if (dirty !== tab.dirty || (isMarkdownPath(tab.path) && tab.mode === "reading")) {
        tab.dirty = dirty;
        rerender();
      }
    },
    [rerender]
  );

  /* ---------- 扩展（创建一次；语言/主题/字号走 Compartment） ---------- */

  const extensions = useMemo<Extension[]>(
    () => [
      basicSetup,
      Prec.highest(keymap.of([{ key: "Mod-s", run: () => { if (!visibleRef.current) return false; void saveActive(); return true; } }])),
      EditorView.updateListener.of(onUpdate),
      lineHighlightField,
      langComp.of([]),
      themeComp.of([]),
      fontComp.of(fontTheme(DEFAULT_FONT_SIZE)),
    ],
    [saveActive, onUpdate, langComp, themeComp, fontComp]
  );

  /** 对当前视图重配语言 / 主题 / 字号（切页签或主题字号变化后调用）。 */
  const applyCompartments = useCallback(
    (view: EditorView, path: string | null) => {
      view.dispatch({
        effects: [
          langComp.reconfigure(path ? languageFor(path) : []),
          themeComp.reconfigure(themeRef.current === "dark" ? oneDark : []),
          fontComp.reconfigure(fontTheme(fontRef.current)),
        ],
      });
    },
    [langComp, themeComp, fontComp]
  );

  /* ---------- 编辑器生命周期 / 设置 ---------- */

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({ state: EditorState.create({ doc: "", extensions }), parent: host });
    viewRef.current = view;
    const rememberScroll = () => {
      const tab = tabsRef.current.find(t => t.path === activeRef.current);
      if (!tab || tab.binary || tab.mode !== "editing") return;
      tab.scroll = view.scrollDOM.scrollTop;
      tab.scrollLeft = view.scrollDOM.scrollLeft;
    };
    view.scrollDOM.addEventListener("scroll", rememberScroll, { passive: true });
    return () => {
      view.scrollDOM.removeEventListener("scroll", rememberScroll);
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [extensions]);

  // 主题变化 → 重配主题 compartment
  useEffect(() => {
    themeRef.current = theme;
    const view = viewRef.current;
    if (view) applyCompartments(view, activeRef.current);
  }, [theme, applyCompartments]);

  // 字号设置读取（默认 13，限 10–28）
  useEffect(() => {
    let alive = true;
    api.getSetting("editor.fontSize")
      .then(v => {
        if (!alive) return;
        const n = v == null ? NaN : Number.parseInt(v, 10);
        const px = Number.isFinite(n) && n >= 10 && n <= 28 ? n : DEFAULT_FONT_SIZE;
        fontRef.current = px;
        const view = viewRef.current;
        if (view) applyCompartments(view, activeRef.current);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [applyCompartments]);

  // rootUri 变化：清空页签并重置编辑器
  useEffect(() => {
    rootUriRef.current = rootUri;
    fileRequestRef.current++;
    openingRef.current.clear();
    setCloseTarget(null);
    setDiscardTarget(null);
    tabsRef.current = [];
    activeRef.current = null;
    const view = viewRef.current;
    if (view) {
      view.setState(EditorState.create({ doc: "", extensions }));
      applyCompartments(view, null);
    }
    rerender();
  }, [rootUri, extensions, applyCompartments, rerender]);

  /* ---------- 页签操作 ---------- */

  /** 切换活动页签：先保存旧页签状态与滚动，再恢复目标页签。 */
  const activate = useCallback(
    (path: string | null) => {
      const view = viewRef.current;
      const cur = activeRef.current;
      if (cur === path && view) { applyCompartments(view, path); return; }
      if (cur && cur !== path && view) {
        const curTab = tabsRef.current.find(t => t.path === cur);
        if (curTab && !curTab.binary) {
          curTab.state = view.state;
          if (curTab.mode === "editing") {
            curTab.scroll = view.scrollDOM.scrollTop;
            curTab.scrollLeft = view.scrollDOM.scrollLeft;
          }
        }
      }
      activeRef.current = path;
      const tab = path ? tabsRef.current.find(t => t.path === path) : null;
      if (view) {
        if (tab && !tab.binary) {
          view.setState(tab.state ?? EditorState.create({ doc: tab.saved, extensions }));
          applyCompartments(view, path);
          const top = tab.scroll;
          const left = tab.scrollLeft;
          requestAnimationFrame(() => {
            if (viewRef.current === view && activeRef.current === path && tab.mode === "editing") {
              view.scrollDOM.scrollTop = top;
              view.scrollDOM.scrollLeft = left;
              view.requestMeasure();
            }
          });
        } else {
          // 无页签或二进制页签：编辑器清空并隐藏
          view.setState(EditorState.create({ doc: "", extensions }));
          applyCompartments(view, path);
        }
      }
      rerender();
    },
    [extensions, applyCompartments, rerender]
  );

  const openFile = useCallback(async (path: string) => {
    const seq = ++fileRequestRef.current;
    const root = rootUriRef.current;
    if (tabsRef.current.some(t => t.path === path)) { activate(path); return; }
    if (isBinaryPath(path)) {
      tabsRef.current = [...tabsRef.current, { path, saved: "", dirty: false, binary: true, state: null, scroll: 0, scrollLeft: 0, readScroll: 0, mode: "editing" }];
      activate(path); return;
    }
    let pending = openingRef.current.get(path);
    if (!pending) {
      pending = api.fsReadFile(root, path).then(content => {
        if (rootUriRef.current !== root || !viewRef.current) return;
        if (!tabsRef.current.some(t => t.path === path)) tabsRef.current = [...tabsRef.current, { path, saved: content, dirty: false, binary: false, state: null, scroll: 0, scrollLeft: 0, readScroll: 0, mode: isMarkdownPath(path) ? "reading" : "editing" }];
        rerender();
      }).finally(() => { if (openingRef.current.get(path) === pending) openingRef.current.delete(path); });
      openingRef.current.set(path, pending);
    }
    try { await pending; if (rootUriRef.current === root && fileRequestRef.current === seq && tabsRef.current.some(t => t.path === path)) activate(path); }
    catch (e) { if (rootUriRef.current === root) toast(errMsg(e), "err"); }
  }, [activate, toast, rerender]);

  const changeMode = useCallback((mode: Tab["mode"]) => {
    const path = activeRef.current;
    const tab = tabsRef.current.find(t => t.path === path);
    const view = viewRef.current;
    if (!tab || !view || !isMarkdownPath(tab.path) || tab.mode === mode) return;
    tab.state = view.state;
    if (tab.mode === "editing") {
      tab.scroll = view.scrollDOM.scrollTop;
      tab.scrollLeft = view.scrollDOM.scrollLeft;
    }
    tab.mode = mode;
    rerender();
  }, [rerender]);

  const removeTab = useCallback(
    (path: string) => {
      const idx = tabsRef.current.findIndex(t => t.path === path);
      if (idx < 0) return;
      const rest = tabsRef.current.filter(t => t.path !== path);
      tabsRef.current = rest;
      if (activeRef.current === path) {
        const next = rest[idx] ?? rest[idx - 1] ?? null;
        activeRef.current = null; // 关闭动作不再回存状态
        activate(next ? next.path : null);
      } else {
        rerender();
      }
    },
    [activate, rerender]
  );

  const closeTab = (path: string) => {
    const tab = tabsRef.current.find(t => t.path === path);
    if (tab?.dirty) setCloseTarget(path); else removeTab(path);
  };

  /* ---------- 会话答复定位（STORY-062 AC-08~11）：打开文件并滚动到目标行 ---------- */

  const locateTarget = useCallback(
    async (path: string, line?: number, col?: number) => {
      if (isBinaryPath(path)) {
        toast(`${baseName(path)} 为非文本文件，无法定位到行`, "err");
        return;
      }
      await openFile(path); // 读取失败已在 openFile 内提示，且不改变当前已打开文件
      if (line == null || activeRef.current !== path) return;
      changeMode("editing");
      requestAnimationFrame(() => {
        const view = viewRef.current;
        if (!view || activeRef.current !== path) return;
        const total = view.state.doc.lines;
        const ln = Math.min(Math.max(1, line), total);
        if (line > total) toast(`目标行超出文件范围（共 ${total} 行），已定位到末行`, "warn");
        const lineInfo = view.state.doc.line(ln);
        const ch = col ? Math.min(Math.max(0, col - 1), lineInfo.length) : 0;
        view.dispatch({
          effects: setLineHighlight.of(lineInfo.from),
          selection: { anchor: lineInfo.from + ch },
          scrollIntoView: true,
        });
        if (visibleRef.current) view.focus();
      });
    },
    [openFile, changeMode, toast]
  );

  const matchesScope = useCallback((d: LocateDetail) => {
    if (d.kind !== "file" || (!d.projectId && !d.rootUri)) return false;
    if (d.projectId && d.projectId !== projectId) return false;
    const normalize = (path: string) => path.replace(/\\/g, "/").replace(/^\/\/?\?\//, "").replace(/\/$/, "").toLowerCase();
    return !d.rootUri || normalize(d.rootUri) === normalize(rootUri);
  }, [projectId, rootUri]);

  useEffect(() => {
    const run = (d: LocateDetail) => {
      if (!matchesScope(d) || d.kind !== "file") return;
      takePendingLocate(p => p === d);
      void locateTarget(d.path, d.line, d.col);
    };
    const unsub = onLocate(run);
    const pending = takePendingLocate(matchesScope);
    if (pending?.kind === "file") void locateTarget(pending.path, pending.line, pending.col);
    return unsub;
  }, [locateTarget, matchesScope]);

  useEffect(() => { if (visible) viewRef.current?.requestMeasure(); }, [visible, hideTree]);

  /* ---------- 渲染 ---------- */

  const tabs = tabsRef.current;
  const active = activeRef.current;
  const activeTab = active ? tabs.find(t => t.path === active) ?? null : null;
  const canEdit = activeTab != null && !activeTab.binary;
  const isMarkdown = !!activeTab && canEdit && isMarkdownPath(activeTab.path);
  const showReading = isMarkdown && activeTab?.mode === "reading";
  const showEditor = canEdit && !showReading;
  const readingSource = showReading ? viewRef.current?.state.doc.toString() ?? activeTab?.state?.doc.toString() ?? activeTab?.saved ?? "" : "";

  useLayoutEffect(() => {
    if (!visible || !showEditor || !activeTab) return;
    const view = viewRef.current;
    if (!view) return;
    view.scrollDOM.scrollTop = activeTab.scroll;
    view.scrollDOM.scrollLeft = activeTab.scrollLeft;
    view.requestMeasure();
  }, [visible, showEditor, activeTab]);

  return (
    <div ref={containerRef} className={`cda ${className ?? ""}`} data-ui-version="UI-CR045-v1">
      <aside {...treePane.paneProps} id={treeId} className={`cda-aside ${treePane.paneProps.className}`} aria-label="文件树">
        {treePane.overlay && <PaneClose pane={treePane} label="文件树" className="cda-tree-close btn sm" />}
        <FileTree rootUri={rootUri} onOpenFile={p => void openFile(p)} />
        <ResizeHandle pane={treePane} label="编码文件栏" controls={treeId} />
      </aside>
      <section className="cda-main">
        <EditorTabs
          tabs={tabs.map(t => ({ path: t.path, dirty: t.dirty }))}
          active={active}
          onSelect={p => activate(p)}
          onClose={closeTab}
        />
        <div className="cda-editor-bar">
          {!hideTree && !treePane.visible && <PaneToggle pane={treePane} label="文件树" controls={treeId} className="btn sm" />}
          <span className="mono ellipsis" title={active ?? ""}>{active ?? "未打开文件"}</span><span className="spacer" />
          {isMarkdown && <div className="segment cda-mode" role="group" aria-label="Markdown模式">
            <button type="button" aria-pressed={showReading} onClick={() => changeMode("reading")}>阅读</button>
            <button type="button" aria-pressed={showEditor} onClick={() => changeMode("editing")}>编辑</button>
          </div>}
          {activeTab?.dirty && <span className="small muted">未保存</span>}
          <button className="btn sm" disabled={!canEdit} onClick={() => void saveActive()}>保存</button>
          <button className="btn sm" disabled={!activeTab?.dirty} onClick={() => { if (active) setDiscardTarget(active); }}>取消修改</button>
        </div>
        {isMarkdown && <div className="cda-reading-note">当前编辑缓冲 · 不执行HTML／脚本，不自动读取本地或外联资源</div>}
        <div className="cda-stage">
          <div className={`cda-editor ${showEditor ? "" : "hide"}`} ref={hostRef} aria-hidden={!showEditor} />
          {showReading && activeTab && <MarkdownReading key={activeTab.path} tab={activeTab} source={readingSource} />}
          {!active && (
            <div className="cda-empty-fill">
              <Empty title="未打开文件" desc="从左侧文件树选择一个文件开始编辑，Ctrl+S 保存" />
            </div>
          )}
          {activeTab?.binary && (
            <div className="cda-empty-fill">
              <Empty title="二进制文件" desc={`${baseName(activeTab.path)} 为非文本文件，编辑器仅支持文本格式`} />
            </div>
          )}
        </div>
      </section>
      {closeTarget && visible && <Confirm title="关闭未保存文件" message={`「${baseName(closeTarget)}」有未保存修改。关闭将丢弃当前草稿；取消会完整保留内容、选择和滚动位置。`} danger onCancel={() => setCloseTarget(null)} onOk={() => { removeTab(closeTarget); setCloseTarget(null); }} />}
      {discardTarget && visible && <Confirm title="取消文件修改" message={`丢弃「${baseName(discardTarget)}」的未保存修改并恢复已保存内容？`} danger onCancel={() => setDiscardTarget(null)} onOk={() => {
        const tab = tabsRef.current.find(t => t.path === discardTarget);
        if (tab) { tab.state = EditorState.create({ doc: tab.saved, extensions }); tab.dirty = false; if (activeRef.current === tab.path && viewRef.current) { viewRef.current.setState(tab.state); applyCompartments(viewRef.current, tab.path); } rerender(); }
        setDiscardTarget(null);
      }} />}
    </div>
  );
}
