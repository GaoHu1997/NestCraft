import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "@/api";
import { Icon } from "@/components/icons";
import { Empty, renderMarkdown } from "@/components/ui";
import { PaneToggle, ResizeHandle, usePaneWidth } from "@/components/pane-resize";
import { TabMoreDropdown, TabMoreIcon, useTabOverflow } from "@/components/tab-overflow";
import { closeReadingTab, orderReadingSources, splitReadingFrontMatter, type ReadingSource } from "./requirementSources";
import { RequirementMindmapPane } from "./RequirementMindmapPane";
import { readDesignModels, type DesignModel } from "./requirementModels";

interface ReadState { state: "loading" | "ready" | "error"; text?: string; html?: string; error?: string }
type Mode = "document" | "preview" | "map";
/** UI-CR066：Vision 与下方 Epic／Feature／Story 同名同级，统一使用英文层级名。 */
const kindNames = { vision: "Vision", epic: "Epic", feature: "Feature", story: "Story", bug: "Bug", file: "文件" };

export function RequirementsReading({ project, sources, loading, errors, warnings, complete, revision, focusEntityId, onFocusDone, onReload, onNew, onEdit, onDelete, onAddChild, onDispatch, onOpenModel }: {
  project: api.Project; sources: ReadingSource[]; loading: boolean; errors: string[]; warnings: string[]; complete: boolean; revision: number;
  focusEntityId?: string | null; onFocusDone?: () => void; onReload: () => void; onNew: () => void;
  onEdit: (node: api.RequirementNode) => void; onDelete: (node: api.RequirementNode) => void;
  onAddChild: (node: api.RequirementNode) => void; onDispatch: (node: api.RequirementNode) => void;
  /** UI-CR066 r2：打开数据库／领域设计模型文档（跳到「设计 → 数据库」）。 */
  onOpenModel?: (model: DesignModel) => void;
}) {
  const scope = useId().replace(/:/g, "");
  const rootRef = useRef<HTMLDivElement>(null), readerRef = useRef<HTMLElement>(null);
  const [mode, setMode] = useState<Mode>("document"), [query, setQuery] = useState("");
  const [tabs, setTabs] = useState<string[]>([]), [active, setActive] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(new Set<string>()), [mapCollapsed, setMapCollapsed] = useState(new Set<string>());
  const [zoom, setZoom] = useState(1), [reads, setReads] = useState<Record<string, ReadState>>({});
  const [toc, setToc] = useState<{ id: string; text: string; level: number }[]>([]);
  /* UI-CR066：导图选中节点、目录折叠章节各自独立保存。 */
  const [mapSelected, setMapSelected] = useState<string | null>(null);
  const [tocCollapsed, setTocCollapsed] = useState<Set<string>>(new Set());
  /* UI-CR066 r2：模型来自项目 docs/DB 的数据库／领域设计文档，作为项目级独立分支。 */
  const [models, setModels] = useState<DesignModel[]>([]);
  useEffect(() => {
    let alive = true;
    void readDesignModels(project.rootUri).then(list => { if (alive) setModels(list); });
    return () => { alive = false; };
  }, [project.rootUri, revision]);

  const scrolls = useRef(new Map<string, number>());
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
  useEffect(() => {
    if (!menu) return;
    const outside = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node) && !menuTrigger.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenu(null); menuTrigger.current?.focus(); } };
    window.addEventListener("mousedown", outside); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("mousedown", outside); window.removeEventListener("keydown", escape); };
  }, [menu]);
  const toggle = (key: string, setter: typeof setCollapsed) => setter(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const close = (key: string) => { capture(); const next = closeReadingTab(tabs, active, key, vision?.key ?? null); setTabs(next.tabs); setActive(next.active); };
  // CR-052 / UI-TAB-001：内部文档页签溢出统一走共享「更多」下拉，不出现横向滚动条。
  const reqTabItems = tabs.map(key => { const source = byKey.get(key); return source ? { key, sub: source.kind === "vision" ? "Vision" : source.entityId ?? "文件", label: source.title, active: active === key } : { key, label: key, active: active === key }; });
  const reqTabSig = reqTabItems.map(item => `${item.key}:${item.label}:${item.active ? 1 : 0}`).join("|");
  const reqTabsOverflow = useTabOverflow({ tabSelector: ".req-tab", items: reqTabItems, deps: [reqTabSig] });
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
  /* CR-029 分级：全文预览按实体层级排版（Vision H2 / Epic H3 / Feature H4 / Story H5），
     文档模式仍是当前文档标题 H1。预览的目录因此具备父子层级，可折叠子章节。 */
  const PREVIEW_HEADING: Record<string, "h2" | "h3" | "h4" | "h5"> = { vision: "h2", epic: "h3", feature: "h4", story: "h5", bug: "h5", file: "h2" };
  const document = (source: ReadingSource) => {
    const read = reads[source.key], node = source.node;
    const Heading = mode === "preview" ? PREVIEW_HEADING[source.kind] ?? "h2" : "h1";
    return <section key={source.key} className="req-entity" data-source-uri={source.sourceUri} data-entity-id={source.entityId ?? undefined}>
      <div className="req-entity-meta"><span>{kindNames[source.kind]}</span>{source.entityId && <span>{source.entityId}</span>}<span>{node?.status ?? "未登记状态"}</span></div>
      <Heading id={`${idFor(source)}-title`}>{source.title}</Heading><p className="req-source">项目源文件：{source.sourceUri}</p>
      {source.warning && <p className="req-source-warning">{source.warning}</p>}
      {source.error && <div className="req-source-error" role="alert">源清单错误：{source.error}<button className="btn sm" onClick={onReload}>重新扫描源</button></div>}
      {read?.state === "error" ? <div className="req-source-error" role="alert"><b>读取文档失败</b><p>{read.error}</p><button className="btn sm" onClick={() => void load(source, true)}>重试读取</button></div>
        : read?.state === "ready" ? <><ReadingHtml html={read.html ?? ""} prefix={idFor(source)} baseLevel={mode === "preview" ? 2 : 1} />{!splitReadingFrontMatter(read.text ?? "").body.trim() && <p className="muted">此源文件没有 Markdown 正文；不生成虚构内容。</p>}
          {splitReadingFrontMatter(read.text ?? "").metadata && <details className="req-source-field"><summary>源文件元数据</summary><pre>{splitReadingFrontMatter(read.text ?? "").metadata}</pre></details>}</>
        : <p className="req-source" role="status">读取文档中…</p>}
    </section>;
  };
  const menuAction = (action: (node: api.RequirementNode) => void) => { if (menu?.source.node) action(menu.source.node); setMenu(null); };
  /* UI-CR066：预览与导图是独立阅读方式，各有自己的导航；需求树只在「文档」模式出现。
     预览用右侧全文目录，导图用「导图目录」，都不再并排需求树。 */
  const isMap = mode === "map", isPreview = mode === "preview", showTree = !isMap && !isPreview;
  const toggleToc = (id: string) => setTocCollapsed(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
  /* UI-CR066 r2：预览目录按 Vision／Epic／Feature／Story 四级实体树组织，模型作为项目级分支。
     实体内部小节仍可从正文标题进入，但目录主体是四层需求结构。 */
  const previewOutline = useMemo(() => {
    type OutlineItem = { id: string; kind: string; depth: number; title: string; hasKids: boolean };
    const items: OutlineItem[] = [];
    const kidsOf = new Map<string, typeof rows>();
    rows.forEach(row => { if (row.parentKey) kidsOf.set(row.parentKey, [...(kidsOf.get(row.parentKey) ?? []), row]); });
    const walk = (row: typeof rows[number], depth: number) => {
      const kids = kidsOf.get(row.source.key) ?? [];
      items.push({ id: row.source.key, kind: row.source.kind, depth, title: row.source.title, hasKids: kids.length > 0 });
      kids.forEach(child => walk(child, depth + 1));
    };
    rows.filter(row => !row.parentKey).forEach(row => walk(row, 0));
    /* 模型是项目级独立分支，与需求条目同列显示在目录末尾。 */
    models.forEach(model => items.push({ id: `model:${model.id}`, kind: "model", depth: 0, title: model.title, hasKids: false }));
    return items;
  }, [rows, models]);
  /* 预览目录折叠：被折叠条目的下级整体隐藏。 */
  const previewOutlineVisible = useMemo(() => {
    const visible: typeof previewOutline = [];
    let hiddenDepth = -1;
    previewOutline.forEach(item => {
      if (hiddenDepth >= 0 && item.depth > hiddenDepth) return;
      hiddenDepth = -1;
      visible.push(item);
      if (item.hasKids && tocCollapsed.has(item.id)) hiddenDepth = item.depth;
    });
    return visible;
  }, [previewOutline, tocCollapsed]);
  /* 目录按标题层级折叠子章节：父级被折叠时，其下级别条目整体隐藏。 */
  const tocVisible = useMemo(() => {
    const visible: typeof toc = [];
    let hiddenLevel = 0;
    toc.forEach(heading => {
      if (hiddenLevel && heading.level > hiddenLevel) return;
      hiddenLevel = 0;
      visible.push(heading);
      if (tocCollapsed.has(heading.id)) hiddenLevel = heading.level;
    });
    return visible;
  }, [toc, tocCollapsed]);
  const tocHasKids = (heading: { id: string; level: number }) => {
    const index = toc.findIndex(item => item.id === heading.id);
    return index >= 0 && toc.slice(index + 1).some(next => next.level > heading.level);
  };
  const jumpToHeading = (id: string) => {
    const reader = readerRef.current;
    const target = Array.from(reader?.querySelectorAll<HTMLElement>("[id]") ?? []).find(element => element.id === id);
    if (!reader || !target || !reader.contains(target)) return;
    reader.scrollTop += target.getBoundingClientRect().top - reader.getBoundingClientRect().top - 16;
    scrolls.current.set(readerKey, reader.scrollTop);
  };
  /* 预览目录跳到对应实体标题；模型跳到模型段落。 */
  const jumpToEntity = (item: { id: string; kind: string }) => {
    const reader = readerRef.current;
    if (!reader) return;
    const targetId = item.kind === "model" ? `${scope}-models-title` : `${idFor(byKey.get(item.id) ?? sources[0])}-title`;
    const target = Array.from(reader.querySelectorAll<HTMLElement>("[id]")).find(element => element.id === targetId);
    if (!target) return;
    reader.scrollTop += target.getBoundingClientRect().top - reader.getBoundingClientRect().top - 16;
    scrolls.current.set(readerKey, reader.scrollTop);
  };
  return <div ref={rootRef} className="req-workspace" data-ui-version="UI-CR066-v1" data-mode={mode}>
    <nav className="req-rail" aria-label="需求工作区">
      {([["document", "fileText", "文档", "需求文档"], ["preview", "eye", "全文", "全文预览"], ["map", "workflow", "导图", "思维导图"]] as const).map(([value, icon, label, title]) => <button key={value} className={`rail-btn ${mode === value ? "on" : ""}`} aria-label={title} aria-pressed={mode === value} title={title} onClick={() => switchMode(value)}><Icon name={icon} size={18} /><span>{label}</span></button>)}
      <div className="rail-sep" />{showTree && <PaneToggle pane={treePane} label="需求树" controls={`${scope}-tree`} className="rail-btn" aria-label="切换需求树"><Icon name="panelLeft" size={18} /><span>需求树</span></PaneToggle>}
      {!isMap && <PaneToggle pane={tocPane} label="章节目录" controls={`${scope}-toc`} className="rail-btn" aria-label="切换章节目录"><Icon name="panelRight" size={18} /><span>目录</span></PaneToggle>}
    </nav>
    {showTree && <aside {...treePane.paneProps} id={`${scope}-tree`} className={`req-tree-pane ${treePane.paneProps.className}`}>
      <div className="req-tree-head"><b>需求文档</b><button className="icon-btn" aria-label="新增Epic" title="新增Epic" onClick={onNew}><Icon name="plus" size={14} /></button></div>
      <label className="req-search"><Icon name="search" size={14} /><input className="input" aria-label="搜索需求" placeholder="搜索编号、标题" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="req-tree-scroll" role="tree" aria-label="需求树">{visibleRows.map(({ source, depth }) => <div key={source.key} className={`req-tree-row ${active === source.key ? "on" : ""}`} style={{ "--req-depth": matching ? 0 : depth } as React.CSSProperties} role="treeitem" aria-selected={active === source.key} aria-expanded={children.has(source.key) ? !collapsed.has(source.key) : undefined}>
        {children.has(source.key) ? <button className="req-tree-caret" aria-label={`${collapsed.has(source.key) ? "展开" : "折叠"}${source.title}`} onClick={() => toggle(source.key, setCollapsed)}><Icon name={collapsed.has(source.key) ? "chevronRight" : "chevronDown"} size={14} /></button> : <span className="req-tree-caret" />}
        <button className="req-tree-open" onClick={() => open(source)} title={`${source.entityId ?? "文件"} ${source.title}`}><span className={`req-kind ${source.kind}`}>{kindNames[source.kind]}</span><span className="ellipsis">{source.title}</span><small>{source.entityId ?? source.sourceUri}</small></button>
        {source.node && <button className="req-row-more" aria-label={`更多操作 ${source.entityId}`} aria-haspopup="menu" aria-expanded={menu?.source.key === source.key} onClick={event => { const r = event.currentTarget.getBoundingClientRect(); menuTrigger.current = event.currentTarget; setMenu(menu?.source.key === source.key ? null : { source, left: Math.max(8, Math.min(r.right - 184, window.innerWidth - 192)), top: Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 196)) }); }}><Icon name="more" size={14} /></button>}
      </div>)}{loading && <Empty title="读取需求源…" />}{!loading && !visibleRows.length && <Empty title={matching ? "没有匹配的需求" : "暂无需求文档"} desc="搜索与折叠不会限制全文预览。" />}</div>
      <div className="req-tree-foot">{sources.length} 个项目源文档{!complete && " · 清单未完整读取"}<br />搜索与折叠不影响全文预览<button className="btn sm" disabled={loading} onClick={onReload}>刷新</button></div>
      <ResizeHandle pane={treePane} label="需求树" controls={`${scope}-tree`} />
    </aside>}
    {isMap && <RequirementMindmapPane sources={sources} models={models} vision={vision} zoom={zoom} collapsed={mapCollapsed} selectedId={mapSelected}
      header={<>
        <div ref={reqTabsOverflow.barRef} className="req-tabs" role="tablist" aria-label="内部需求文档Tab">{tabs.map(key => { const source = byKey.get(key); if (!source) return null; return <div key={key} className={`req-tab ${active === key ? "on" : ""}`}><button role="tab" aria-selected={active === key} title={source.title} onClick={() => open(source)}><em className="req-tab-key">{source.kind === "vision" ? "Vision" : source.entityId ?? "文件"}</em><span className="req-tab-title">{source.title}</span></button><button className="req-tab-close" aria-label={`关闭${source.title}`} onClick={() => close(key)}><Icon name="x" size={14} /></button></div>; })}
          <button {...reqTabsOverflow.moreProps}><TabMoreIcon /></button>
        </div>
        <div className="req-toolbar"><span className="req-toolbar-caption">思维导图：Vision → Epic → Feature → Story</span><span className="spacer" />{current?.node && <><button className="btn sm" onClick={() => onEdit(current.node!)}><Icon name="edit" size={14} />编辑</button>{current.kind !== "vision" && <button className="btn sm" onClick={() => onDispatch(current.node!)}><Icon name="play" size={14} />派发预检</button>}</>}</div>
      </>}
      onZoom={setZoom}
      onToggleFold={id => { if (id === "__all__") { setMapCollapsed(new Set()); return; } toggle(id, setMapCollapsed); }}
      onSelect={setMapSelected}
      onCloseDetail={() => setMapSelected(null)}
      onAddChild={source => { if (source.node) onAddChild(source.node); }}
      onOpenDoc={source => open(source)}
      onOpenModel={model => onOpenModel?.(model)}
      onFit={ratio => { if (ratio === 1) { setZoom(1); setMapCollapsed(new Set()); } else { setZoom(ratio); } }}
    />}
    <section className="req-document-pane" hidden={isMap}>
      <div ref={reqTabsOverflow.barRef} className="req-tabs" role="tablist" aria-label="内部需求文档Tab">{tabs.map(key => { const source = byKey.get(key); if (!source) return null; return <div key={key} className={`req-tab ${active === key ? "on" : ""}`}><button role="tab" aria-selected={active === key} title={source.title} onClick={() => open(source)}><em className="req-tab-key">{source.kind === "vision" ? "Vision" : source.entityId ?? "文件"}</em><span className="req-tab-title">{source.title}</span></button><button className="req-tab-close" aria-label={`关闭${source.title}`} onClick={() => close(key)}><Icon name="x" size={14} /></button></div>; })}
        <button {...reqTabsOverflow.moreProps}><TabMoreIcon /></button>
      </div>
      {reqTabsOverflow.dropdownOpen && <TabMoreDropdown anchorRef={reqTabsOverflow.moreRef} items={reqTabItems} onPick={key => { const source = byKey.get(key); if (source) open(source); }} onClose={reqTabsOverflow.closeDropdown} />}
      <div className="req-toolbar">{isPreview ? <span className="req-toolbar-caption">全项目需求全文</span> : null}<span className="spacer" />{current?.node && <><button className="btn sm" onClick={() => onEdit(current.node!)}><Icon name="edit" size={14} />编辑</button>{current.kind !== "vision" && <button className="btn sm" onClick={() => onDispatch(current.node!)}><Icon name="play" size={14} />派发预检</button>}</>}</div>
      {errors.length > 0 && <div className="req-source-error" role="alert">{errors.map(error => <p key={error}>{error}</p>)}<button className="btn sm" disabled={loading} onClick={onReload}>重试源清单</button></div>}
      <article ref={readerRef} className="req-reader kb-content" aria-label={isPreview ? "全部需求全文" : "当前需求详情"} onScroll={event => { if (canCapture()) scrolls.current.set(readerKey, event.currentTarget.scrollTop); }}>
        {isPreview ? <><header className="req-preview-intro"><h1 id={`${scope}-preview`}>全项目需求 · 全文预览</h1><p>{sources.length} 个项目源文档，包含递归清单全部正文；不按搜索、折叠或派发资格过滤。{models.length > 0 && `另有 ${models.length} 个数据库／领域设计模型。`}{!complete && "源清单读取未完成，当前不能证明全文完整。"}</p>{warnings.map(warning => <p className="req-source-warning" key={warning}>{warning}</p>)}</header>{!vision && !loading && <div className="req-source-warning">项目没有可识别的真实愿景源；未合成愿景正文。</div>}{rows.map(row => document(row.source))}{models.length > 0 && <section className="req-entity req-model-entity" id={`${scope}-models`}>
          <h2 id={`${scope}-models-title`}>数据库／领域设计模型</h2>
          <p className="req-source">模型是项目级独立分支，与 Vision／Epic／Feature／Story 是关联关系，不是 Story 的第二父项。</p>
          {models.map(model => <div key={model.id} className="req-model-item">
            <div className="req-entity-meta"><span>模型</span><span>{model.id}</span></div>
            <h3>{model.title}</h3>
            <p className="req-source">项目源文件：{model.relPath}</p>
            <button className="btn sm" onClick={() => onOpenModel?.(model)}><Icon name="database" size={14} />打开模型文档</button>
          </div>)}
        </section>}</>
          : current ? document(current) : <Empty title={loading ? "读取需求源…" : "愿景源未提供"} desc={loading ? undefined : "项目没有可识别的真实愿景文件。请选择已有文档；不会把项目名称或合成目标当作愿景事实。"} action={!loading ? <button className="btn sm" onClick={onReload}>刷新源清单</button> : undefined} />}
      </article>
    </section>
    {!isMap && <aside {...tocPane.paneProps} id={`${scope}-toc`} className={`req-toc-pane ${tocPane.paneProps.className}`}>
      <ResizeHandle pane={tocPane} label="章节目录" controls={`${scope}-toc`} />
      <div className="req-toc-head"><b>{isPreview ? "全文目录" : "本页目录"}</b><span>{isPreview ? previewOutline.length : toc.length}</span></div>
      <div className="req-toc-list">
        {isPreview ? previewOutlineVisible.map(item => {
          const shut = tocCollapsed.has(item.id);
          return <div key={item.id} className="req-toc-item" style={{ "--toc-level": item.depth + 1 } as React.CSSProperties}>
            {item.hasKids ? <button className="req-toc-caret" aria-expanded={!shut} aria-label={`${shut ? "展开" : "折叠"}${item.title}`} onClick={() => toggleToc(item.id)}><Icon name={shut ? "chevronRight" : "chevronDown"} size={14} /></button> : <span className="req-toc-caret" />}
            <button className="req-toc-link" onClick={() => jumpToEntity(item)} title={item.title}>
              <span className={`req-kind ${item.kind}`}>{item.kind === "model" ? "模型" : kindNames[item.kind as keyof typeof kindNames] ?? item.kind}</span>
              <span className="ellipsis">{item.title}</span>
            </button>
          </div>;
        }) : tocVisible.map(heading => {
          const shut = tocCollapsed.has(heading.id), foldable = tocHasKids(heading);
          return <div key={heading.id} className="req-toc-item" style={{ "--toc-level": heading.level } as React.CSSProperties}>
            {foldable ? <button className="req-toc-caret" aria-expanded={!shut} aria-label={`${shut ? "展开" : "折叠"}${heading.text}`} onClick={() => toggleToc(heading.id)}><Icon name={shut ? "chevronRight" : "chevronDown"} size={14} /></button> : <span className="req-toc-caret" />}
            <button className="req-toc-link" onClick={() => jumpToHeading(heading.id)}>{heading.text}</button>
          </div>;
        })}
        {!isPreview && !toc.length && <p className="muted small">无章节</p>}
        {isPreview && !previewOutline.length && <p className="muted small">暂无需求条目</p>}
      </div>
      <div className="req-tree-foot">{isPreview ? "Vision → Epic → Feature → Story 四级" : "目录可折叠子章节"}<br />项目文件为正文权威</div>
    </aside>}
    {menu && <div ref={menuRef} className="req-menu" role="menu" style={{ left: menu.left, top: menu.top }}>{["epic", "feature"].includes(menu.source.kind) && <button role="menuitem" onClick={() => menuAction(onAddChild)}><Icon name="plus" size={14} />{menu.source.kind === "epic" ? "新增特性" : "新增用户故事"}</button>}<button role="menuitem" onClick={() => menuAction(onEdit)}>编辑</button><button role="menuitem" disabled={menu.source.kind === "vision"} onClick={() => menuAction(onDispatch)}>派发预检</button><div className="menu-sep" /><button role="menuitem" className="danger" disabled={menu.source.kind === "vision"} onClick={() => menuAction(onDelete)}>删除</button></div>}
  </div>;
}

/** 实体正文标题相对实体标题下沉一级：文档模式 h1→h2，预览模式随实体层级整体下沉。 */
function ReadingHtml({ html, prefix, baseLevel = 1 }: { html: string; prefix: string; baseLevel?: number }) {
  const namespaced = useMemo(() => {
    const doc = new DOMParser().parseFromString(html, "text/html"), ids = new Map<string, string>();
    /* 正文里的 h1 是源文件标题，应低于实体标题；其余标题保持原级别，映射到不越过 h6。 */
    const shift = (level: number) => Math.min(6, level + (baseLevel > 1 ? 1 : 0));
    doc.querySelectorAll("h1").forEach(heading => {
      const replacement = doc.createElement(`h${shift(1)}`);
      Array.from(heading.attributes).forEach(attribute => replacement.setAttribute(attribute.name, attribute.value));
      replacement.innerHTML = heading.innerHTML;
      heading.replaceWith(replacement);
    });
    doc.querySelectorAll<HTMLElement>("[id]").forEach(element => { const old = element.id, id = `${prefix}-${old}`; ids.set(old, id); element.id = id; });
    doc.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach(link => { const old = link.getAttribute("href")!.slice(1), id = ids.get(old); if (id) link.setAttribute("href", `#${id}`); else link.removeAttribute("href"); });
    return doc.body.innerHTML;
  }, [html, prefix, baseLevel]);
  return <div className="req-markdown" dangerouslySetInnerHTML={{ __html: namespaced }} />;
}
