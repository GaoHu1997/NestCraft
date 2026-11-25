import { Icon } from "@/components/icons";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import * as perf from "@/api/editor-performance";
import * as fsOps from "@/api/fs-ops";
import { Confirm, Empty, useToast } from "@/components/ui";
import { FileContextMenu, type ContextMenuEntry } from "./FileContextMenu";
import { invalidNameReason, joinRel, ROOT, splitExtension } from "./file-ops";
import { virtualRange } from "./performance-model";
import "./file-tree-menu.css";

interface Node extends perf.DirectoryEntry { parent: string; expanded: boolean; loaded: boolean; children: string[]; cursor: string | null; loading: boolean; error?: string; revision?: string }
type Row = { kind: "node"; node: Node; depth: number } | { kind: "more"; parent: string; depth: number; loading: boolean; error?: string } | { kind: "inline"; depth: number };
interface InlineState { kind: "file" | "dir" | "rename"; parent: string; path?: string; value: string; error: string; isDir: boolean }
interface MenuState { x: number; y: number; node: Node | null }
const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const rowKey = (row: Row) => row.kind === "node" ? row.node.path : row.kind === "more" ? `more:${row.parent}` : "inline";

/** UI-CR055-FEAT007-v1: one directory page per expansion, viewport-only DOM. */
export function FileTree({ rootUri, onOpenFile, onPathRemoved, onPathRenamed, singleClickOpen = false, previewOpen = false }: {
  rootUri: string;
  onOpenFile: (path: string, opts?: { preview?: boolean }) => void;
  onPathRemoved?: (paths: string[]) => void;
  onPathRenamed?: (from: string, to: string) => void;
  singleClickOpen?: boolean;
  previewOpen?: boolean;
}) {
  const toast = useToast();
  const treeId = useId();
  const store = useRef(new Map<string, Node>());
  const root = useRef({ children: [] as string[], cursor: null as string | null, loaded: false, loading: false, error: undefined as string | undefined, revision: undefined as string | undefined });
  const generation = useRef(0);
  const [version, setVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<perf.SearchHit[]>([]);
  const [searchInfo, setSearchInfo] = useState("输入关键词后按 Enter 或点击搜索");
  const [searching, setSearching] = useState(false);
  const [inline, setInline] = useState<InlineState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Node | null>(null);
  const inlineRef = useRef<HTMLInputElement>(null);
  const singleOpens = singleClickOpen || previewOpen;
  const request = useRef<{ id: string; root: string } | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout>>();
  const refresh = useCallback(() => setVersion(v => v + 1), []);

  const load = useCallback(async (parent: string, reset = false) => {
    const session = generation.current;
    const directory = parent === ROOT ? root.current : store.current.get(parent);
    if (!directory || directory.loading) return;
    directory.loading = true; directory.error = undefined; refresh();
    try {
      const result = await perf.directoryPage(rootUri, parent, reset ? null : directory.cursor);
      if (generation.current !== session) return;
      if (reset) directory.children = [];
      const known = new Set(directory.children);
      for (const item of result.items) {
        const old = store.current.get(item.path);
        store.current.set(item.path, old ? { ...old, ...item } : { ...item, parent, expanded: false, loaded: false, children: [], cursor: null, loading: false });
        if (!known.has(item.path)) { directory.children.push(item.path); known.add(item.path); }
      }
      directory.cursor = result.nextCursor; directory.loaded = true; directory.revision = result.directoryRevision;
    } catch (e) {
      if (generation.current === session) directory.error = err(e);
    } finally { if (generation.current === session) { directory.loading = false; refresh(); } }
  }, [rootUri, refresh]);

  const cancelSearch = useCallback((feedback = true) => {
    clearTimeout(pollTimer.current);
    const old = request.current; request.current = null;
    if (old) void perf.cancel(old.root, old.id).catch(() => {});
    if (feedback) { setSearching(false); setSearchInfo("已请求取消 · 保留已返回结果"); }
  }, []);

  useEffect(() => {
    generation.current++; store.current.clear();
    root.current = { children: [], cursor: null, loaded: false, loading: false, error: undefined, revision: undefined };
    setScrollTop(0); setFocusKey(null); setSelected(null); setSearchOpen(false); setHits([]); setQuery(""); setSearching(false);
    setInline(null); setMenu(null); setDeleteTarget(null);
    if (viewport.current) viewport.current.scrollTop = 0;
    void load(ROOT);
    return () => { generation.current++; cancelSearch(false); };
  }, [rootUri, load, cancelSearch]);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const measure = () => setHeight(element.clientHeight || 600);
    const observer = new ResizeObserver(measure); observer.observe(element); measure(); return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!inline) return;
    const element = inlineRef.current; if (!element) return;
    element.focus();
    if (inline.kind === "rename") {
      const base = splitExtension(element.value).base;
      try { element.setSelectionRange(0, base.length); } catch { /* 选区不可用则忽略 */ }
    }
    // 仅在开始行内输入（类型/父目录/路径变化）时聚焦并预选主名，输入过程中不重复聚焦。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline?.kind, inline?.parent, inline?.path]);

  const buildRows = useCallback((current: InlineState | null): Row[] => {
    const out: Row[] = [];
    const walk = (parent: string, depth: number) => {
      const d = parent === ROOT ? root.current : store.current.get(parent); if (!d) return;
      if (current && current.kind !== "rename" && current.parent === parent) out.push({ kind: "inline", depth });
      for (const id of d.children) {
        const n = store.current.get(id); if (!n) continue;
        if (current && current.kind === "rename" && current.path === n.path) { out.push({ kind: "inline", depth }); continue; }
        out.push({ kind: "node", node: n, depth });
        if (n.isDir && n.expanded) walk(n.path, depth + 1);
      }
      if (d.cursor || (parent !== ROOT && (d.loading || d.error))) out.push({ kind: "more", parent, depth, loading: d.loading, error: d.error });
    };
    walk(ROOT, 0); return out;
  }, []);
  const rows = useMemo(() => buildRows(inline), [buildRows, version, inline]);
  const focus = Math.max(0, rows.findIndex(row => rowKey(row) === focusKey));
  const baseRange = virtualRange(rows.length, scrollTop, height);
  const inlineRowIndex = inline ? rows.findIndex(row => row.kind === "inline") : -1;
  const range = inlineRowIndex >= 0 && (inlineRowIndex < baseRange.start || inlineRowIndex >= baseRange.end)
    ? { ...baseRange, start: Math.min(baseRange.start, inlineRowIndex), end: Math.max(baseRange.end, inlineRowIndex + 1) }
    : baseRange;
  const refreshTree = async () => {
    const session = ++generation.current;
    const expanded = [...store.current.values()].filter(node => node.isDir && node.expanded).map(node => node.path).sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length);
    for (const node of store.current.values()) { node.loading = false; if (node.isDir && !node.expanded) { node.loaded = false; node.children = []; node.cursor = null; node.revision = undefined; } } root.current.loading = false;
    await load(ROOT, true);
    for (const path of expanded) { if (generation.current !== session) return; if (store.current.has(path)) await load(path, true); }
    if (generation.current !== session) return;
    const reachable = new Set<string>();
    const visit = (ids: string[]) => { for (const id of ids) { if (reachable.has(id)) continue; reachable.add(id); const node = store.current.get(id); if (node) visit(node.children); } };
    visit(root.current.children); for (const id of store.current.keys()) if (!reachable.has(id)) store.current.delete(id);
    refresh();
  };
  const toggle = (n: Node) => { n.expanded = !n.expanded; refresh(); if (n.expanded && !n.loaded && !n.loading) void load(n.path); };
  const pickMore = async (row: Row) => {
    if (row.kind !== "more" || row.loading) return;
    const d = row.parent === ROOT ? root.current : store.current.get(row.parent);
    const before = d?.children.length ?? 0;
    await load(row.parent, !!row.error);
    const first = d?.children[row.error ? 0 : before]; if (first) setFocusKey(first);
  };
  const selectedNode = () => {
    if (selected) { const n = store.current.get(selected); if (n) return n; }
    const row = rows[focus]; return row && row.kind === "node" ? row.node : null;
  };
  const removeSubtree = (path: string, parent: string) => {
    const stack = [path];
    while (stack.length) { const p = stack.pop() as string; const n = store.current.get(p); if (n) { for (const c of n.children) stack.push(c); store.current.delete(p); } }
    const d = parent === ROOT ? root.current : store.current.get(parent);
    if (d) d.children = d.children.filter(c => c !== path);
    refresh();
  };
  const validateName = (name: string, parent: string, renameFrom?: string) => {
    const reason = invalidNameReason(name);
    if (reason) return reason;
    const d = parent === ROOT ? root.current : store.current.get(parent);
    if (d) for (const id of d.children) { const n = store.current.get(id); if (!n || n.path === renameFrom) continue; if (n.name === name) return "该目录已存在同名项"; }
    return "";
  };
  const startInline = (next: InlineState) => {
    const idx = buildRows(next).findIndex(r => r.kind === "inline");
    const el = viewport.current;
    if (el && idx >= 0) {
      const top = idx * 26;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + 26 > el.scrollTop + el.clientHeight) el.scrollTop = top + 26 - el.clientHeight;
      setScrollTop(el.scrollTop);
    }
    setInline(next);
  };
  const beginCreate = (parent: string, kind: "file" | "dir") => {
    setMenu(null);
    if (parent !== ROOT) {
      const d = store.current.get(parent);
      if (d) { if (!d.expanded) d.expanded = true; if (!d.loaded && !d.loading) void load(parent); refresh(); }
    }
    startInline({ kind, parent, value: "", error: "", isDir: kind === "dir" });
  };
  const beginRename = (node: Node) => {
    setMenu(null);
    startInline({ kind: "rename", parent: node.parent, path: node.path, value: node.name, error: "", isDir: node.isDir });
  };
  const cancelInline = () => setInline(null);
  const commitInline = async () => {
    const s = inline; if (!s) return;
    const error = validateName(s.value, s.parent, s.kind === "rename" ? s.path : undefined);
    if (error) { setInline({ ...s, error }); inlineRef.current?.focus(); return; }
    const rel = joinRel(s.parent, s.value);
    if (s.kind === "rename") {
      const from = s.path ?? "";
      if (rel === from) { setInline(null); return; }
      const name = s.value;
      try {
        await fsOps.renamePath(rootUri, from, rel);
        setInline(null);
        await refreshTree();
        setSelected(rel);
        onPathRenamed?.(from, rel);
        toast(`已重命名为 ${name}`, "info");
      } catch (e) { setInline({ ...s, error: err(e) }); inlineRef.current?.focus(); }
    } else {
      const name = s.value;
      try {
        if (s.kind === "dir") await fsOps.createDir(rootUri, rel); else await fsOps.createFile(rootUri, rel);
        setInline(null);
        await load(s.parent, true);
        setSelected(rel); setFocusKey(rel);
        if (s.kind === "file") onOpenFile(rel);
        toast(s.kind === "dir" ? `已新建文件夹 ${name}` : `已新建文件 ${name}`, "info");
      } catch (e) { setInline({ ...s, error: err(e) }); inlineRef.current?.focus(); }
    }
  };
  const openDelete = (node: Node) => { setMenu(null); setDeleteTarget(node); };
  const confirmDelete = async () => {
    const node = deleteTarget; if (!node) return;
    setDeleteTarget(null);
    try {
      await fsOps.deletePath(rootUri, node.path);
      removeSubtree(node.path, node.parent);
      await load(node.parent, true);
      if (selected === node.path) setSelected(null);
      onPathRemoved?.([node.path]);
      toast(`已删除 ${node.path}`, "info");
    } catch (e) {
      const message = err(e);
      toast(message.includes("目录非空") ? `目录非空：只能删除空目录（${node.path}）` : `删除失败：${message}`, "err");
    }
  };
  const menuEntries = (node: Node | null): ContextMenuEntry[] => {
    if (!node) return [
      { kind: "item", key: "newFile", label: "新建文件", icon: "filePlus" },
      { kind: "item", key: "newDir", label: "新建文件夹", icon: "folderPlus" },
      { kind: "sep" },
      { kind: "item", key: "refresh", label: "刷新", icon: "refresh" },
    ];
    if (!node.isDir) return [
      { kind: "item", key: "openFile", label: "在编辑器中打开", icon: "external" },
      { kind: "sep" },
      { kind: "item", key: "rename", label: "重命名", icon: "edit" },
      { kind: "item", key: "delete", label: "删除", icon: "trash", danger: true },
    ];
    return [
      { kind: "item", key: "newFile", label: "新建文件", icon: "filePlus" },
      { kind: "item", key: "newDir", label: "新建文件夹", icon: "folderPlus" },
      { kind: "sep" },
      { kind: "item", key: "rename", label: "重命名", icon: "edit" },
      { kind: "item", key: "delete", label: "删除", icon: "trash", danger: true },
      { kind: "sep" },
      { kind: "item", key: "refresh", label: "刷新", icon: "refresh" },
    ];
  };
  const handleMenuSelect = (key: string) => {
    const node = menu?.node ?? null;
    setMenu(null);
    if (!node) {
      if (key === "newFile") beginCreate(ROOT, "file");
      else if (key === "newDir") beginCreate(ROOT, "dir");
      else if (key === "refresh") void refreshTree();
      return;
    }
    if (key === "openFile") onOpenFile(node.path);
    else if (key === "newFile") beginCreate(node.isDir ? node.path : node.parent, "file");
    else if (key === "newDir") beginCreate(node.isDir ? node.path : node.parent, "dir");
    else if (key === "rename") beginRename(node);
    else if (key === "delete") openDelete(node);
    else if (key === "refresh") void load(node.isDir ? node.path : node.parent, true);
  };
  const reveal = (index: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, index)); if (rows[next]) setFocusKey(rowKey(rows[next]));
    const el = viewport.current; if (!el) return;
    if (next * 26 < el.scrollTop) el.scrollTop = next * 26;
    else if ((next + 1) * 26 > el.scrollTop + el.clientHeight) el.scrollTop = (next + 1) * 26 - el.clientHeight;
  };
  const runSearch = async () => {
    const q = query.trim(); if (!q) return;
    cancelSearch(false); setHits([]); setSearchInfo("搜索中…"); setSearching(true);
    const current = { id: crypto.randomUUID(), root: rootUri }; request.current = current;
    let ack: number | null = null;
    try { await perf.searchStart(rootUri, q, current.id); }
    catch (e) { if (request.current === current) { request.current = null; setSearching(false); setSearchInfo(`搜索失败：${err(e)}`); } return; }
    if (request.current !== current) { void perf.cancel(current.root, current.id); return; }
    const poll = async () => {
      if (request.current !== current) return;
      try {
        const result = await perf.searchPoll(current.root, current.id, ack);
        if (request.current !== current) return;
        const batch = result.batches.filter(b => ack === null || b.seq > ack);
        if (batch.length) { ack = batch[batch.length - 1].seq; setHits(old => [...old, ...batch.flatMap(b => b.hits)]); }
        const coverage = result.limited || result.skipped > 0;
        setSearchInfo(`${result.status === "running" ? "搜索中…" : result.status === "cancelled" ? "已取消" : "搜索完成"} · 已检查 ${result.files} 个文件${coverage ? ` · 部分范围（${result.skipped} 项读取失败或不支持${result.limited ? "，已达结果/深度上限" : ""}）` : ""}`);
        if (result.status === "running") pollTimer.current = setTimeout(() => void poll(), 50);
        else { setSearching(false); request.current = null; if (ack !== null) void perf.searchPoll(current.root, current.id, ack).catch(() => {}); }
      } catch (e) { if (request.current === current) { cancelSearch(false); setSearching(false); setSearchInfo(`搜索失败：${err(e)}；已返回结果保留`); } }
    };
    void poll();
  };

  return <>
    <div className="cda-tree-head"><span className="cda-tree-title">文件</span><span className="spacer" />
      <button className="btn icon sm ghost" aria-label="搜索文件内容" title="搜索文件内容" onClick={() => { if (searchOpen) cancelSearch(); setSearchOpen(v => !v); }}><Icon name="search" size={14} /></button>
      <button className="btn icon sm ghost" aria-label="刷新目录" title="刷新目录" onClick={() => void refreshTree()}><Icon name="refresh" size={14} /></button>
    </div>
    {searchOpen && <div className="cda-search"><div className="row"><input className="input" autoFocus value={query} aria-label="搜索文件内容" placeholder="搜索文件内容，Enter 确认" onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") void runSearch(); if (e.key === "Escape") { cancelSearch(); setSearchOpen(false); } }} /><button className="btn sm" onClick={() => void runSearch()}>搜索</button>{searching && <button className="btn sm" onClick={() => cancelSearch()}>取消</button>}</div>
      <div className="cda-search-note muted small" role="status">{searchInfo}</div><div className="cda-search-list">{hits.map(h => <button type="button" key={`${h.path}:${h.lineNo}`} className="cda-hit clickable" title={h.path} onClick={() => onOpenFile(h.path)}><div className="cda-hit-path mono ellipsis">{h.path}:{h.lineNo}</div><div className="cda-hit-text mono ellipsis">{h.lineText}</div></button>)}</div>
    </div>}
    <div ref={viewport} className="cda-tree-body cda-virtual-tree" role="tree" tabIndex={0} aria-label="项目文件" aria-activedescendant={focus >= range.start && focus < range.end ? `${treeId}-${focus}` : undefined} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, node: null }); }} onKeyDown={e => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (!rows.length || e.nativeEvent.isComposing) return;
      if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(e.key)) { e.preventDefault(); reveal(e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : focus + (e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : Math.max(1, Math.floor(height / 26)) * (e.key === "PageDown" ? 1 : -1))); }
      const row = rows[focus]; if (!row) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (row.kind === "more") void pickMore(row);
        else if (row.kind === "node") { setSelected(row.node.path); if (row.node.isDir) toggle(row.node); else onOpenFile(row.node.path); }
        return;
      }
      if (e.key === "F2") { e.preventDefault(); const n = selectedNode(); if (n) beginRename(n); return; }
      if (e.key === "F5") { e.preventDefault(); void refreshTree(); return; }
      if (e.key === "Delete") { e.preventDefault(); const n = selectedNode(); if (n) openDelete(n); return; }
      if (row.kind === "node" && e.key === "ArrowRight") { e.preventDefault(); if (row.node.isDir && !row.node.expanded) toggle(row.node); }
      if (row.kind === "node" && e.key === "ArrowLeft") { e.preventDefault(); if (row.node.isDir && row.node.expanded) toggle(row.node); else reveal(rows.findIndex(r => r.kind === "node" && r.node.path === row.node.parent)); }
    }}>
      {root.current.error ? <Empty title="读取目录失败" desc={root.current.error} action={<button className="btn sm" onClick={() => void load(ROOT, true)}>重试</button>} /> : !root.current.loaded ? <div className="cda-search-note muted small">加载目录…</div> : rows.length === 0 ? <Empty title="空目录" desc="项目根目录没有可见文件" /> : <div className="cda-virtual-space" style={{ height: range.totalHeight }}>{rows.slice(range.start, range.end).map((row, n) => {
        const i = range.start + n;
        if (row.kind === "inline") return <div key="ft-inline" id={`${treeId}-${i}`} className={`cda-tree-row cda-virtual-row ft-inline-row ${inline?.isDir ? "dir" : "file"}`} style={{ top: i * 26, paddingLeft: 8 + row.depth * 14 }}>
          <span className="cda-chevron leaf"><Icon name="chevronRight" size={12} /></span><Icon name={inline?.isDir ? "folder" : "file"} size={14} />
          <span className="ft-inline-wrap">
            <input ref={inlineRef} className={`ft-inline-input${inline?.error ? " invalid" : ""}`} value={inline?.value ?? ""} aria-label={inline?.kind === "rename" ? "重命名" : inline?.isDir ? "新建文件夹名称" : "新建文件名称"} spellCheck={false} autoComplete="off"
              onChange={e => { const value = e.target.value; setInline(s => s ? { ...s, value, error: "" } : s); }}
              onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") { e.preventDefault(); void commitInline(); } else if (e.key === "Escape") { e.preventDefault(); cancelInline(); } }} />
            {inline?.error && <span className="ft-inline-err" role="alert">{inline.error}</span>}
          </span>
        </div>;
        return row.kind === "more" ? <button key={`more:${row.parent}`} id={`${treeId}-${i}`} role="treeitem" tabIndex={-1} className="cda-tree-row cda-virtual-row cda-more" style={{ top: i * 26, paddingLeft: 8 + row.depth * 14 }} onClick={() => { setFocusKey(rowKey(row)); viewport.current?.focus(); void pickMore(row); }} disabled={row.loading} title={row.error}>{row.loading ? "加载目录…" : row.error ? "读取失败 · 点击重新加载目录" : "加载更多文件…"}</button> : <div key={row.node.path} id={`${treeId}-${i}`} role="treeitem" aria-level={row.depth + 1} aria-expanded={row.node.isDir ? row.node.expanded : undefined} aria-selected={row.node.path === selected} className={`cda-tree-row cda-virtual-row clickable ${row.node.isDir ? "dir" : "file"} ${row.node.path === selected ? "active" : ""} ${i === focus ? "keyboard-lead" : ""}`} style={{ top: i * 26, paddingLeft: 8 + row.depth * 14 }} title={row.node.path}
          onClick={e => { setFocusKey(rowKey(row)); setSelected(row.node.path); viewport.current?.focus(); if (row.node.isDir) { if (e.detail === 1) toggle(row.node); } else if (singleOpens && e.detail === 1) onOpenFile(row.node.path, previewOpen ? { preview: true } : undefined); }}
          onDoubleClick={() => { if (!row.node.isDir && !singleOpens) onOpenFile(row.node.path); }}
          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, node: row.node }); }}>
          <span className={`cda-chevron ${row.node.isDir ? "" : "leaf"}`}><Icon name={row.node.expanded ? "chevronDown" : "chevronRight"} size={12} /></span><Icon name={row.node.isDir ? row.node.expanded ? "folderOpen" : "folder" : "file"} size={14} /><span className="cda-tree-name ellipsis">{row.node.name}</span>{row.node.loading && <span className="cda-loading">…</span>}
        </div>;
      })}</div>}
    </div>
    {menu && <FileContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.node)} onSelect={handleMenuSelect} onClose={() => setMenu(null)} />}
    {deleteTarget && <Confirm title="确认删除" message={`将删除：\n${deleteTarget.path}\n\n此操作不可撤销；目录只能删除空目录。`} danger onOk={() => void confirmDelete()} onCancel={() => setDeleteTarget(null)} />}
  </>;
}
