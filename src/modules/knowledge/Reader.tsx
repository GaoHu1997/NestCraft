import { Icon } from "@/components/icons";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "@/api";
import type { KnowledgeHit, KnowledgeLibrary, NoteContent, NoteNode, Project } from "@/api";
import { Empty, Modal, renderMarkdown, useToast } from "@/components/ui";
import { useApp } from "@/store/app";
import { GrantDialog } from "./KnowledgeHome";
import { TocPanel, type TocEntry } from "./TocPanel";
import "./knowledge.css";

const lastNoteByLib = new Map<string, string>();
function errText(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function firstFile(nodes: NoteNode[]): NoteNode | null {
  for (const n of nodes) { if (!n.isDir) return n; const hit = firstFile(n.children); if (hit) return hit; }
  return null;
}
function findFile(nodes: NoteNode[], id: string): NoteNode | null {
  for (const n of nodes) { if (!n.isDir && n.noteId === id) return n; const hit = findFile(n.children, id); if (hit) return hit; }
  return null;
}
function dirTrailTo(nodes: NoteNode[], id: string, trail: string[] = []): string[] | null {
  for (const n of nodes) { if (n.noteId === id) return trail; const found = dirTrailTo(n.children, id, n.isDir ? [...trail, n.noteId] : trail); if (found) return found; }
  return null;
}
/** 不从字符串内容猜测格式；现行 kb_read 只提供 Markdown 原文。 */
export function fileType(uri: string): string {
  return /\.([a-z0-9]+)$/i.exec(uri.replace(/\\/g, "/"))?.[1].toLowerCase() ?? "unknown";
}
const FILE_ICONS: Record<string, string> = { md: "fileText", markdown: "fileText", txt: "fileText", doc: "fileWord", docx: "fileWord", xls: "fileSheet", xlsx: "fileSheet", csv: "csv", ppt: "fileSlides", pptx: "fileSlides", pdf: "filePdf", png: "image", jpg: "image", jpeg: "image", svg: "image", zip: "fileArchive" };
function FileGlyph({ type, folder = false }: { type: string; folder?: boolean }) {
  return <span className={`kb-tree-file type-${type}`} aria-hidden><Icon name={folder ? "folder" : FILE_ICONS[type] ?? "file"} size={15} /></span>;
}

export function Reader(props: { libId: string; noteId?: string; visible?: boolean }) {
  return <ReaderView key={props.libId} libId={props.libId} initialNoteId={props.noteId} visible={props.visible ?? true} />;
}

function ReaderView({ libId, initialNoteId, visible }: { libId: string; initialNoteId?: string; visible: boolean }) {
  const { go } = useApp();
  const toast = useToast();
  const [library, setLibrary] = useState<KnowledgeLibrary | null>(null);
  const [tree, setTree] = useState<NoteNode[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selected, setSelected] = useState<NoteNode | null>(null);
  const [note, setNote] = useState<NoteContent | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [refOpen, setRefOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const requestSeq = useRef(0);
  const treeSeq = useRef(0);
  const scanBusy = useRef(false);
  const selectedRef = useRef<NoteNode | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const type = fileType(note?.relativeUri ?? selected?.relativeUri ?? "");

  const loadNote = useCallback(async (node: NoteNode) => {
    if (!visibleRef.current) return;
    const seq = ++requestSeq.current;
    selectedRef.current = node;
    setSelected(node);
    lastNoteByLib.set(libId, node.noteId);
    setNote(null);
    setHtml(null);
    setNoteError(null);
    // 多格式原件与解析 API 未实现时，显示 unsupported，不把 PDF/Office 字符串交给 Markdown。
    if (fileType(node.relativeUri) !== "md") { setNoteLoading(false); return; }
    setNoteLoading(true);
    try {
      const nc = await api.kbRead(libId, node.noteId);
      if (requestSeq.current !== seq) return;
      if (nc.noteId !== node.noteId) throw new Error("返回的文件身份与选择不一致");
      setNote(nc);
      if (fileType(nc.relativeUri) !== "md") return;
      const rendered = await renderMarkdown(nc.content);
      if (requestSeq.current === seq) setHtml(rendered);
    } catch (e) {
      if (requestSeq.current === seq) setNoteError("读取或渲染失败：" + errText(e));
    } finally {
      if (requestSeq.current === seq) setNoteLoading(false);
    }
  }, [libId]);

  const loadTree = useCallback(async () => {
    if (!visibleRef.current) return;
    const seq = ++treeSeq.current;
    try {
      const nodes = await api.kbTree(libId);
      if (treeSeq.current !== seq) return;
      setTree(nodes);
      setTreeError(null);
      const preferred = selectedRef.current?.noteId ?? initialNoteId ?? lastNoteByLib.get(libId);
      const target = (preferred ? findFile(nodes, preferred) : null) ?? firstFile(nodes);
      if (target) {
        const trail = dirTrailTo(nodes, target.noteId) ?? [];
        setCollapsed((prev) => { const next = new Set(prev); trail.forEach((id) => next.delete(id)); return next; });
        void loadNote(target);
      } else {
        requestSeq.current += 1;
        selectedRef.current = null;
        setSelected(null); setNote(null); setHtml(null); setNoteError(null); setNoteLoading(false);
      }
    } catch (e) {
      if (treeSeq.current === seq) { setTree([]); setTreeError(errText(e)); }
    }
  }, [libId, initialNoteId, loadNote]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    api.kbList().then((ls) => { if (alive) setLibrary(ls.find((l) => l.id === libId) ?? null); }).catch((e) => { if (alive) toast("知识库名称加载失败：" + errText(e), "err"); });
    void loadTree();
    return () => { alive = false; treeSeq.current += 1; requestSeq.current += 1; };
  }, [libId, loadTree, toast, visible]);

  useEffect(() => { if (mainRef.current) mainRef.current.scrollTop = 0; }, [selected?.noteId]);
  useEffect(() => {
    let alive = true;
    setHits(null); setSearchError(null);
    const q = query.trim();
    if (!q || !visible) return;
    const timer = window.setTimeout(() => {
      api.kbSearch([libId], q).then((res) => { if (alive) setHits(res); }).catch((e) => { if (alive) { setHits([]); setSearchError(errText(e)); } });
    }, 300);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [libId, query, visible]);

  const openHit = (hit: KnowledgeHit) => {
    setQuery("");
    const node = findFile(tree ?? [], hit.noteId) ?? { noteId: hit.noteId, title: hit.title, relativeUri: hit.relativeUri, isDir: false, children: [] };
    const trail = dirTrailTo(tree ?? [], hit.noteId) ?? [];
    setCollapsed((prev) => { const next = new Set(prev); trail.forEach((id) => next.delete(id)); return next; });
    void loadNote(node);
  };
  const rescan = async () => {
    if (scanBusy.current || !visibleRef.current) return;
    scanBusy.current = true; setScanning(true);
    try { const n = await api.kbScan(libId); toast(`已索引 ${n} 篇 Markdown`); await loadTree(); }
    catch (e) { toast("扫描失败：" + errText(e), "err"); }
    finally { scanBusy.current = false; setScanning(false); }
  };

  // 从安全渲染结果提取真实标题锚点，避免 Markdown 内联标记与目录 id 不一致。
  const toc = useMemo<TocEntry[]>(() => {
    if (!html) return [];
    const doc = new DOMParser().parseFromString(html, "text/html");
    return Array.from(doc.querySelectorAll("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]")).map((h) => ({ level: Number(h.tagName.slice(1)), text: h.textContent ?? "", id: h.id }));
  }, [html]);
  const jumpToHeading = (id: string) => {
    const h = Array.from(mainRef.current?.querySelectorAll<HTMLElement>("[id]") ?? []).find((el) => el.id === id);
    h?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const renderTree = (nodes: NoteNode[], depth: number): ReactNode => nodes.map((n) => {
    const open = !collapsed.has(n.noteId);
    return <div key={n.noteId}><button className={`kb-doc ${n.isDir ? "kb-folder" : ""} ${selected?.noteId === n.noteId ? "active" : ""}`} style={{ paddingLeft: 10 + depth * 12 }} title={n.relativeUri} aria-expanded={n.isDir ? open : undefined} onClick={() => { if (n.isDir) setCollapsed((prev) => { const next = new Set(prev); if (next.has(n.noteId)) next.delete(n.noteId); else next.add(n.noteId); return next; }); else { void loadNote(n); setNavOpen(false); } }}><span className="kb-caret">{n.isDir ? <Icon name={open ? "chevronDown" : "chevronRight"} size={12} /> : ""}</span><FileGlyph type={fileType(n.relativeUri)} folder={n.isDir} /><span className="kb-doc-t"><b className="ellipsis">{n.title}</b>{!n.isDir && <span className="ellipsis">{n.relativeUri} · {fileType(n.relativeUri).toUpperCase()}</span>}</span></button>{n.isDir && open && renderTree(n.children, depth + 1)}</div>;
  });
  const title = note?.title ?? selected?.title;
  const uri = note?.relativeUri ?? selected?.relativeUri;

  return (
    <div className={`kb-reader ${navOpen ? "show-nav" : ""}`}>
      <aside className="kb-side">
        <div className="kb-side-top"><b className="row"><FileGlyph type="md" />{library?.name ?? "知识库名称加载中…"}</b><div className="muted small">{library ? `${library.noteCount} 篇 Markdown · 索引版本 ${library.revision}` : "元信息未知"}</div></div>
        <div className="kb-search"><input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索文件或正文" aria-label="搜索文件或正文" /></div>
        <div className="kb-side-body">{query.trim() ? searchError ? <p className="kb-side-note" role="alert">搜索失败：{searchError}</p> : hits === null ? <div className="kb-side-note">搜索中…</div> : hits.length ? <div className="kb-hits">{hits.map((h) => <button key={h.noteId} className="kb-hit" onClick={() => openHit(h)}><b>{h.title}</b><span>{h.relativeUri}</span><span>{h.snippet}</span></button>)}</div> : <div className="kb-side-note">没有命中，换一个关键词。</div> : tree === null ? <div className="kb-side-note">目录加载中…</div> : treeError ? <div className="kb-side-note">目录加载失败</div> : tree.length ? renderTree(tree, 0) : <div className="kb-side-note">暂无文件</div>}</div>
        <div className="kb-nav-foot"><button className="btn sm" disabled={!library} onClick={() => setGrantOpen(true)}>授权管理</button></div>
      </aside>
      <section className="kb-main" ref={mainRef} aria-label="正文阅读区">
        <div className="kb-article-h"><button className="btn sm kb-nav-toggle" onClick={() => setNavOpen((v) => !v)}>文件</button><div className="kb-crumb"><button className="backlink" onClick={() => go({ page: "knowledge" })}>知识库</button><span>/</span><span>{library?.name ?? libId}</span>{title && <><span>/</span><span className="ellipsis" title={title}>{title}</span></>}</div><span className="spacer" />{selected && <span className="tag">{type === "unknown" ? "未知格式" : type.toUpperCase()}</span>}<button className="btn sm" disabled={!selected || type !== "md" || !html || noteLoading || !!noteError} onClick={() => setRefOpen(true)}>引用</button></div>
        <div className="kb-article">
          {tree === null || noteLoading ? <div aria-label="正文加载中"><div className="kb-skel kb-skel-title" /><div className="kb-skel" /><div className="kb-skel" /></div> : treeError ? <Empty title="目录加载失败" desc={treeError} action={<button className="btn" onClick={() => void loadTree()}>重试</button>} /> : !tree.length ? <Empty title="知识库为空" desc="当前扫描仅索引 .md 文件；不代表其它格式已解析。" action={<button className="btn primary" disabled={scanning} onClick={() => void rescan()}>{scanning ? "扫描中…" : "重新扫描"}</button>} /> : noteError ? <Empty title="无法显示正文" desc={noteError} action={selected ? <button className="btn" onClick={() => void loadNote(selected)}>重试</button> : undefined} /> : selected && type !== "md" ? <div className="kb-file-preview" data-state="unsupported"><FileGlyph type={type} /><b>{title}</b><p>{type === "unknown" ? "未知文件格式，无法内嵌预览。" : `${type.toUpperCase()} 预览暂不支持。`}当前接口没有该格式的原件／解析结果，不会当作 Markdown 或表格假解析。</p></div> : note ? <article className="kb-content" dangerouslySetInnerHTML={{ __html: html ?? "" }} /> : <Empty title="未选择文件" desc="从左侧目录树选择文件开始阅读。" />}
        </div>
      </section>
      <aside className="kb-toc" aria-label="正文目录或文件信息">
        {html ? <TocPanel toc={toc} onJump={jumpToHeading} /> : <div className="kb-toc-panel"><div className="kb-toc-head">文件信息</div><div className="kb-info"><div><span>类型</span><b>{selected ? type.toUpperCase() : "未知"}</b></div><div><span>大小</span><b>未知（接口未提供）</b></div><div><span>更新</span><b>未知（接口未提供）</b></div><div><span>路径</span><b className="mono">{uri ?? "未选择"}</b></div></div></div>}
        <div className="kb-source"><div className="kb-toc-head">来源</div><p className="muted small">本地文件只读引用</p><p className="mono small">{library?.name ?? libId}</p></div>
      </aside>
      {grantOpen && library && <GrantDialog library={library} visible={visible} onClose={() => setGrantOpen(false)} />}
      {refOpen && selected && visible && <ReferenceDialog libId={libId} noteId={selected.noteId} title={title ?? selected.title} onClose={() => setRefOpen(false)} />}
    </div>
  );
}

/** 不凭空注入其它会话，也不调用模型：只进入现有获授权项目，由其 @ 引用入口复检权限。 */
function ReferenceDialog({ libId, noteId, title, onClose }: { libId: string; noteId: string; title: string; onClose: () => void }) {
  const { go } = useApp();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([api.listProjects(), api.kbGrants()]).then(([ps, gs]) => { if (alive) setProjects(ps.filter((p) => gs.some((g) => g.projectId === p.id && g.libraryId === libId && g.readAllowed))); }).catch((e) => { if (alive) setError(errText(e)); });
    return () => { alive = false; };
  }, [libId]);
  return <div className="kb-dialog"><Modal title="引用到项目会话" width={620} onClose={onClose}><div className="kb-grant-box"><b>{title}</b><p className="mono small">{libId} / {noteId}</p><p className="muted small">仅列已授权项目。进入后，在 AI 输入框的 @ 知识入口选择该文件；本按钮不自动发送消息、不将正文注入会话。</p>{error ? <p role="alert">授权读取失败：{error}</p> : projects === null ? <p>授权加载中…</p> : projects.length === 0 ? <Empty title="没有可引用的项目" desc="先在授权管理中授予项目只读访问权。" /> : projects.map((p) => <button className="btn" key={p.id} onClick={() => { onClose(); go({ page: "project", projectId: p.id, tab: "code" }); }}>前往「{p.name}」引用</button>)}</div></Modal></div>;
}
