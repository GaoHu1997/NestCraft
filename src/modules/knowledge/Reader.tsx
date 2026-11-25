import { Icon } from "@/components/icons";
import { FileTypeIcon, fileKindOf } from "@/components/file-type-icon";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import * as api from "@/api";
import * as performanceApi from '@/api/knowledge-performance';
import type { KnowledgeEntry, KnowledgeSearchResult } from '@/api/knowledge-performance';
import { PagedKnowledgeTree, type DocCreateKind, type KnowledgeTreeHandle } from './PagedKnowledgeTree';
import { ZyDocEditor } from './ZyDocEditor';
import { MarkdownContent } from './MarkdownContent';
import { PagedDocumentPreview, isPagedDocument, type PreviewNavigation } from './PagedDocumentPreview';
import { WindowDocument } from './WindowDocument';
import { KnowledgeIndexStatus } from './KnowledgeIndexStatus';
import { KnowledgeTransferPanel, useKnowledgeTransfer } from './KnowledgeTransfer';
import { TRANSFER_LARGE_FILE } from './transferModel';
import type { KnowledgeFileData, KnowledgeFileInfo, KnowledgeHit, KnowledgeLibrary, NoteNode, Project } from "@/api";
import { Empty, Modal } from "@/components/ui";
import { PaneClose, PaneToggle, ResizeHandle, usePaneWidth } from "@/components/pane-resize";
import { useApp } from "@/store/app";
import { GrantDialog } from "./KnowledgeHome";
import { TocPanel, type TocEntry } from "./TocPanel";
import * as linksApi from '@/api/knowledge-links';
import { KnowledgeGraph } from './KnowledgeGraph';
import { SemanticModelStatus } from './SemanticModelStatus';
import type { Backlink, OutLink, LinkCandidate } from '@/api/knowledge-links';
import "./kb-links.css";
import { CACHE_PRESSURE_NOTICE, cacheKnowledgeFile, canAdmitKnowledgeFile, clearKnowledgeDocumentRetention, getKnowledgeFile, trimKnowledgeCache, acceptSavedMarkdown, checkFileIdentity, dirty, errorText, expandParents, fileType, findNode, flattenTree, isConflict, isMarkdown, knowledgeSession, markdownName, nameError, nextDraftKey, parentOf, pathTaken, readableKind, recordKnowledgeDocumentRetention, renderKnowledgeMarkdown, safeImageSource, type KnowledgeDraft } from "./knowledgeWorkspace";
import { draftReleaseConfirmed, externalChangeNotice, reachableNoteIds, reconcileKnownEntries, REFRESH_DIRECTORY_LABEL, sourceRevisionDecision, unlistedSelectionAction, type ReaderNoticeAction } from './performanceModel';
import "./knowledge.css";
import "./knowledge-cr045.css";

export { fileType } from "./knowledgeWorkspace";
/** CR-080：文件类型彩色图标（B 淡底描边）；目录用 folder 类型。 */
function FileGlyph({ type, folder = false, size = 15 }: { type: string; folder?: boolean; size?: number }) {
  return <span className="kb-tree-file" aria-hidden><FileTypeIcon kind={folder ? "folder" : fileKindOf(type)} size={size} /></span>;
}
const depthStyle = (depth: number) => ({ "--kw-depth": depth }) as CSSProperties;

/**
 * CR-068 K02：后端用稳定前缀区分源失效／索引身份／文件缺失；这里只做呈现分类，
 * 不把「父目录不可读」「权限不足」等其它失败笼统说成文件不存在。
 */
type ReaderFailureKind = "missing" | "identity" | "source" | "other";
type ReaderFailure = { kind: ReaderFailureKind; text: string };
type FailureTarget = { noteId: string; relativeUri?: string; title?: string };
const ERROR_CODE = /^KB_(?:FILE_MISSING|INDEX_IDENTITY|SOURCE_INVALID)\s*[:：]\s*/;
function classifyReaderFailure(error: unknown): ReaderFailure {
  const raw = errorText(error);
  const text = raw.replace(ERROR_CODE, "");
  if (/KB_FILE_MISSING|文件不存在/.test(raw)) return { kind: "missing", text };
  if (/KB_INDEX_IDENTITY|索引身份|身份不一致|身份冲突/.test(raw)) return { kind: "identity", text };
  // 目录/根不可访问、库停用等属于源失效；旧版 SOURCE_CHANGED/LIBRARY_UNAVAILABLE 一并识别。
  if (/KB_SOURCE_INVALID|LIBRARY_UNAVAILABLE|SOURCE_CHANGED|知识库源不可用|知识库根|知识库不存在|知识库目录不可访问|已禁用|不受管/.test(raw)) return { kind: "source", text };
  return { kind: "other", text };
}
function failureTargetText(target: FailureTarget | null): string {
  if (!target) return "当前所选文件";
  const where = target.relativeUri ? `（${target.relativeUri}｜ID ${target.noteId}）` : `（ID ${target.noteId}）`;
  return `${target.title || "所选文件"}${where}`;
}
/** 三类失败各自给出可检查的身份与出路；任何一类都不表示已改用其它文件或已清草稿。 */
function failureText(failure: ReaderFailure, target: FailureTarget | null): string {
  const identity = failureTargetText(target);
  const detail = failure.text ? `；后端说明：${failure.text}` : "";
  if (failure.kind === "missing") return `所选文件不存在：${identity}。未切换到其它文件，也未清除草稿；可刷新目录重新核对。${detail}`;
  if (failure.kind === "identity") return `知识索引身份不一致：${identity}。为避免读错文件，未自动改用其它文件；草稿保留，请刷新目录后重试。${detail}`;
  if (failure.kind === "source") return `知识库源不可用：${identity} 与草稿均保留，未改用其它文件。请检查知识库目录或启用状态后重新扫描。${detail}`;
  return `读取失败：${failure.text || "未提供原因"}`;
}

export function Reader(props: { libId: string; noteId?: string; visible?: boolean }) {
  return <ReaderView key={props.libId} libId={props.libId} initialNoteId={props.noteId} visible={props.visible ?? true} />;
}

function ReaderView({ libId, initialNoteId, visible }: { libId: string; initialNoteId?: string; visible: boolean }) {
  const { go } = useApp();
  const session = useMemo(() => knowledgeSession(libId), [libId]);
  const [revision, setRevision] = useState(0);
  const [library, setLibrary] = useState<KnowledgeLibrary | null>(null);
  const [libraries, setLibraries] = useState<KnowledgeLibrary[]>([]);
  const [docPanel, setDocPanel] = useState<"doc" | "setting" | "recycle">("doc");
  const [recycleItems, setRecycleItems] = useState<api.KnowledgeRecycleItem[]>([]);
  const [spaceName, setSpaceName] = useState("");
  const [spaceExplain, setSpaceExplain] = useState("");
  const [migrate, setMigrate] = useState<KnowledgeEntry | null>(null);
  const [tree, setTree] = useState<NoteNode[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const updateToc = useCallback((entries: TocEntry[]) => setToc(entries), []);
  const directoryHandle = useRef<KnowledgeTreeHandle>(null);
  type KnownNode = NoteNode & { sourceRevision?: string; parentUri?: string; external?: boolean };
  const knownEntries = useRef(new Map<string, KnownNode>());
  const [coverage, setCoverage] = useState<KnowledgeSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchEpoch, setSearchEpoch] = useState(0);
  const indexPublished = useCallback(() => setSearchEpoch(value => value + 1), []);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [refOpen, setRefOpen] = useState(false);
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"discard" | "latest" | "reload-original" | null>(null);
  /** v1.4：notice 条的动作按钮只由模型决定；close 或动作完成后清除，不在组件里另造一套状态源。 */
  const [noticeAction, setNoticeAction] = useState<ReaderNoticeAction | null>(null);
  /** v1.4：所选文件已不存在时只给刷新入口，不跳转、不清草稿。 */
  const [selectionGone, setSelectionGone] = useState(false);
  /** CR-068 K02：区分源失效／索引身份／文件缺失；只有 missing 才显示「刷新目录」出路。 */
  const [noteErrorKind, setNoteErrorKind] = useState<ReaderFailureKind | null>(null);
  /** 定位失败时目录可能已经丢弃该节点，仍用最后确认的稳定 ID 与路径说明身份。 */
  const lastSelected = useRef<FailureTarget | null>(null);
  const pendingEdit = useRef<string | null>(null);
  const [namePrompt, setNamePrompt] = useState<{ title: string; label: string; value: string; error: string; run: (value: string) => Promise<string> } | null>(null);
  const [imageZoom, setImageZoom] = useState(false);
  const [imageError, setImageError] = useState(false);
  /** CR-084：PDF／Office 只读预览的当前页与总页数；只在真实预览就绪后出现。 */
  const [previewNav, setPreviewNav] = useState<PreviewNavigation | null>(null);
  const [previewPage, setPreviewPage] = useState<number | undefined>(undefined);
  /** CR-088：双链索引状态；链接只用于阅读导航，不扩大 AI 可读范围。 */
  const [linkTab, setLinkTab] = useState<'outline' | 'backlinks' | 'unresolved' | 'graph'>('outline');
  const [graphFocus, setGraphFocus] = useState<string | null>(null);
  const [outLinks, setOutLinks] = useState<OutLink[]>([]);
  const [backlinkRows, setBacklinkRows] = useState<Backlink[]>([]);
  const [linkCandidates, setLinkCandidates] = useState<LinkCandidate[] | null>(null);
  /** refreshParent 在下方才定义，用 ref 承接避免前置引用。 */
  const refreshParentRef = useRef<(uri: string) => void>(() => undefined);
  const mounted = useRef(false);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const requestSeq = useRef(0);
  const treeSeq = useRef(0);
  const scanBusy = useRef(false);
  const uploadBusy = useRef(false);
  const exportBusy = useRef(false);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<HTMLElement | null>(null);
  const tocRef = useRef<HTMLElement | null>(null);
  const inlineWidth = (element: HTMLElement | null) => element && !element.hidden && !element.classList.contains("pane-overlay") ? element.offsetWidth : 0;
  // Give the tree first claim; only TOC reserves the measured inline tree width.
  // Mutual neighbour reserves oscillate when both panes approach their minimums.
  const treePane = usePaneWidth(`knowledge:${libId}`, "tree", { default: 260, min: 180, max: 480, side: "left", containerRef: workspaceRef, reserve: 0, minCenter: 320, disabled: !visible });
  const tocPane = usePaneWidth(`knowledge:${libId}`, "toc", { default: 220, min: 160, max: 360, side: "right", containerRef: workspaceRef, reserve: () => inlineWidth(treeRef.current), minCenter: 320, disabled: !visible });
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const refresh = useCallback(() => { if (mounted.current) setRevision(value => value + 1); }, []);
  const current = session.current;
  const draft = current ? session.drafts.get(current) : undefined;
  const data = current ? getKnowledgeFile(session, draft?.noteId ?? current) : undefined;
  const info = data?.info;
  const selected = current ? knownEntries.current.get(draft?.noteId ?? current) ?? null : null;
  const selectedRevision = (selected as (NoteNode & { sourceRevision?: string }) | null)?.sourceRevision;
  const title = draft?.title || info?.title || selected?.title || session.selectedFolder || "知识工作区";
  const uri = info?.relativeUri ?? selected?.relativeUri;
  const type = fileType(uri ?? (draft ? markdownName(draft.title) : ""));
  const body = draft?.body ?? data?.text;
  const md = !!draft || (!!info && info.kind === "markdown" && isMarkdown(info.relativeUri) && typeof body === "string");
  const paged = !!info && isPagedDocument(info);
  useEffect(() => { setPreviewNav(null); setPreviewPage(undefined); }, [info?.noteId, info?.relativeUri]);
  useEffect(() => { setLinkTab('outline'); setOutLinks([]); setBacklinkRows([]); setLinkCandidates(null); }, [info?.noteId]);
  useEffect(() => {
    if (!md || !info?.noteId || !visible) return;
    let alive = true;
    const load = async (allowRebuild: boolean) => {
      try {
        const outgoing = await linksApi.kbLinksOutgoing(libId, info.noteId);
        if (!alive) return;
        if (!outgoing.length && allowRebuild && (body ?? '').includes('[[')) {
          await linksApi.kbLinksRebuild(libId).catch(() => 0);
          return load(false);
        }
        setOutLinks(outgoing);
        const back = await linksApi.kbLinksBacklinks(libId, info.noteId).catch(() => [] as Backlink[]);
        if (alive) setBacklinkRows(back);
      } catch { if (alive) { setOutLinks([]); setBacklinkRows([]); } }
    };
    void load(true);
    return () => { alive = false; };
  }, [md, info?.noteId, libId, visible, body]);

  const openDocumentLink = useCallback((link: { name: string; heading: string | null; state: string; targetPath: string | null; targetNoteId: string | null }) => {
    if (link.state === 'resolved' && link.targetNoteId) {
      const target = link.targetPath ?? '';
      const title = (target.split('/').pop() ?? link.name).replace(/\.md$/i, '');
      const node: NoteNode = { noteId: link.targetNoteId, title, relativeUri: target, isDir: false, children: [] };
      setNoteError(null); void loadFile(node); return;
    }
    if (link.state === 'ambiguous') {
      linksApi.kbLinksResolve(libId, link.name, info?.relativeUri ?? '')
        .then(result => setLinkCandidates(result.candidates))
        .catch(error => { session.notice = errorText(error); refresh(); });
      return;
    }
    const baseDir = info?.relativeUri.includes('/') ? info.relativeUri.slice(0, info.relativeUri.lastIndexOf('/')) : '';
    const parts = link.name.split('/').filter(Boolean);
    const fileName = parts.pop() ?? link.name;
    const parent = [baseDir, ...parts].filter(Boolean).join('/');
    if (!window.confirm(`目标《${link.name}》还不存在，现在按该路径新建吗？`)) return;
    api.kbCreateMarkdown(libId, parent, fileName, '')
      .then(node => { if (session.current === info?.noteId) session.current = node.noteId; session.notice = `已新建：${node.title}`; refreshParentRef.current(node.relativeUri); void directoryHandle.current?.refresh(parent); refresh(); })
      .catch(error => { session.notice = errorText(error); refresh(); });
  }, [libId, info?.relativeUri, info?.noteId, session, refresh]);
  const ownerDisabled = library !== null && !library.enabled;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestSeq.current += 1; treeSeq.current += 1; };
  }, []);

  // R02: the mounted document reports its conservative DOM retention to the shared ledger.
  const reportRetention = useCallback((info: { blocks: number; nodes: number; htmlChars: number } | null) => {
    const previousPressure = session.cachePressure;
    recordKnowledgeDocumentRetention(session, current ?? 'empty', info);
    // The ledger is updated on every batch; only a pressure change needs a full re-render.
    if (session.cachePressure !== previousPressure) refresh();
  }, [session, current, refresh]);

  const loadFile = useCallback(async (node: NoteNode) => {
    if (!visibleRef.current) return;
    const seq = ++requestSeq.current;
    lastSelected.current = { noteId: node.noteId, relativeUri: node.relativeUri, title: node.title };
    setNoteError(null); setNoteErrorKind(null); setNoteLoading(true); setSelectionGone(false);
    try {
      const metadata = await api.kbFileInfo(libId, node.noteId);
      if (seq !== requestSeq.current || !mounted.current || !visibleRef.current) return;
      checkFileIdentity(metadata, node);
      let result: KnowledgeFileData = { info: metadata };
      if (readableKind(metadata) && !(['markdown', 'text'].includes(metadata.kind) && metadata.sizeBytes > 1024 * 1024 && !metadata.editable)) {
        // Conservative: base64/JS retention can be ~8/3 of raw bytes; 2.75x avoids admitting a file
        // only to have its real weight evicted immediately after reading.
        const estimated = Math.max(1024, Math.ceil(metadata.sizeBytes * 11 / 4));
        if (!canAdmitKnowledgeFile(session, node.noteId, estimated)) {
          session.cachePressure = true;
          session.notice = CACHE_PRESSURE_NOTICE;
          setNoticeAction(null);
          throw new Error('CACHE_BUDGET: 阅读缓存预算不足，未载入新的正文');
        }
        result = await api.kbReadFile(libId, node.noteId);
        if (seq !== requestSeq.current || !mounted.current || !visibleRef.current) return;
        checkFileIdentity(result.info, node);
        if (result.info.kind !== metadata.kind || !readableKind(result.info)) throw new Error("读取期间文件类型已改变，请重试");
        if (["markdown", "text"].includes(result.info.kind) && typeof result.text !== "string") throw new Error("接口未返回文本正文，不使用空字符串替代");
        if (result.info.kind === "image") safeImageSource(result.info, result.base64);
      }
      if (seq !== requestSeq.current || !mounted.current || !visibleRef.current) return;
      cacheKnowledgeFile(session, node.noteId, result);
      // Non-Markdown text preview also keeps a DOM estimate; MarkdownContent reports a finer one.
      if (result.info.kind === "text" && typeof result.text === "string") recordKnowledgeDocumentRetention(session, node.noteId, { blocks: 1, nodes: 2, htmlChars: result.text.length });
      refresh();
    } catch (error) {
      if (seq === requestSeq.current && mounted.current && visibleRef.current) {
        const failure = classifyReaderFailure(error);
        setNoteErrorKind(failure.kind);
        setSelectionGone(failure.kind === "missing");
        setNoteError(failureText(failure, lastSelected.current));
      }
    } finally {
      if (seq === requestSeq.current && mounted.current && visibleRef.current) setNoteLoading(false);
    }
  }, [libId, refresh, session]);

  const acceptEntries = useCallback((parentId: string, entries: KnowledgeEntry[], complete: boolean) => {
    const parentUri = parentId ? session.directory.entries.get(parentId)?.relativeUri ?? '' : '';
    const keep = new Set<string>();
    for (const item of session.drafts.values()) { keep.add(item.key); if (item.noteId) keep.add(item.noteId); }
    const updates = entries.map(entry => ({ noteId: entry.noteId, title: entry.title, relativeUri: entry.relativeUri, isDir: entry.isDir, children: [], sourceRevision: entry.sourceRevision } as KnownNode));
    reconcileKnownEntries(knownEntries.current, { parentUri, entries: updates, complete }, {
      keep, reachable: reachableNoteIds(session.directory.entries.values()), rootComplete: parentId === '' && complete,
    });
    // A draft learns the source revision only after the directory reports it. Never overwrite a
    // revision the reappearance check is already comparing.
    for (const entry of updates) {
      const revision = entry.sourceRevision ?? null;
      for (const item of session.drafts.values()) if (item.noteId === entry.noteId && item.sourceRevision == null) item.sourceRevision = revision;
    }
    setTree([...knownEntries.current.values()]); setTreeError(null);
    if (!session.current) session.current = initialNoteId || entries.find(entry => !entry.isDir)?.noteId || null;
    refresh();
  }, [initialNoteId, session, refresh]);
  const loadTree = useCallback(async () => {
    await directoryHandle.current?.refresh(session.selectedFolder);
  }, [session]);
  /**
   * v1.4 selection-gone：复用 PagedKnowledgeTree 的 refreshTree（refresh 句柄）与既有目录页状态，
   * 不另建目录状态源；刷新后仍定位不到就继续提示，找到就正常载入，不跳其它文件、不清草稿。
   */
  const refreshDirectory = async () => {
    setSelectionGone(false);
    setNoteErrorKind(null);
    if (query.trim()) {
      // 检索态下文件树未挂载，没有可调用的刷新句柄；先回到目录树再刷新。
      setQuery("");
      await new Promise<void>(resolve => { window.setTimeout(resolve, 0); });
    }
    await loadTree();
    try { await api.kbScan(libId); } catch (error) { session.notice = `目录已刷新，索引未更新：${errorText(error)}`; }
    const id = current ? session.drafts.get(current)?.noteId ?? current : null;
    const node = id ? rememberListed(id) : null;
    if (node && !node.isDir) { setNoteError(null); void loadFile(node); return; }
    // 刷新后仍不在已加载页里，不能当成缺失。子目录文件要先按稳定 ID 向后端解析。
    if (id) { void resolveUnlisted(id); return; }
    refresh();
  };
  // UI-CR055-FEAT009-v1.3：原件传输任务按「库 + 当前文件」作用域登记，切库/切文件即停止轮询与计时器。
  const transfer = useKnowledgeTransfer({
    libraryId: libId,
    visible,
    scopeKey: `${libId}:${current ?? ""}`,
    disabled: ownerDisabled,
    onImported: () => { void loadTree(); },
  });
  const exportTarget = draft?.noteId ?? selected?.noteId ?? info?.noteId ?? null;
  const largeExport = (info?.sizeBytes ?? 0) >= TRANSFER_LARGE_FILE;
  const exportOriginal = () => {
    if (!exportTarget) return;
    // 大文件走带进度、可取消的传输任务；小文件沿用保存对话框直接写出。
    if (largeExport) void transfer.startExport(exportTarget);
    else void exportFile();
  };
  useEffect(() => {
    session.visible = visible;
    if (!visible) clearKnowledgeDocumentRetention(session);
    trimKnowledgeCache(session);
    if (!visible) { requestSeq.current += 1; setNoteLoading(false); setFolderMenu(null); setConfirm(null); return; }
    let alive = true;
    api.kbList().then(rows => { if (alive && mounted.current && visibleRef.current) { setLibraries(rows); const current = rows.find(item => item.id === libId) ?? null; setLibrary(current); setSpaceName(current?.name ?? ""); setSpaceExplain(current?.description ?? ""); } }).catch(error => { if (alive && mounted.current && visibleRef.current) { session.notice = '知识库元信息加载失败：' + errorText(error); refresh(); } });
    // 深链只带回稳定 ID。不要在这里抢先判缺失；阅读效果负责向后端解析并载入。
    if (!session.current && initialNoteId) { session.current = initialNoteId; refresh(); }
    return () => { alive = false; session.visible = false; trimKnowledgeCache(session); treeSeq.current += 1; requestSeq.current += 1; };
  }, [libId, visible, initialNoteId, refresh, session]);

  /**
   * 目录树用分页 id 索引，阅读用稳定 noteId。文件已出现在已加载目录页时，不能因为
   * knownEntries 还没对上 noteId 就当成文件不存在。
   */
  const rememberListed = useCallback((id: string): KnownNode | null => {
    const existing = knownEntries.current.get(id);
    if (existing) return existing;
    for (const entry of session.directory.entries.values()) {
      if (entry.noteId !== id || entry.isDir) continue;
      const recovered: KnownNode = { noteId: entry.noteId, title: entry.title, relativeUri: entry.relativeUri, isDir: false, children: [], sourceRevision: entry.sourceRevision };
      knownEntries.current.set(id, recovered);
      return recovered;
    }
    return null;
  }, [session]);

  /**
   * 已加载目录页没有这个稳定 ID，不等于文件不存在。子目录页还没展开时，
   * 先向后端解析；只有后端确认缺失才显示「不存在」，并带上后端说明。
   */
  const resolveUnlisted = useCallback(async (noteId: string) => {
    const listed = rememberListed(noteId);
    if (listed && !listed.isDir) {
      lastSelected.current = { noteId: listed.noteId, relativeUri: listed.relativeUri, title: listed.title };
      await loadFile(listed);
      return;
    }
    const seq = ++requestSeq.current;
    if (!lastSelected.current || lastSelected.current.noteId !== noteId) lastSelected.current = { noteId };
    setNoteError(null); setNoteErrorKind(null); setSelectionGone(false); setNoteLoading(true);
    try {
      const metadata = await api.kbFileInfo(libId, noteId);
      if (seq !== requestSeq.current || !mounted.current || !visibleRef.current) return;
      if (session.current && session.current !== noteId && session.current !== metadata.noteId) return;
      const node: KnownNode = { noteId: metadata.noteId, title: metadata.title, relativeUri: metadata.relativeUri, isDir: false, children: [], external: true };
      knownEntries.current.set(metadata.noteId, node);
      lastSelected.current = { noteId: metadata.noteId, title: metadata.title, relativeUri: metadata.relativeUri };
      session.current = metadata.noteId;
      setTree([...knownEntries.current.values()]);
      await loadFile(node);
    } catch (error) {
      if (seq !== requestSeq.current || !mounted.current || !visibleRef.current) return;
      const failure = classifyReaderFailure(error);
      setNoteLoading(false);
      if (unlistedSelectionAction({ listed: false, backendConfirmedMissing: failure.kind === "missing" }) === "missing") {
        setSelectionGone(true); setNoteErrorKind("missing");
        setNoteError(failureText(failure, lastSelected.current));
        setNoticeAction(null);
        return;
      }
      setSelectionGone(false);
      setNoteErrorKind(failure.kind);
      setNoteError(failureText(failure, lastSelected.current));
    }
  }, [libId, loadFile, rememberListed, session]);

  // R03: a changed directory revision invalidates a clean body; a dirty draft is kept with an
  // explicit notice instead of being silently replaced or saved over the new original.
  useEffect(() => {
    if (!visible || !current) return;
    const activeDraft = session.drafts.get(current);
    const action = sourceRevisionDecision(activeDraft, selectedRevision);
    const node = rememberListed(activeDraft?.noteId ?? current);
    if (action === 'drop-clean-draft' && activeDraft) {
      const noteId = activeDraft.noteId ?? current;
      session.drafts.delete(current); session.notice = "原件已在外部变化；未保存修改的草稿已释放，正在重新读取原件。"; setNoticeAction(null);
      const fresh = knownEntries.current.get(noteId) ?? node;
      if (fresh && !fresh.isDir) void loadFile(fresh);
      refresh();
      return () => { requestSeq.current += 1; };
    }
    if (action === 'warn-dirty' && activeDraft) {
      // v1.4：dirty 草稿绝不被静默替换，提示条给出「放弃草稿并重新读取」，必须二次确认才释放。
      const change = externalChangeNotice(activeDraft, selectedRevision);
      activeDraft.sourceRevision = selectedRevision ?? null;
      session.notice = change?.text ?? "原件已在外部变化，当前未保存草稿保留；保存时会提示版本冲突。";
      setNoticeAction(change?.action ?? null);
      setSelectionGone(false);
      refresh();
      return () => { requestSeq.current += 1; };
    }
    if (session.drafts.has(current)) return () => { requestSeq.current += 1; };
    // 根目录先载入时，子目录里的文件还不在已加载页。不能因此空说明报「不存在」。
    const decision = unlistedSelectionAction({ listed: !!(node && !node.isDir), backendConfirmedMissing: false });
    if (decision === "load" && node) void loadFile(node);
    else if (decision === "resolve") void resolveUnlisted(activeDraft?.noteId ?? current);
    return () => { requestSeq.current += 1; };
  }, [current, visible, loadFile, tree === null, treeError, selectedRevision, session, refresh, rememberListed, resolveUnlisted]);

  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = current ? session.scroll.get(current) ?? 0 : 0;
    setImageZoom(false); setImageError(false); setConfirm(null);
  }, [current, session]);

  useEffect(() => {
    let alive = true, started = false;
    const requestId = crypto.randomUUID();
    setHits(null); setCoverage(null); setSearchError(null); setSearching(false);
    if (!query.trim() || !visible) return;
    setSearching(true);
    const timer = window.setTimeout(() => {
      started = true;
      performanceApi.searchIndexed(libId, query.trim(), requestId).then(result => {
        if (!alive) return;
        setCoverage(result); setHits(result.hits.filter(hit => hit.libraryId === libId));
      }).catch(error => { if (alive) setSearchError(errorText(error)); }).finally(() => { if (alive) setSearching(false); });
    }, 300);
    return () => { alive = false; window.clearTimeout(timer); if (started) void performanceApi.cancelSearch(libId, requestId).catch(() => {}); };
  }, [libId, query, visible, searchEpoch]);

  useEffect(() => {
    if (folderMenu === null || !visible) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setFolderMenu(null); };
    document.addEventListener("pointerdown", outside);
    menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [folderMenu, visible]);

  const select = (key: string) => {
    if (key === session.current) {
      setFolderMenu(null);
      if (treePane.overlay) treePane.setVisible(false);
      if (tocPane.overlay) tocPane.setVisible(false);
      // 自动选中后若被误判缺失，再点同一行要重新打开，不能因为 current 没变就直接返回。
      if (noteError || selectionGone) {
        const id = session.drafts.get(key)?.noteId ?? key;
        const again = rememberListed(id);
        if (again && !again.isDir) {
          lastSelected.current = { noteId: again.noteId, relativeUri: again.relativeUri, title: again.title };
          setNoteError(null); setNoteErrorKind(null); setSelectionGone(false); setNoteLoading(true);
          void loadFile(again);
        } else void resolveUnlisted(id);
      }
      return;
    }
    if (mainRef.current && current) session.scroll.set(current, mainRef.current.scrollTop);
    requestSeq.current += 1; setNoteError(null); setNoteErrorKind(null); setToc([]); setNoteLoading(!session.drafts.has(key)); setSelectionGone(false);
    clearKnowledgeDocumentRetention(session);
    session.current = key; trimKnowledgeCache(session);
    const node = findNode(tree ?? [], session.drafts.get(key)?.noteId ?? key) ?? rememberListed(session.drafts.get(key)?.noteId ?? key);
    if (node) { lastSelected.current = { noteId: node.noteId, relativeUri: node.relativeUri, title: node.title }; session.selectedFolder = parentOf(node.relativeUri); expandParents(session, tree ?? [], node.noteId); }
    if (treePane.overlay) treePane.setVisible(false);
    if (tocPane.overlay) tocPane.setVisible(false);
    setFolderMenu(null); refresh();
  };
  const newMarkdown = (parent: string) => {
    if (ownerDisabled) return;
    const key = nextDraftKey();
    session.drafts.set(key, { editorKey: key, key, noteId: null, parent, title: "", body: "", baseTitle: "", baseBody: "", expectedHash: null, mode: "edit", saving: false, error: "", conflict: false });
    session.notice = "新文档仅在主区与草稿栏，首次保存成功才进入文件树；切换库或文件会保留当前草稿。";
    select(key);
  };
  const setMode = (mode: "read" | "edit") => {
    if (draft) { draft.mode = mode; refresh(); return; }
    if (mode !== "edit" || !current || !info || !info.editable || !isMarkdown(info.relativeUri) || typeof data?.text !== "string" || !info.hash || noteLoading || noteError) return;
    session.drafts.set(current, { editorKey: current, key: current, noteId: current, parent: parentOf(info.relativeUri), title: info.title, body: data.text, baseTitle: info.title, baseBody: data.text, expectedHash: info.hash, sourceRevision: selectedRevision ?? null, mode: "edit", saving: false, error: "", conflict: false });
    refresh();
  };
  const saveDraft = async () => {
    const editing = session.current ? session.drafts.get(session.current) : undefined;
    if (!editing || editing.saving || ownerDisabled || !visibleRef.current) return;
    const name = markdownName(editing.title);
    editing.error = !editing.noteId ? nameError(editing.title) || nameError(name) : "";
    if (!editing.error && !editing.noteId && pathTaken(tree ?? [], editing.parent, name)) editing.error = "同一目录已有这个名称；不会覆盖，当前输入已保留。";
    if (!editing.error && editing.noteId && !editing.expectedHash) editing.error = "未取得可校验的原件 hash，不能覆盖保存；当前草稿已保留。";
    if (!editing.error && editing.conflict) editing.error = "版本冲突尚未解决，不能静默覆盖；当前草稿已保留。";
    if (editing.error) { refresh(); return; }
    const submitted = { key: editing.key, noteId: editing.noteId, title: editing.title, body: editing.body, hash: editing.expectedHash, parent: editing.parent };
    editing.saving = true; refresh();
    try {
      const result = submitted.noteId ? await api.kbSaveMarkdown(libId, submitted.noteId, submitted.hash!, submitted.body) : await api.kbCreateMarkdown(libId, submitted.parent, name, submitted.body);
      const expectedUri = submitted.noteId ? session.files.get(submitted.noteId)?.info.relativeUri : submitted.parent ? `${submitted.parent}/${name}` : name;
      if (!result.noteId || !isMarkdown(result.relativeUri) || typeof result.content !== "string" || (submitted.noteId && result.noteId !== submitted.noteId) || (expectedUri && result.relativeUri.replace(/\\/g, "/") !== expectedUri.replace(/\\/g, "/"))) throw new Error("保存返回的文件身份不一致，请核对原件；草稿保留");
      const oldInfo = session.files.get(result.noteId)?.info;
      const savedInfo: KnowledgeFileInfo = { ...oldInfo, noteId: result.noteId, title: result.title, relativeUri: result.relativeUri, sizeBytes: new TextEncoder().encode(result.content).length, kind: "markdown", mime: "text/markdown", previewSupported: true, editable: true, hash: result.hash };
      cacheKnowledgeFile(session, result.noteId, { info: savedInfo, text: result.content });
      const changedDuringSave = acceptSavedMarkdown(editing, submitted, result);
      session.drafts.delete(submitted.key);
      session.drafts.set(result.noteId, editing);
      if (!result.hash) editing.error = "正文已保存，但接口未返回 hash。缓冲仍保留；取得最新版本前不能再次覆盖。";
      if (session.current === submitted.key) session.current = result.noteId;
      session.notice = result.indexError ? `原件已保存，但索引失败：${result.indexError}。不重试创建、不覆盖原件；请重新扫描索引。` : changedDuringSave ? "提交时的正文已保存；保存过程中继续输入的内容保留为未保存草稿。" : "已保存本机 Markdown 原件。";
      refresh();
      // Refresh the saved file's parent page so its entry (and source revision) reaches the tree.
      if (visibleRef.current && mounted.current) void directoryHandle.current?.refresh(submitted.parent);
    } catch (error) {
      editing.error = `保存失败：${errorText(error)}。原文不被本界面替换，当前草稿已保留。`;
      if (submitted.noteId && isConflict(error)) {
        editing.conflict = true; editing.latest = undefined; editing.latestError = undefined;
        if (mounted.current && visibleRef.current) {
          try {
            const latest = await api.kbReadFile(libId, submitted.noteId);
            if (latest.info.noteId !== submitted.noteId || latest.info.kind !== "markdown" || typeof latest.text !== "string") throw new Error("最新版本身份或正文不一致");
            editing.latest = latest;
          } catch (latestError) { editing.latestError = errorText(latestError); }
        } else editing.latestError = "页面已隐藏；草稿及冲突保留，未继续读取最新原文。";
      }
    } finally { editing.saving = false; refresh(); }
  };
  const discardDraft = async (latest: boolean) => {
    if (!draft || draft.saving || !visibleRef.current) return;
    const discarded = { key: draft.key, title: draft.title, body: draft.body };
    if (latest && draft.noteId) {
      const seq = ++requestSeq.current;
      try {
        const result = await api.kbReadFile(libId, draft.noteId);
        if (result.info.noteId !== draft.noteId || result.info.kind !== "markdown" || typeof result.text !== "string") throw new Error("最新原文不可读或身份不一致");
        if (seq !== requestSeq.current || !mounted.current || !visibleRef.current || session.current !== discarded.key || session.drafts.get(discarded.key) !== draft) return;
        if (draft.body !== discarded.body || draft.title !== discarded.title) { draft.error = "读取最新原文期间又有输入，未放弃新增草稿；请重新确认。"; setConfirm(null); refresh(); return; }
        cacheKnowledgeFile(session, draft.noteId, result);
      } catch (error) { draft.error = `最新原文读取失败，草稿仍保留：${errorText(error)}`; if (mounted.current && visibleRef.current && session.current === discarded.key) setConfirm(null); refresh(); return; }
    }
    session.drafts.delete(draft.key);
    session.current = draft.noteId ?? flattenTree(tree ?? []).find(node => !node.isDir)?.noteId ?? null;
    session.notice = "已取消编辑，未修改已保存原文和文件树。";
    setConfirm(null); setNoteError(null); refresh();
  };
  /**
   * v1.4 reload-original：二次确认后释放该文档草稿并从原件重新读取。
   * 只有草稿内容仍与确认时的快照一致才释放；读取失败、身份不一致或期间又编辑过都保留草稿。
   */
  const reloadOriginal = async () => {
    const target = current ? session.drafts.get(current) : undefined;
    setConfirm(null);
    if (!target || target.saving || !visibleRef.current) return;
    const snapshot = { key: target.key, title: target.title, body: target.body };
    const noteId = target.noteId;
    if (!noteId) { target.error = "未落盘草稿没有原件可重新读取；草稿已保留。"; refresh(); return; }
    const seq = ++requestSeq.current;
    try {
      const result = await api.kbReadFile(libId, noteId);
      if (result.info.noteId !== noteId || !readableKind(result.info) || typeof result.text !== "string") throw new Error("原件身份或正文不一致");
      if (seq !== requestSeq.current || !mounted.current || !visibleRef.current || session.current !== snapshot.key || session.drafts.get(snapshot.key) !== target) return;
      if (!draftReleaseConfirmed(snapshot, target)) { target.error = "读取原件期间又有输入，未放弃草稿；草稿已保留，请重新确认。"; refresh(); return; }
      cacheKnowledgeFile(session, noteId, result);
      session.drafts.delete(snapshot.key);
      session.notice = ""; setNoticeAction(null); setSelectionGone(false); setNoteError(null); setNoteErrorKind(null);
      refresh();
    } catch (error) {
      const failure = classifyReaderFailure(error);
      target.error = `原件重新读取失败，草稿仍保留：${failureText(failure, { noteId, title: snapshot.title })}`;
      if (mounted.current && visibleRef.current) refresh();
    }
  };
  const createFolder = (parent: string) => {
    if (ownerDisabled || session.folderInput?.saving) return;
    session.folderInput = { key: nextDraftKey(), parent, name: "", error: "", saving: false };
    const node = flattenTree(tree ?? []).find(node => node.isDir && node.relativeUri === parent);
    if (node) session.collapsed.delete(node.noteId);
    setQuery(""); setFolderMenu(null); refresh();
  };
  const submitFolder = async () => {
    const input = session.folderInput;
    if (!input || input.saving || ownerDisabled) return;
    input.error = nameError(input.name) || (pathTaken(tree ?? [], input.parent, input.name) ? "同一目录已有这个名称，输入已保留。" : "");
    if (input.error) { refresh(); return; }
    input.saving = true; refresh();
    try {
      const node = await api.kbCreateFolder(libId, input.parent, input.name);
      if (!node.isDir) throw new Error("接口没有返回真实目录节点");
      const parentUri = input.parent;
      if (session.folderInput === input) session.folderInput = null;
      session.selectedFolder = node.relativeUri;
      session.collapsed.delete(node.noteId);
      // R03: refresh the parent page, not the new empty folder, so a nested folder appears even when
      // its parent is not on the currently loaded page.
      const parentNode = [...knownEntries.current.values()].find(item => item.isDir && item.relativeUri.replace(/\\/g, '/') === parentUri.replace(/\\/g, '/'));
      if (parentNode) session.collapsed.delete(parentNode.noteId);
      session.notice = `已创建文件夹：${node.relativeUri}`; refresh();
      if (mounted.current && visibleRef.current) void directoryHandle.current?.refresh(parentUri);
    } catch (error) { input.error = `创建失败：${errorText(error)}；输入已保留。`; }
    finally { input.saving = false; refresh(); }
  };
  const upload = async (parent = session.selectedFolder) => {
    if (uploadBusy.current || ownerDisabled || !visibleRef.current) return;
    uploadBusy.current = true; setUploading(true);
    try {
      const result = await api.kbUploadFiles(libId, parent);
      session.notice = result.cancelled ? "已取消本机文件选择，没有上传文件。" : result.items.map(item => item.success ? `${item.name}：已上传${item.indexError ? `，索引失败：${item.indexError}` : ""}` : `${item.name}：上传失败，${item.error ?? "未提供原因"}`).join("；") || "没有上传文件。";
      if (!result.cancelled && result.items.some(item => item.success) && mounted.current && visibleRef.current) { void loadTree(); void directoryHandle.current?.refresh(parent); }
    } catch (error) { session.notice = `上传失败：${errorText(error)}；没有使用演示文件替代真实文件选择。`; }
    finally { uploadBusy.current = false; if (mounted.current) setUploading(false); refresh(); }
  };
  const exportFile = async () => {
    const noteId = draft?.noteId ?? selected?.noteId ?? info?.noteId;
    if (!noteId || exportBusy.current || ownerDisabled) return;
    exportBusy.current = true; setExporting(true);
    try { const result = await api.kbExportFile(libId, noteId); session.notice = result.cancelled ? "已取消导出，未写入目标文件。" : result.exported ? "已通过本机保存对话框导出原件。未保存的编辑草稿不在导出内容中。" : "接口未确认原件导出成功。"; }
    catch (error) { session.notice = `导出失败：${errorText(error)}`; }
    finally { exportBusy.current = false; if (mounted.current) setExporting(false); refresh(); }
  };


  const jumpToHeading = (id: string) => { if (draft) { draft.mode = "read"; refresh(); } requestAnimationFrame(() => { Array.from(mainRef.current?.querySelectorAll<HTMLElement>("[id]") ?? []).find(element => element.id === id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }); if (tocPane.overlay) tocPane.setVisible(false); };
  const folderEditor = (parent: string, depth: number) => {
    const input = session.folderInput;
    if (!input || input.parent !== parent) return null;
    return <div className="kw-folder-editor" style={depthStyle(depth)}><FileGlyph type="" folder /><div><input key={input.key} autoFocus className="input" aria-label="新文件夹名称" aria-invalid={!!input.error} aria-describedby="kw-folder-help" placeholder="文件夹名" disabled={input.saving} value={input.name} onChange={event => { input.name = event.target.value; refresh(); }} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); void submitFolder(); } if (event.key === "Escape" && !input.saving) { event.stopPropagation(); session.folderInput = null; refresh(); } }} /><small id="kw-folder-help" className={input.error ? "kw-error-text" : ""}>{input.error || (input.saving ? "创建中…" : "Enter 确认 · Escape 取消")}</small></div><button className="icon-btn" disabled={input.saving} aria-label="取消新建文件夹" onClick={() => { session.folderInput = null; refresh(); }}><Icon name="x" size={14} /></button></div>;
  };
  const treeActions = useRef({ select, createFolder, newMarkdown });
  treeActions.current = { select, createFolder, newMarkdown };
  const treeOpen = useCallback((entry: KnowledgeEntry) => treeActions.current.select(entry.noteId), []);
  const treeNewFolder = useCallback((uri: string) => treeActions.current.createFolder(uri), []);
  const treeNewDocument = useCallback((uri: string) => treeActions.current.newMarkdown(uri), []);
  const treeFolder = useCallback((entry: KnowledgeEntry) => { session.selectedFolder = entry.relativeUri; refresh(); }, [session, refresh]);
  const refreshParent = (uri: string) => { void directoryHandle.current?.refresh(parentOf(uri)); };
  refreshParentRef.current = refreshParent;
  const createDoc = async (parent: string, kind: DocCreateKind) => {
    if (ownerDisabled) return;
    if (kind === "folder") {
      setNamePrompt({ title: "新建文件夹", label: "文件夹名称", value: "", error: "", run: async value => {
        if (!value.trim()) return "请输入文件夹名称";
        if (value.trim().length > 40) return "文件夹名称不能超过40个字符";
        await api.kbCreateFolder(libId, parent, value.trim());
        session.notice = "创建成功"; refreshParent(parent ? `${parent}/${value.trim()}` : value.trim()); refresh(); return "";
      } });
      return;
    }
    const name = kind === "html" ? "新建文档.html" : "新建文档.md";
    const content = kind === "html" ? "<p><br></p>" : "";
    try {
      const result = kind === "html" ? await api.kbCreateRichtext(libId, parent, name, content) : await api.kbCreateMarkdown(libId, parent, name, content);
      pendingEdit.current = result.noteId;
      knownEntries.current.set(result.noteId, { noteId: result.noteId, title: result.title, relativeUri: result.relativeUri, isDir: false, children: [] });
      session.current = result.noteId;
      session.notice = result.indexError ? `创建成功，索引未更新：${result.indexError}` : "创建成功";
      refreshParent(result.relativeUri); refresh();
    } catch (error) { session.notice = errorText(error); refresh(); }
  };
  const renameDoc = (entry: KnowledgeEntry) => {
    setNamePrompt({ title: "重命名", label: "文档名称", value: entry.title, error: "", run: async value => {
      const name = value.trim();
      if (!name) return "文档名称不能为空";
      if (name.length > 255) return "文档名称不能超过255个字符";
      if (name === entry.title) return "";
      const preview = await linksApi.kbLinksRenamePreview(libId, entry.relativeUri).catch(() => null);
      if (preview && preview.totalLinks > 0 && !window.confirm(`重命名后将更新 ${preview.affectedFiles.length} 个文件中的 ${preview.totalLinks} 处链接，继续吗？`)) return "已取消，链接未改动";
      const node = await api.kbRenameDoc(libId, entry.relativeUri, name);
      if (session.current === entry.noteId) { session.current = node.noteId; lastSelected.current = { noteId: node.noteId, title: node.title, relativeUri: node.relativeUri }; }
      session.notice = "重命名成功"; refreshParent(entry.relativeUri); refresh(); return "";
    } });
  };
  const deleteDoc = async (entry: { noteId: string; relativeUri: string }) => {
    if (!window.confirm("确定要删除此页面及其所有子页面吗？")) return;
    try {
      await api.kbRecycleDoc(libId, entry.relativeUri);
      if (session.current === entry.noteId) session.current = null;
      session.notice = "已删除"; refreshParent(entry.relativeUri); refresh();
    } catch (error) { session.notice = errorText(error); refresh(); }
  };
  const moveDoc = async (entry: KnowledgeEntry, parentUri: string) => {
    try {
      const node = await api.kbMoveDoc(libId, entry.relativeUri, parentUri);
      if (session.current === entry.noteId) { session.current = node.noteId; lastSelected.current = { noteId: node.noteId, title: node.title, relativeUri: node.relativeUri }; }
      session.notice = "已移动"; void directoryHandle.current?.refresh(""); refresh();
    } catch (error) { session.notice = errorText(error); refresh(); }
  };
  const importDocs = async (parent: string) => {
    try {
      const result = await api.kbImportDocs(libId, parent);
      session.notice = result.warnings[0] || (result.created.length ? "导入成功" : "没有导入文件");
      if (result.created.length) void directoryHandle.current?.refresh(parent);
      refresh();
    } catch (error) { session.notice = errorText(error); refresh(); }
  };
  const copyDoc = async (entry: KnowledgeEntry) => {
    try {
      const parent = entry.relativeUri.includes("/") ? entry.relativeUri.slice(0, entry.relativeUri.lastIndexOf("/")) : "";
      await api.kbCopyDoc(libId, entry.relativeUri, parent);
      session.notice = "复制成功"; void directoryHandle.current?.refresh(parent); refresh();
    } catch (error) { session.notice = errorText(error); refresh(); }
  };
  const loadRecycle = async () => {
    try { setRecycleItems(await api.kbRecycleList(libId)); }
    catch (error) { session.notice = errorText(error); refresh(); }
  };
  const uploadEditorMedia = async (file: File) => {
    const parent = info?.relativeUri.includes("/") ? info.relativeUri.slice(0, info.relativeUri.lastIndexOf("/")) : "";
    const data = await file.arrayBuffer();
    const bytes = new Uint8Array(data);
    let binary = "";
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    const relative = await api.kbWriteMedia(libId, parent, file.name, btoa(binary));
    void directoryHandle.current?.refresh(parent);
    return relative;
  };
  const saveZyDoc = async (name: string, content: string) => {
    if (!info?.hash) throw new Error("未取得可校验的原件 hash，不能覆盖保存");
    let noteId = info.noteId;
    let rel = info.relativeUri;
    if (name !== info.title) {
      const renamed = await api.kbRenameDoc(libId, rel, name);
      noteId = renamed.noteId; rel = renamed.relativeUri; session.current = renamed.noteId;
      lastSelected.current = { noteId: renamed.noteId, title: renamed.title, relativeUri: renamed.relativeUri };
    }
    const saved = /\.html?$/i.test(rel) ? await api.kbSaveRichtext(libId, noteId, info.hash, content) : await api.kbSaveMarkdown(libId, noteId, info.hash, content);
    const savedInfo: KnowledgeFileInfo = { ...info, noteId: saved.noteId, title: saved.title, relativeUri: saved.relativeUri, hash: saved.hash, kind: /\.html?$/i.test(saved.relativeUri) ? "html" : info.kind, mime: /\.html?$/i.test(saved.relativeUri) ? "text/html" : info.mime, previewSupported: true, editable: true, sizeBytes: new TextEncoder().encode(saved.content).length };
    cacheKnowledgeFile(session, saved.noteId, { info: savedInfo, text: saved.content });
    session.current = saved.noteId; pendingEdit.current = null;
    session.notice = saved.indexError ?? "保存成功！"; refreshParent(saved.relativeUri); refresh();
  };
  let imageSource: string | undefined;
  let imageValidationError: string | undefined;
  if (info?.kind === "image" && data?.base64) { try { imageSource = safeImageSource(info, data.base64); } catch (error) { imageValidationError = errorText(error); } }
  const fileInfo = info ? <dl className="kw-info"><dt>类型 / MIME</dt><dd>{fileType(info.relativeUri).toUpperCase()} / {info.mime}</dd><dt>路径</dt><dd className="mono">{info.relativeUri}</dd><dt>大小</dt><dd>{info.sizeBytes.toLocaleString()} B</dd><dt>更新</dt><dd>{info.modifiedAt ? new Date(info.modifiedAt).toLocaleString() : "接口未提供"}</dd><dt>原件版本</dt><dd className="mono">{info.hash ?? "接口未提供"}</dd></dl> : <p className="caption">选择文件后读取真实元信息。</p>;
  // CR-068 K02：文件缺失时目录节点可能已被丢弃，仍按最后确认的稳定 ID 提供重试；不构造其它文件。
  const retryNode: NoteNode | null = selected && !selected.isDir
    ? selected
    : lastSelected.current
      ? { noteId: lastSelected.current.noteId, title: lastSelected.current.title ?? lastSelected.current.noteId, relativeUri: lastSelected.current.relativeUri ?? "", isDir: false, children: [] }
      : null;
  const preview = noteLoading && !draft ? <div className="kw-empty">读取原件中…</div> : noteError && !draft ? <Empty title={selectionGone ? "所选文件不存在" : noteErrorKind === "identity" ? "知识索引身份不一致" : noteErrorKind === "source" ? "知识库源不可用" : "无法显示原件"} desc={noteError} action={selectionGone ? <button type="button" className="btn" id="refresh-directory" data-action="refresh-directory" onClick={() => void refreshDirectory()}>{REFRESH_DIRECTORY_LABEL}</button> : retryNode ? <button className="btn" onClick={() => void loadFile(retryNode)}>重试</button> : undefined} /> : info && (info.kind === "markdown" || info.kind === "html") && typeof (draft?.body ?? body) === "string" ? <ZyDocEditor key={info.noteId} kind={info.kind === "html" ? "html" : "markdown"} title={info.title} body={draft?.body ?? body ?? ""} modified={info.modifiedAt ? new Date(info.modifiedAt).toLocaleString() : undefined} startInEdit={pendingEdit.current === info.noteId} onSave={saveZyDoc} onDelete={() => { if (info) void deleteDoc(info); }} onUploadImage={uploadEditorMedia} onToggleTree={() => treePane.toggle()} /> : md ? <MarkdownContent key={current ?? "empty"} documentKey={current ?? "empty"} source={body ?? ""} onToc={updateToc} onRetention={reportRetention} links={outLinks} onLinkClick={openDocumentLink} /> : info?.kind === "text" && typeof data?.text === "string" ? <><div className="kw-type-note">UTF-8 {type.toUpperCase()} · 安全源码阅读；不执行 HTML、公式或脚本，CSV 不是电子表格引擎。</div><pre className="kw-source"><code>{data.text}</code></pre></> : info?.kind === "image" && imageSource && !imageError ? <figure className={`kw-image ${imageZoom ? "zoomed" : ""}`}><img src={imageSource} alt={info.title} onError={() => setImageError(true)} /><figcaption>{info.relativeUri} · {info.mime}</figcaption><button className="btn sm" onClick={() => setImageZoom(value => !value)}>{imageZoom ? "恢复适应" : "放大图片"}</button></figure> : paged && info ? <PagedDocumentPreview key={libId + ':' + info.noteId} libraryId={libId} info={info} visible={visible} exporting={exporting} onExport={() => exportOriginal()} onNavigation={setPreviewNav} requestedPage={previewPage} onToggleTree={() => treePane.toggle()} onToggleNavigation={() => tocPane.toggle()} onRefreshDirectory={() => void refreshDirectory()} /> : info && ['markdown', 'text'].includes(info.kind) && info.sizeBytes > 1024 * 1024 && !info.editable ? <WindowDocument key={libId + ':' + info.noteId} libraryId={libId} fileId={info.noteId} visible={visible} onExport={() => exportOriginal()} /> : info ? <div className="kw-original"><FileGlyph type={type} /><h2>{info.title}</h2><p>{imageValidationError || (imageError ? "图片解码失败，不能伪造预览成功。" : "原件附件 / 元信息：该格式暂未接入正文解析或预览，可下载原件查看；不内嵌执行 HTML / SVG、宏或脚本，不提供假正文预览。")}</p>{fileInfo}<button className="btn" disabled={(!exportTarget) || exporting || ownerDisabled} onClick={() => exportOriginal()}><Icon name="download" size={14} />{largeExport ? "导出原件（大文件）" : "导出原件"}</button></div> : <div className="kw-empty kw-welcome"><Icon name="bookOpen" size={24} /><h2>{session.selectedFolder || "开始整理知识资料"}</h2><p>从左侧选择文件；新 MD 直接在这里编辑，首次保存成功才出现在目录树。</p><button className="btn primary" disabled={ownerDisabled} onClick={() => newMarkdown(session.selectedFolder)}><Icon name="filePlus" size={14} />新建 MD</button></div>;

  return <div ref={workspaceRef} className="kb-reader knowledge-workspace" data-library={libId} data-design-version="UI-CR055-FEAT009-v1.4" onKeyDown={event => {
    if (!visible) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && draft) { event.preventDefault(); void saveDraft(); }
    if (event.key === "Escape") { setFolderMenu(null); setConfirm(null); if (treePane.overlay) treePane.setVisible(false); if (tocPane.overlay) tocPane.setVisible(false); if (folderMenu !== null) { event.stopPropagation(); menuTrigger.current?.focus(); } }
  }}>
    <aside {...treePane.paneProps} ref={treeRef} className={`kb-side kw-tree left-aside-box ${treePane.paneProps.className}`} data-pane="kb-tree" id={`kb-tree-${libId}`}>
      <div className="kb-side-top left-aside-top-box">
        <div className="zy-space-row">
          <button type="button" className="home-page-btn" title="返回首页" onClick={() => go({ page: "knowledge" })}><Icon name="home" size={14} /></button>
          <select className="choice-space-select" aria-label="选择空间" value={libId} onChange={event => go({ page: "knowledge-lib", libId: event.target.value })}>
            {libraries.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            {!libraries.some(item => item.id === libId) && <option value={libId}>{library?.name ?? "当前空间"}</option>}
          </select>
        </div>
        <PaneClose pane={treePane} label="知识文件树" className="icon-btn"><Icon name="x" size={14} /></PaneClose>
      </div>
      <div className="kw-create-actions"><button className="btn sm" disabled={uploading || ownerDisabled} onClick={() => void upload()}><Icon name="upload" size={14} />{uploading ? '选择 / 上传中…' : '上传'}</button></div>

      <div className="kb-search"><input className="input" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索已索引文件或正文" aria-label="搜索已索引文件或正文" /></div>
      <div className="kb-side-body kb-docs kp-docs">
        {session.folderInput && folderEditor(session.folderInput.parent, 0)}
        {query.trim() ? <>
          <div className="kw-search-summary"><span>索引检索</span><button onClick={() => setQuery('')}>清除</button></div>
          {searching && <div className="kp-reading-state" role="status">正在查询已发布索引…</div>}
          {searchError && <div className="kp-reading-state error" role="alert">{searchError}</div>}
          {coverage && <div className="kp-coverage" role="status">{coverage.coverage.state === 'not_indexed' ? '当前尚无可查询的正文索引；目录盘点不等于全文索引。' : `索引快照 v${coverage.indexEpoch} · 原件待核验${coverage.coverage.incomplete ? ' · 结果覆盖不完整' : ''}${coverage.coverage.metadataOnlyCount ? ' · 含仅元信息命中' : ''}。已变化源核验前不发送给 AI。`}</div>}
          {!searching && coverage?.coverage.state === 'ready' && hits?.length === 0 && <div className="kw-empty">当前索引范围内无匹配结果</div>}
          {hits?.map(hit => <button className="kb-search-hit" key={hit.libraryId + ':' + hit.noteId} onClick={() => { knownEntries.current.set(hit.noteId, { noteId: hit.noteId, title: hit.title, relativeUri: hit.relativeUri, isDir: false, children: [], external: true }); select(hit.noteId); }}><b>{hit.title}</b><small>{hit.relativeUri}</small><span>{hit.snippet}</span></button>)}
        </> : <PagedKnowledgeTree ref={directoryHandle} libraryId={libId} visible={visible} model={session.directory} selected={current} disabled={ownerDisabled} onEntries={acceptEntries}
          onOpen={treeOpen} onFolder={treeFolder} onCreateFolder={treeNewFolder} onCreateDocument={treeNewDocument} onCreate={(parent, kind) => void createDoc(parent, kind)} onRename={renameDoc} onDelete={entry => void deleteDoc(entry)} onMove={(entry, parent) => void moveDoc(entry, parent)} onImport={parent => void importDocs(parent)} onUpload={parent => void upload(parent)} onCopy={entry => void copyDoc(entry)} onMigrate={setMigrate} />}
      </div>
      <div className="wiki-page-footer">
        <button type="button" className="footer-btn" onClick={() => setDocPanel("setting")}><Icon name="settings" size={14} /> 设置</button>
        <span className="footer-split" />
        <button type="button" className="footer-btn" onClick={() => { setDocPanel("recycle"); void loadRecycle(); }}><Icon name="trash" size={14} /> 回收站</button>
      </div>
    </aside>
    <section className="kb-main kw-document" data-pane="kb-document" aria-label="正文阅读与编辑区">{docPanel === "setting" && <div className="zy-setting-box"><div className="zy-setting-head"><b>基本信息</b><button type="button" className="zy-primary" onClick={() => void api.kbUpdateMeta(libId, { name: spaceName, description: spaceExplain }).then(() => { session.notice = "修改成功"; setLibrary(current => current ? { ...current, name: spaceName, description: spaceExplain } : current); refresh(); }).catch(error => { session.notice = errorText(error); refresh(); })}>保存设置</button></div><label>空间名</label><input maxLength={25} placeholder="请输入空间名" value={spaceName} onChange={event => setSpaceName(event.target.value)} /><label>空间说明</label><textarea maxLength={250} rows={6} placeholder="请输入空间说明" value={spaceExplain} onChange={event => setSpaceExplain(event.target.value)} /><button type="button" className="btn" onClick={() => setDocPanel("doc")}>返回文档</button></div>}{docPanel === "recycle" && <div className="zy-recycle"><div className="zy-recycle-head"><span><button type="button" className="btn sm" disabled={!recycleItems.length} onClick={() => { if (!window.confirm("确定要恢复此页面吗？如果该页面的父页面也被删除，则需父页面恢复后才可看见此页面")) return; void Promise.all(recycleItems.map(item => api.kbRecycleRestore(libId, item.id))).then(() => loadRecycle()); }}>恢复</button> <button type="button" className="btn sm" disabled={!recycleItems.length} onClick={() => { if (!window.confirm("确定要彻底删除此页面吗?")) return; void Promise.all(recycleItems.map(item => api.kbRecyclePurge(libId, item.id))).then(() => loadRecycle()); }}>彻底删除</button></span><button type="button" className="btn sm primary" onClick={() => void loadRecycle()}>查询</button></div><table><thead><tr><th>名字</th><th>删除时间</th><th>操作人</th><th></th></tr></thead><tbody>{recycleItems.map(item => <tr key={item.id}><td>{item.name}</td><td>{new Date(item.deletedAt).toLocaleString()}</td><td>本人</td><td><button type="button" className="btn sm" onClick={() => { if (!window.confirm("确定要恢复此页面吗？如果该页面的父页面也被删除，则需父页面恢复后才可看见此页面")) return; void api.kbRecycleRestore(libId, item.id).then(() => { void directoryHandle.current?.refresh(""); void loadRecycle(); }); }}>恢复</button> <button type="button" className="btn sm" onClick={() => { if (!window.confirm("确定要彻底删除此页面吗?")) return; void api.kbRecyclePurge(libId, item.id).then(() => loadRecycle()); }}>彻底删除</button></td></tr>)}{!recycleItems.length && <tr><td colSpan={4}>回收站是空的</td></tr>}</tbody></table><button type="button" className="btn" onClick={() => setDocPanel("doc")}>返回文档</button></div>}<div hidden={docPanel !== "doc"}>{!!session.drafts.size && <nav className="kw-draft-tabs" aria-label="保留的编辑草稿">{Array.from(session.drafts.values()).map(item => <button key={item.key} aria-selected={current === item.key} onClick={() => select(item.key)}><Icon name="edit" size={14} />{item.title || "未命名 MD"}{dirty(item) ? " *" : ""}{item.noteId ? "" : "（未落盘）"}</button>)}</nav>}{session.cachePressure && <div className="kw-notice kw-notice-pressure" role="status"><span>{CACHE_PRESSURE_NOTICE}</span></div>}{session.notice && <div className="kw-notice kw-notice-action" role={noticeAction ? "alert" : "status"}><span>{session.notice}</span>{noticeAction && <button type="button" className="btn sm" id={noticeAction.id} data-action={noticeAction.id} onClick={() => { if (noticeAction.confirm) setConfirm("reload-original"); else void refreshDirectory(); }}>{noticeAction.label}</button>}<button className="icon-btn" aria-label="关闭消息" onClick={() => { session.notice = ""; setNoticeAction(null); setSelectionGone(false); refresh(); }}><Icon name="x" size={14} /></button></div>}<div className="kw-document-head"><PaneToggle pane={treePane} label="知识文件树" className="icon-btn" controls={`kb-tree-${libId}`}><Icon name="panelLeft" size={14} /></PaneToggle><div className="kb-crumb"><FileGlyph type={type} size={20} /><button className="backlink" onClick={() => go({ page: "knowledge" })}>知识库</button><span>/</span><span className="ellipsis">{title}</span>{draft && !draft.noteId ? <span className="tag">未落盘草稿</span> : (info || selected) && <span className="tag">{type.toUpperCase()}</span>}</div><span className="spacer" /><PaneToggle pane={tocPane} label="目录与文件信息" className="icon-btn" controls={`kb-toc-${libId}`}><Icon name="panelRight" size={14} /></PaneToggle>{false && md && <div className="seg"><button aria-selected={draft?.mode !== "edit"} onClick={() => setMode("read")}>阅读</button><button aria-selected={draft?.mode === "edit"} disabled={!draft && (!info?.editable || !info?.hash || noteLoading || !!noteError)} onClick={() => setMode("edit")}>编辑</button></div>}</div><div className="kw-toolbar"><span className="ellipsis" title={uri ?? draft?.parent}>{draft && !draft.noteId ? `保存位置：${draft.parent || "库根目录"}` : uri ?? "选择文件或创建内容"}</span><span className="spacer" />{draft ? <><span className="caption">{draft.saving ? "保存中…" : dirty(draft) ? "未保存" : "与原文一致"}</span><button className="btn sm primary" disabled={draft.saving || ownerDisabled || draft.conflict} onClick={() => void saveDraft()}><Icon name="save" size={14} />保存</button><button className="btn sm" disabled={draft.saving} onClick={() => dirty(draft) ? setConfirm("discard") : void discardDraft(false)}>取消编辑</button></> : <><button className="btn sm" disabled={!info || exporting || ownerDisabled} onClick={() => exportOriginal()}><Icon name="download" size={14} />{largeExport ? "导出原件（大文件）" : "导出原件"}</button><button className="btn sm" disabled={!info || info.kind !== "markdown" || false || noteLoading || !!noteError} onClick={() => setRefOpen(true)}>引用</button></>}</div><div className="kw-memory-note">草稿按库与文档保留在当前会话内存，退出应用后丢失；仅点击保存才写入本机原件。{ownerDisabled ? "当前知识库已禁用，文件操作不可用。" : ""}</div><KnowledgeTransferPanel state={transfer} disabled={ownerDisabled} />{draft?.error && <div id="kw-save-error" className="kw-save-error" role="alert">{draft.error}</div>}{confirm && <div className="kw-confirm" role="alert"><b>{confirm === "latest" ? "放弃当前草稿并读取最新原文？" : confirm === "reload-original" ? "放弃草稿并重新读取原件？" : "放弃未保存草稿？"}</b><span>{confirm === "reload-original" ? "将释放本文档未保存的草稿并从原件重新读取；不修改已保存原文，此操作不可撤销。" : "不修改已保存原文，此操作不可撤销。"}</span><div className="row"><button className="btn sm danger" onClick={() => confirm === "reload-original" ? void reloadOriginal() : void discardDraft(confirm === "latest")}>确认放弃</button><button className="btn sm" onClick={() => setConfirm(null)}>保留草稿</button></div></div>}<div className="kw-scroll" ref={mainRef} onScroll={event => { if (current) session.scroll.set(current, event.currentTarget.scrollTop); }}>
      {Array.from(session.drafts.values()).map(item => <div className="kw-editor" key={item.editorKey ?? item.key} hidden={item.key !== current || item.mode !== "edit"}><label htmlFor={`kw-title-${item.key}`}>{item.noteId ? "文件名（原路径只读；标题可在正文 H1 修改）" : "文件名（未带扩展名时补 .md）"}</label><input autoFocus={!item.noteId} id={`kw-title-${item.key}`} className="kw-title input" readOnly={!!item.noteId} aria-invalid={!!item.error} aria-describedby={item.error ? "kw-save-error" : undefined} value={item.title} placeholder="未命名.md" onChange={event => { item.title = event.target.value; refresh(); }} /><label htmlFor={`kw-body-${item.key}`}>Markdown 正文</label><textarea id={`kw-body-${item.key}`} className="textarea mono" spellCheck={false} value={item.body} placeholder={"# 标题\n\n开始编写 Markdown…"} onChange={event => { item.body = event.target.value; refresh(); }} /></div>)}{draft?.mode !== "edit" && preview}</div>{draft?.conflict && docPanel === "doc" && <section className="kw-conflict"><h3>保存冲突 · 原件基线已改变</h3><p>编辑基线、当前草稿及可读取的最新版本均保留，不会静默覆盖。</p><details><summary>查看编辑基线与最新版本</summary><b>编辑基线</b><pre>{draft.baseBody}</pre><b>最新原文</b><pre>{draft.latest?.text ?? draft.latestError ?? "最新原文未提供"}</pre></details><button className="btn sm danger" onClick={() => setConfirm("latest")}>放弃草稿并载入最新原文…</button></section>}</div></section>
    <aside {...tocPane.paneProps} ref={tocRef} className={`kb-toc kw-toc ${tocPane.paneProps.className}`} data-pane="kb-toc" id={`kb-toc-${libId}`} aria-label="正文目录或文件信息"><ResizeHandle pane={tocPane} label="目录与文件信息" controls={`kb-toc-${libId}`} /><div className="kw-toc-head"><b>{paged ? "页面导航" : md ? "本页目录" : "文件信息"}</b><PaneClose pane={tocPane} label="目录与文件信息" className="icon-btn"><Icon name="x" size={14} /></PaneClose></div>{paged ? (previewNav ? <nav className="kp-page-navigation" aria-label="页面导航">{Array.from({ length: previewNav.pages }, (_, n) => <button type="button" key={n} aria-current={previewNav.page === n + 1} onClick={() => setPreviewPage(n + 1)}>{/\.(ppt|pps|pot|pptx)$/i.test(info?.relativeUri ?? "") ? "幻灯片 " : "第 "}{n + 1}{/\.(ppt|pps|pot|pptx)$/i.test(info?.relativeUri ?? "") ? "" : " 页"}</button>)}</nav> : <p className="caption">预览就绪后显示实际页数；不虚构页数。</p>) : md ? <>
          <div className="kw-link-tabs" role="tablist" aria-label="正文导航与链接">
            <button role="tab" aria-selected={linkTab === 'outline'} onClick={() => setLinkTab('outline')}>大纲</button>
            <button role="tab" aria-selected={linkTab === 'backlinks'} onClick={() => setLinkTab('backlinks')}>反向链接<span className="count">{backlinkRows.length}</span></button>
            <button role="tab" aria-selected={linkTab === 'unresolved'} onClick={() => setLinkTab('unresolved')}>未解析<span className="count">{outLinks.filter(link => link.state !== 'resolved').length}</span></button>
            <button role="tab" aria-selected={linkTab === 'graph'} onClick={() => setLinkTab('graph')}>图谱</button>
          </div>
          {linkTab === 'outline' ? <TocPanel key={current ?? 'empty'} toc={toc} onJump={jumpToHeading} />
            : linkTab === 'graph' ? <KnowledgeGraph libraryId={libId} noteId={graphFocus ?? info?.noteId ?? null} onOpen={(id, path) => { const title = (path.split('/').pop() ?? '').replace(/\.md$/i, ''); void loadFile({ noteId: id, title, relativeUri: path, isDir: false, children: [] } as NoteNode); }} onExpand={id => setGraphFocus(id)} /> : linkTab === 'backlinks' ? (backlinkRows.length ? <div className="kw-backlinks">{backlinkRows.map((row, index) => <button type="button" className="kw-backlink" key={`${row.sourceNoteId}:${index}`} onClick={() => { const title = row.sourceTitle; void loadFile({ noteId: row.sourceNoteId, title, relativeUri: row.sourcePath, isDir: false, children: [] } as NoteNode); }}><b>{row.sourceTitle}</b><span className="path">{row.sourcePath}</span><span className="snippet">{row.snippet}</span></button>)}</div> : <p className="kw-link-empty">还没有笔记引用它。在别的笔记里输入 [[{info?.title}]] 就会出现在这里。</p>)
            : (outLinks.filter(link => link.state !== 'resolved').length ? <div className="kw-backlinks">{outLinks.filter(link => link.state !== 'resolved').map((link, index) => <button type="button" className="kw-backlink" key={`${link.rawTarget}:${index}`} onClick={() => openDocumentLink({ name: link.name, heading: link.heading ?? null, state: link.state, targetPath: link.targetPath ?? null, targetNoteId: link.targetNoteId ?? null })}><b>{link.rawTarget}</b><span className="path">{link.state === 'ambiguous' ? '同名多个文件，点击选择' : '目标不存在，点击新建'}</span></button>)}</div> : <p className="kw-link-empty">没有未解析链接。</p>)}
        </> : fileInfo}<div className="kw-side-section"><b>本人资料管理</b><p>不受 AI 项目授权有无限制；授权只控制 AI 只读检索，不授予写入或执行。</p><button className="btn sm" disabled={!library} onClick={() => setGrantOpen(true)}><Icon name="shield" size={14} />AI 授权管理</button><KnowledgeIndexStatus libraryId={libId} visible={visible} disabled={ownerDisabled} onPublished={indexPublished} />
      <SemanticModelStatus visible={visible} /></div><p className="kw-safety-note">正文不自动加载外链图片或本地资源。目录盘点与正文索引分别处理；Office / PDF 解析能力按实际后端反馈。</p></aside>
    {migrate && <Modal title="迁移文档" onClose={() => setMigrate(null)} footer={<button className="btn" onClick={() => setMigrate(null)}>取消</button>}><p>选择目标文件夹。拖到目录上也会迁移。</p>{[{ relativeUri: "", title: "空间根" }, ...[...session.directory.entries.values()].filter(item => item.isDir)].map(item => <button className="btn" key={item.relativeUri || "root"} onClick={() => { void moveDoc(migrate, item.relativeUri); setMigrate(null); }}>{item.title || item.relativeUri}</button>)}</Modal>}
    {namePrompt && <Modal title={namePrompt.title} onClose={() => setNamePrompt(null)} footer={<><button className="btn" onClick={() => setNamePrompt(null)}>取消</button><button className="btn primary" onClick={() => void namePrompt.run(namePrompt.value).then(error => { if (error) setNamePrompt(current => current ? { ...current, error } : current); else setNamePrompt(null); }).catch(error => setNamePrompt(current => current ? { ...current, error: errorText(error) } : current))}>确定</button></>}><label>{namePrompt.label}</label><input className="input" autoFocus value={namePrompt.value} placeholder={namePrompt.label} onChange={event => setNamePrompt(current => current ? { ...current, value: event.target.value, error: "" } : current)} /><small className="kw-error-text">{namePrompt.error}</small></Modal>}
    {linkCandidates && <Modal title="选择要打开的笔记" onClose={() => setLinkCandidates(null)}>{linkCandidates.map(candidate => <button type="button" className="kw-candidate" key={candidate.path} onClick={() => { setLinkCandidates(null); void loadFile({ noteId: candidate.noteId, title: candidate.title, relativeUri: candidate.path, isDir: false, children: [] } as NoteNode); }}><b>{candidate.title}</b><span className="path">{candidate.path}</span></button>)}</Modal>}
    {grantOpen && library && <GrantDialog library={library} visible={visible} onClose={() => setGrantOpen(false)} />}{refOpen && info && visible && <ReferenceDialog libId={libId} noteId={info.noteId} title={info.title} onClose={() => setRefOpen(false)} />}
  </div>;
}

/** 不凭空注入其它会话，也不调用模型：只进入现有获授权项目，由其 @ 引用入口复检权限。 */
function ReferenceDialog({ libId, noteId, title, onClose }: { libId: string; noteId: string; title: string; onClose: () => void }) {
  const { go } = useApp();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([api.listProjects(), api.kbGrants()]).then(([ps, gs]) => { if (alive) setProjects(ps.filter(p => gs.some(g => g.projectId === p.id && g.libraryId === libId && g.readAllowed))); }).catch(e => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [libId]);
  return <div className="kb-dialog"><Modal title="引用到项目会话" width={620} onClose={onClose}><div className="kb-grant-box"><b>{title}</b><p className="mono small">{libId} / {noteId}</p><p className="muted small">仅列已授权项目。进入后，在 AI 输入框的 @ 知识入口选择该文件；本按钮不自动发送消息、不将正文注入会话。</p>{error ? <p role="alert">授权读取失败：{error}</p> : projects === null ? <p>授权加载中…</p> : projects.length === 0 ? <Empty title="没有可引用的项目" desc="先在授权管理中授予项目只读访问权。" /> : projects.map(p => <button className="btn" key={p.id} onClick={() => { onClose(); go({ page: "project", projectId: p.id, tab: "code" }); }}>前往「{p.name}」引用</button>)}</div></Modal></div>;
}
