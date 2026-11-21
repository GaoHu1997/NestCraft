import { Icon } from "@/components/icons";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import * as perf from "@/api/editor-performance";
import { Empty } from "@/components/ui";
import { virtualRange } from "./performance-model";

interface Node extends perf.DirectoryEntry { parent: string; expanded: boolean; loaded: boolean; children: string[]; cursor: string | null; loading: boolean; error?: string; revision?: string }
type Row = { kind: "node"; node: Node; depth: number } | { kind: "more"; parent: string; depth: number; loading: boolean; error?: string };
const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const ROOT = "";
const rowKey = (row: Row) => row.kind === "node" ? row.node.path : `more:${row.parent}`;

/** UI-CR055-FEAT007-v1: one directory page per expansion, viewport-only DOM. */
export function FileTree({ rootUri, onOpenFile }: { rootUri: string; onOpenFile: (path: string) => void }) {
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
    if (viewport.current) viewport.current.scrollTop = 0;
    void load(ROOT);
    return () => { generation.current++; cancelSearch(false); };
  }, [rootUri, load, cancelSearch]);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const measure = () => setHeight(element.clientHeight || 600);
    const observer = new ResizeObserver(measure); observer.observe(element); measure(); return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (parent: string, depth: number) => {
      const d = parent === ROOT ? root.current : store.current.get(parent); if (!d) return;
      for (const id of d.children) { const n = store.current.get(id); if (!n) continue; out.push({ kind: "node", node: n, depth }); if (n.isDir && n.expanded) walk(n.path, depth + 1); }
      if (d.cursor || (parent !== ROOT && (d.loading || d.error))) out.push({ kind: "more", parent, depth, loading: d.loading, error: d.error });
    };
    walk(ROOT, 0); return out;
  }, [version]);
  const focus = Math.max(0, rows.findIndex(row => rowKey(row) === focusKey));
  const range = virtualRange(rows.length, scrollTop, height);
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
  const pick = async (row: Row) => {
    if (row.kind === "more") {
      if (!row.loading) { const d = row.parent === ROOT ? root.current : store.current.get(row.parent); const before = d?.children.length ?? 0; await load(row.parent, !!row.error); const first = d?.children[row.error ? 0 : before]; if (first) setFocusKey(first); }
      return;
    }
    if (row.node.isDir) toggle(row.node);
    else { setSelected(row.node.path); onOpenFile(row.node.path); }
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
    <div ref={viewport} className="cda-tree-body cda-virtual-tree" role="tree" tabIndex={0} aria-label="项目文件" aria-activedescendant={focus >= range.start && focus < range.end ? `${treeId}-${focus}` : undefined} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} onKeyDown={e => {
      if (!rows.length || e.nativeEvent.isComposing) return;
      if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(e.key)) { e.preventDefault(); reveal(e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : focus + (e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : Math.max(1, Math.floor(height / 26)) * (e.key === "PageDown" ? 1 : -1))); }
      const row = rows[focus]; if (!row) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(row); }
      if (row.kind === "node" && e.key === "ArrowRight") { e.preventDefault(); if (row.node.isDir && !row.node.expanded) toggle(row.node); }
      if (row.kind === "node" && e.key === "ArrowLeft") { e.preventDefault(); if (row.node.isDir && row.node.expanded) toggle(row.node); else reveal(rows.findIndex(r => r.kind === "node" && r.node.path === row.node.parent)); }
    }}>
      {root.current.error ? <Empty title="读取目录失败" desc={root.current.error} action={<button className="btn sm" onClick={() => void load(ROOT, true)}>重试</button>} /> : !root.current.loaded ? <div className="cda-search-note muted small">加载目录…</div> : rows.length === 0 ? <Empty title="空目录" desc="项目根目录没有可见文件" /> : <div className="cda-virtual-space" style={{ height: range.totalHeight }}>{rows.slice(range.start, range.end).map((row, n) => {
        const i = range.start + n;
        return row.kind === "more" ? <button key={`more:${row.parent}`} id={`${treeId}-${i}`} role="treeitem" tabIndex={-1} className="cda-tree-row cda-virtual-row cda-more" style={{ top: i * 26, paddingLeft: 8 + row.depth * 14 }} onClick={() => { setFocusKey(rowKey(row)); viewport.current?.focus(); void pick(row); }} disabled={row.loading} title={row.error}>{row.loading ? "加载目录…" : row.error ? "读取失败 · 点击重新加载目录" : "加载更多文件…"}</button> : <div key={row.node.path} id={`${treeId}-${i}`} role="treeitem" aria-level={row.depth + 1} aria-expanded={row.node.isDir ? row.node.expanded : undefined} aria-selected={row.node.path === selected} className={`cda-tree-row cda-virtual-row clickable ${row.node.isDir ? "dir" : "file"} ${row.node.path === selected ? "active" : ""} ${i === focus ? "keyboard-lead" : ""}`} style={{ top: i * 26, paddingLeft: 8 + row.depth * 14 }} title={row.node.path} onClick={() => { setFocusKey(rowKey(row)); void pick(row); viewport.current?.focus(); }}>
          <span className={`cda-chevron ${row.node.isDir ? "" : "leaf"}`}><Icon name={row.node.expanded ? "chevronDown" : "chevronRight"} size={12} /></span><Icon name={row.node.isDir ? row.node.expanded ? "folderOpen" : "folder" : "file"} size={14} /><span className="cda-tree-name ellipsis">{row.node.name}</span>{row.node.loading && <span className="cda-loading">…</span>}
        </div>;
      })}</div>}
    </div>
  </>;
}
