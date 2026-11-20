import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "@/api";
import { Icon } from "@/components/icons";
import { Empty, renderMarkdown } from "@/components/ui";
import { PaneToggle, ResizeHandle, usePaneWidth } from "@/components/pane-resize";
import { closeReadingTab, orderReadingSources, splitReadingFrontMatter, type ReadingSource } from "./requirementSources";

interface ReadState { state: "loading" | "ready" | "error"; text?: string; html?: string; error?: string }
type Mode = "document" | "preview" | "map";
const kindNames = { vision: "愿景", epic: "Epic", feature: "Feature", story: "Story", bug: "Bug", file: "文件" };

export function RequirementsReading({ project, sources, loading, errors, warnings, complete, revision, focusEntityId, onFocusDone, onReload, onNew, onEdit, onDelete, onAddChild, onDispatch }: {
  project: api.Project; sources: ReadingSource[]; loading: boolean; errors: string[]; warnings: string[]; complete: boolean; revision: number;
  focusEntityId?: string | null; onFocusDone?: () => void; onReload: () => void; onNew: () => void;
  onEdit: (node: api.RequirementNode) => void; onDelete: (node: api.RequirementNode) => void;
  onAddChild: (node: api.RequirementNode) => void; onDispatch: (node: api.RequirementNode) => void;
}) {
  const scope = useId().replace(/:/g, "");
  const rootRef = useRef<HTMLDivElement>(null), readerRef = useRef<HTMLElement>(null), mapRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("document"), [query, setQuery] = useState("");
  const [tabs, setTabs] = useState<string[]>([]), [active, setActive] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(new Set<string>()), [mapCollapsed, setMapCollapsed] = useState(new Set<string>());
  const [zoom, setZoom] = useState(1), [reads, setReads] = useState<Record<string, ReadState>>({});
  const [toc, setToc] = useState<{ id: string; text: string; level: number }[]>([]);
  const scrolls = useRef(new Map<string, number>()), mapScroll = useRef([0, 0]);
  const generations = useRef(new Map<string, number>()), alive = useRef(true), rootSequence = useRef(0);
  const cache = useRef<Record<string, ReadState>>({}), revisionRef = useRef(revision);
  const [menu, setMenu] = useState<{ source: ReadingSource; left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null), menuTrigger = useRef<HTMLButtonElement | null>(null);
  const rows = useMemo(() => orderReadingSources(sources), [sources]);
  const byKey = useMemo(() => new Map(sources.map(source => [source.key, source])), [sources]);
  const vision = sources.find(source => source.kind === "vision") ?? null;
  const current = active ? byKey.get(active) ?? null : null;
  const readerKey = mode === "preview" ? "preview" : active ?? "vision-missing";
  const treePane = usePaneWidth(`project:${project.id}`, "requirements-tree", {
    default: 320, min: 200, max: 480, side: "left", containerRef: rootRef,
    reserve: 56, minCenter: 320, overlayInset: 56,
  });
  const tocPane = usePaneWidth(`project:${project.id}`, "requirements-toc", {
    default: 240, min: 160, max: 360, side: "right", containerRef: rootRef,
    reserve: 56 + (treePane.overlay ? 0 : treePane.effective), minCenter: 320, overlayInset: 56,
  });

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; rootSequence.current++; };
  }, []);
  const publish = useCallback((key: string, value: ReadState) => {
    cache.current = { ...cache.current, [key]: value }; setReads(cache.current);
  }, []);
  const load = useCallback(async (source: ReadingSource, force = false) => {
    if (!force && cache.current[source.key]) return;
    const seq = (generations.current.get(source.key) ?? 0) + 1, rootSeq = rootSequence.current;
    generations.current.set(source.key, seq); publish(source.key, { state: "loading" });
    const valid = () => alive.current && rootSequence.current === rootSeq && generations.current.get(source.key) === seq;
    try {
      const text = await api.fsReadFile(project.rootUri, source.sourceUri);
      const html = await renderMarkdown(splitReadingFrontMatter(text).body, { restrictResources: true });
      if (valid()) publish(source.key, { state: "ready", text, html });
    } catch (error) { if (valid()) publish(source.key, { state: "error", error: String(error) }); }
  }, [project.rootUri, publish]);
  useEffect(() => {
    if (revisionRef.current !== revision) {
      revisionRef.current = revision; rootSequence.current++; cache.current = {}; setReads({});
    }
    // Source completeness is independent of query, folding, dispatch eligibility and current selection.
    if (mode === "preview") {
      let cancelled = false, next = 0;
      const worker = async () => { while (!cancelled && next < sources.length) await load(sources[next++]); };
      void Promise.all(Array.from({ length: Math.min(4, sources.length) }, worker));
      return () => { cancelled = true; };
    }
    if (current) void load(current);
  }, [revision, mode, current, sources, load]);

  useEffect(() => {
    if (loading) return;
    const retained = tabs.filter(key => byKey.has(key));
    const next = retained.length ? retained : vision ? [vision.key] : [];
    if (next.length !== tabs.length || next.some((key, i) => tabs[i] !== key)) setTabs(next);
    if (!active || !next.includes(active)) setActive(next[0] ?? null);
  }, [loading, byKey, vision, tabs, active]);
  const canCapture = () => mode === "preview" ? sources.every(source => reads[source.key]?.state === "ready" || reads[source.key]?.state === "error") : !current || reads[current.key]?.state === "ready" || reads[current.key]?.state === "error";
  const capture = () => { if (readerRef.current && canCapture()) scrolls.current.set(readerKey, readerRef.current.scrollTop); };
  const switchMode = (next: Mode) => { capture(); setMode(next); };
  const open = useCallback((source: ReadingSource) => {
    const readable = readerKey === "preview" ? sources.every(item => cache.current[item.key]?.state === "ready" || cache.current[item.key]?.state === "error") : cache.current[readerKey]?.state === "ready" || cache.current[readerKey]?.state === "error";
    if (readerRef.current && readable) scrolls.current.set(readerKey, readerRef.current.scrollTop);
    setTabs(previous => previous.includes(source.key) ? previous : [...previous, source.key]); setActive(source.key);
    setMode(previous => previous === "map" ? "map" : "document");
  }, [readerKey]);
  useEffect(() => {
    if (!focusEntityId || loading) return;
    const source = sources.find(source => source.entityId === focusEntityId);
    if (source) open(source);
    onFocusDone?.();
  }, [focusEntityId, loading, sources, open, onFocusDone]);
  useLayoutEffect(() => {
    const reader = readerRef.current;
    if (!reader) return;
    reader.scrollTop = scrolls.current.get(readerKey) ?? 0;
    const headings = Array.from(reader.querySelectorAll<HTMLHeadingElement>("h1,h2,h3,h4,h5,h6"));
    const next = headings.map((heading, i) => {
      // IDs come from the rendered, sanitized DOM; namespacing prevents other kept-mounted pages matching.
      if (!heading.id) heading.id = `${scope}-section-${i}`;
      return { id: heading.id, text: heading.textContent ?? "", level: Number(heading.tagName.slice(1)) };
    });
    setToc(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, [scope, readerKey, reads, sources, mode, loading]);
  useLayoutEffect(() => { if (mapRef.current) { mapRef.current.scrollLeft = mapScroll.current[0]; mapRef.current.scrollTop = mapScroll.current[1]; } }, [mode]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node) && !menuTrigger.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenu(null); menuTrigger.current?.focus(); } };
    window.addEventListener("mousedown", outside); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("mousedown", outside); window.removeEventListener("keydown", escape); };
  }, [menu]);
  const toggle = (key: string, setter: typeof setCollapsed) => setter(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const close = (key: string) => { capture(); const next = closeReadingTab(tabs, active, key, vision?.key ?? null); setTabs(next.tabs); setActive(next.active); };
  const matching = query.trim().toLowerCase();
  const hidden = new Set<string>();
  const visibleRows = rows.filter(row => {
    if (matching) return `${row.source.entityId ?? ""} ${row.source.title} ${row.source.sourceUri}`.toLowerCase().includes(matching);
    if (row.parentKey && (collapsed.has(row.parentKey) || hidden.has(row.parentKey))) { hidden.add(row.source.key); return false; }
    return true;
  });
  const children = new Map<string, typeof rows>();
  rows.forEach(row => { if (row.parentKey) children.set(row.parentKey, [...(children.get(row.parentKey) ?? []), row]); });
  const idFor = (source: ReadingSource) => `${scope}-${encodeURIComponent(source.key)}`;
  const document = (source: ReadingSource) => {
    const read = reads[source.key], node = source.node;
    return <section key={source.key} className="req-entity" data-source-uri={source.sourceUri} data-entity-id={source.entityId ?? undefined}>
      <div className="req-entity-meta"><span>{kindNames[source.kind]}</span>{source.entityId && <span>{source.entityId}</span>}<span>{node?.status ?? "未登记状态"}</span></div>
      <h1 id={`${idFor(source)}-title`}>{source.title}</h1><p className="req-source">项目源文件：{source.sourceUri}</p>
      {source.warning && <p className="req-source-warning">{source.warning}</p>}
      {source.error && <div className="req-source-error" role="alert">源清单错误：{source.error}<button className="btn sm" onClick={onReload}>重新扫描源</button></div>}
      {read?.state === "error" ? <div className="req-source-error" role="alert"><b>读取文档失败</b><p>{read.error}</p><button className="btn sm" onClick={() => void load(source, true)}>重试读取</button></div>
        : read?.state === "ready" ? <><ReadingHtml html={read.html ?? ""} prefix={idFor(source)} />{!splitReadingFrontMatter(read.text ?? "").body.trim() && <p className="muted">此源文件没有 Markdown 正文；不生成虚构内容。</p>}
          {splitReadingFrontMatter(read.text ?? "").metadata && <details className="req-source-field"><summary>源文件元数据</summary><pre>{splitReadingFrontMatter(read.text ?? "").metadata}</pre></details>}</>
        : <p className="req-source" role="status">读取文档中…</p>}
    </section>;
  };
  const branch = (row: typeof rows[number]): React.ReactNode => {
    const source = row.source, kids = children.get(source.key) ?? [], shut = mapCollapsed.has(source.key);
    return <li key={source.key}><div className={`req-map-node ${active === source.key ? "on" : ""}`}><button className="req-map-open" onClick={() => open(source)}><small>{kindNames[source.kind]}{source.entityId ? ` · ${source.entityId}` : " · 未识别实体"}</small><b>{source.title}</b></button>{kids.length > 0 && <button className="req-map-fold" aria-label={`${shut ? "展开" : "折叠"}${source.title}`} aria-expanded={!shut} onClick={() => toggle(source.key, setMapCollapsed)}><Icon name={shut ? "plus" : "minimize"} size={14} /></button>}</div>{kids.length > 0 && !shut && <ul>{kids.map(branch)}</ul>}</li>;
  };
  const menuAction = (action: (node: api.RequirementNode) => void) => { if (menu?.source.node) action(menu.source.node); setMenu(null); };
  return <div ref={rootRef} className="req-workspace" data-ui-version="UI-CR045-v1" data-mode={mode}>
    <nav className="req-rail" aria-label="需求工作区">
      {([["document", "fileText", "文档", "需求文档"], ["preview", "eye", "全文", "全文预览"], ["map", "workflow", "导图", "思维导图"]] as const).map(([value, icon, label, title]) => <button key={value} className={`rail-btn ${mode === value ? "on" : ""}`} aria-label={title} aria-pressed={mode === value} title={title} onClick={() => switchMode(value)}><Icon name={icon} size={18} /><span>{label}</span></button>)}
      <div className="rail-sep" /><PaneToggle pane={treePane} label="需求树" controls={`${scope}-tree`} className="rail-btn" aria-label="切换需求树"><Icon name="panelLeft" size={18} /><span>需求树</span></PaneToggle>
      <PaneToggle pane={tocPane} label="章节目录" controls={`${scope}-toc`} className="rail-btn" aria-label="切换章节目录"><Icon name="panelRight" size={18} /><span>目录</span></PaneToggle>
    </nav>
    <aside {...treePane.paneProps} id={`${scope}-tree`} className={`req-tree-pane ${treePane.paneProps.className}`}>
      <div className="req-tree-head"><b>需求文档</b><button className="icon-btn" aria-label="新增Epic" title="新增Epic" onClick={onNew}><Icon name="plus" size={14} /></button></div>
      <label className="req-search"><Icon name="search" size={14} /><input className="input" aria-label="搜索需求" placeholder="搜索编号、标题" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="req-tree-scroll" role="tree" aria-label="需求树">{visibleRows.map(({ source, depth }) => <div key={source.key} className={`req-tree-row ${active === source.key ? "on" : ""}`} style={{ "--req-depth": matching ? 0 : depth } as React.CSSProperties} role="treeitem" aria-selected={active === source.key} aria-expanded={children.has(source.key) ? !collapsed.has(source.key) : undefined}>
        {children.has(source.key) ? <button className="req-tree-caret" aria-label={`${collapsed.has(source.key) ? "展开" : "折叠"}${source.title}`} onClick={() => toggle(source.key, setCollapsed)}><Icon name={collapsed.has(source.key) ? "chevronRight" : "chevronDown"} size={14} /></button> : <span className="req-tree-caret" />}
        <button className="req-tree-open" onClick={() => open(source)} title={`${source.entityId ?? "文件"} ${source.title}`}><span className={`req-kind ${source.kind}`}>{kindNames[source.kind]}</span><span className="ellipsis">{source.title}</span><small>{source.entityId ?? source.sourceUri}</small></button>
        {source.node && <button className="req-row-more" aria-label={`更多操作 ${source.entityId}`} aria-haspopup="menu" aria-expanded={menu?.source.key === source.key} onClick={event => { const r = event.currentTarget.getBoundingClientRect(); menuTrigger.current = event.currentTarget; setMenu(menu?.source.key === source.key ? null : { source, left: Math.max(8, Math.min(r.right - 184, window.innerWidth - 192)), top: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 196)) }); }}><Icon name="more" size={14} /></button>}
      </div>)}{loading && <Empty title="读取需求源…" />}{!loading && !visibleRows.length && <Empty title={matching ? "没有匹配的需求" : "暂无需求文档"} desc="搜索与折叠不会限制全文预览。" />}</div>
      <div className="req-tree-foot">{sources.length} 个项目源文档{!complete && " · 清单未完整读取"}<br />搜索与折叠不影响全文预览<button className="btn sm" disabled={loading} onClick={onReload}>刷新</button></div>
      <ResizeHandle pane={treePane} label="需求树" controls={`${scope}-tree`} />
    </aside>
    <section className="req-document-pane">
      <div className="req-tabs" role="tablist" aria-label="内部需求文档Tab">{tabs.map(key => { const source = byKey.get(key); if (!source) return null; return <div key={key} className={`req-tab ${active === key ? "on" : ""}`}><button role="tab" aria-selected={active === key} title={source.title} onClick={() => open(source)}>{source.kind === "vision" ? "愿景" : source.entityId ?? "文件"}<span>{source.title}</span></button><button className="req-tab-close" aria-label={`关闭${source.title}`} onClick={() => close(key)}><Icon name="x" size={14} /></button></div>; })}</div>
      <div className="req-toolbar"><button className={`btn sm ${mode === "preview" ? "primary" : ""}`} onClick={() => switchMode("preview")}><Icon name="eye" size={14} />全文预览</button><button className={`btn sm ${mode === "map" ? "primary" : ""}`} onClick={() => switchMode("map")}><Icon name="workflow" size={14} />思维导图</button><span className="spacer" />{current?.node && <><button className="btn sm" onClick={() => onEdit(current.node!)}><Icon name="edit" size={14} />编辑</button>{current.kind !== "vision" && <button className="btn sm" onClick={() => onDispatch(current.node!)}><Icon name="play" size={14} />派发预检</button>}</>}</div>
      {errors.length > 0 && <div className="req-source-error" role="alert">{errors.map(error => <p key={error}>{error}</p>)}<button className="btn sm" disabled={loading} onClick={onReload}>重试源清单</button></div>}
      {mode === "map" && <section className="req-map-area"><div className="req-map-controls"><b>思维导图</b><button className="btn sm" aria-label="缩小" onClick={() => setZoom(value => Math.max(.5, Math.round((value - .1) * 10) / 10))}>−</button><span>{Math.round(zoom * 100)}%</span><button className="btn sm" aria-label="放大" onClick={() => setZoom(value => Math.min(1.8, Math.round((value + .1) * 10) / 10))}>+</button><button className="btn sm" onClick={() => { setZoom(1); setMapCollapsed(new Set()); mapScroll.current = [0, 0]; mapRef.current?.scrollTo(0, 0); }}>重置</button><button className="btn sm" onClick={() => setMapCollapsed(new Set())}>全部展开</button><button className="btn sm" onClick={() => setMapCollapsed(new Set(sources.filter(source => source.kind !== "vision").map(source => source.key)))}>折叠分支</button></div>
        <div ref={mapRef} className="req-map-scroll" onScroll={event => { mapScroll.current = [event.currentTarget.scrollLeft, event.currentTarget.scrollTop]; }}><div className="req-map-scale" style={{ zoom } as React.CSSProperties}><ul className="req-map-tree">{rows.filter(row => !row.parentKey).map(branch)}{!vision && <li><div className="req-map-unavailable"><b>愿景源未提供</b><span>不生成项目愿景或关系。</span></div></li>}<li><div className="req-map-unavailable"><b>数据模型</b><span>真实模型接口／数据未接入</span><small>不生成模型或关系；AI模型配置不是业务数据模型。</small></div></li></ul></div></div><div className="req-map-help">点击节点在下方贯通详情阅读；节点选择、缩放与折叠按项目保留。</div></section>}
      <article ref={readerRef} className="req-reader kb-content" aria-label={mode === "preview" ? "全部需求全文" : "当前需求详情"} onScroll={event => { if (canCapture()) scrolls.current.set(readerKey, event.currentTarget.scrollTop); }}>
        {mode === "preview" ? <><header className="req-preview-intro"><h1 id={`${scope}-preview`}>全项目需求 · 全文预览</h1><p>{sources.length} 个项目源文档，包含递归清单全部正文；不按搜索、折叠或派发资格过滤。{!complete && "源清单读取未完成，当前不能证明全文完整。"}</p>{warnings.map(warning => <p className="req-source-warning" key={warning}>{warning}</p>)}</header>{!vision && !loading && <div className="req-source-warning">项目没有可识别的真实愿景源；未合成愿景正文。</div>}{rows.map(row => document(row.source))}</>
          : current ? document(current) : <Empty title={loading ? "读取需求源…" : "愿景源未提供"} desc={loading ? undefined : "项目没有可识别的真实愿景文件。请选择已有文档；不会把项目名称或合成目标当作愿景事实。"} action={!loading ? <button className="btn sm" onClick={onReload}>刷新源清单</button> : undefined} />}
      </article>
    </section>
    <aside {...tocPane.paneProps} id={`${scope}-toc`} className={`req-toc-pane ${tocPane.paneProps.className}`}><ResizeHandle pane={tocPane} label="章节目录" controls={`${scope}-toc`} /><div className="req-toc-head"><b>{mode === "preview" ? "全文目录" : "本页目录"}</b><span>{toc.length}</span></div><div className="req-toc-list">{toc.map(heading => <button key={heading.id} className="req-toc-link" style={{ "--toc-level": heading.level } as React.CSSProperties} onClick={() => { const reader = readerRef.current, target = Array.from(reader?.querySelectorAll<HTMLElement>("[id]") ?? []).find(element => element.id === heading.id); if (reader && target && reader.contains(target)) { reader.scrollTop += target.getBoundingClientRect().top - reader.getBoundingClientRect().top - 16; scrolls.current.set(readerKey, reader.scrollTop); } }}>{heading.text}</button>)}{!toc.length && <p className="muted small">无章节</p>}</div><div className="req-tree-foot">项目文件为正文权威<br />阅读不执行外部或本地资源</div></aside>
    {menu && <div ref={menuRef} className="req-menu" role="menu" style={{ left: menu.left, top: menu.top }}>{["epic", "feature"].includes(menu.source.kind) && <button role="menuitem" onClick={() => menuAction(onAddChild)}><Icon name="plus" size={14} />{menu.source.kind === "epic" ? "新增特性" : "新增用户故事"}</button>}<button role="menuitem" onClick={() => menuAction(onEdit)}>编辑</button><button role="menuitem" disabled={menu.source.kind === "vision"} onClick={() => menuAction(onDispatch)}>派发预检</button><div className="menu-sep" /><button role="menuitem" className="danger" disabled={menu.source.kind === "vision"} onClick={() => menuAction(onDelete)}>删除</button></div>}
  </div>;
}

function ReadingHtml({ html, prefix }: { html: string; prefix: string }) {
  const namespaced = useMemo(() => {
    const doc = new DOMParser().parseFromString(html, "text/html"), ids = new Map<string, string>();
    doc.querySelectorAll("h1").forEach(heading => {
      const replacement = doc.createElement("h2");
      Array.from(heading.attributes).forEach(attribute => replacement.setAttribute(attribute.name, attribute.value));
      replacement.innerHTML = heading.innerHTML;
      heading.replaceWith(replacement);
    });
    doc.querySelectorAll<HTMLElement>("[id]").forEach(element => { const old = element.id, id = `${prefix}-${old}`; ids.set(old, id); element.id = id; });
    doc.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach(link => { const old = link.getAttribute("href")!.slice(1), id = ids.get(old); if (id) link.setAttribute("href", `#${id}`); else link.removeAttribute("href"); });
    return doc.body.innerHTML;
  }, [html, prefix]);
  return <div className="req-markdown" dangerouslySetInnerHTML={{ __html: namespaced }} />;
}
