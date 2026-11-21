import { Icon } from "@/components/icons";
import { fileTypeGlyph } from "@/components/icon-tiles";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import * as api from "@/api";
import * as performanceApi from '@/api/knowledge-performance';
import type { KnowledgeEntry, KnowledgeSearchResult } from '@/api/knowledge-performance';
import { PagedKnowledgeTree, type KnowledgeTreeHandle } from './PagedKnowledgeTree';
import { MarkdownContent } from './MarkdownContent';
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
import { CACHE_PRESSURE_NOTICE, cacheKnowledgeFile, canAdmitKnowledgeFile, clearKnowledgeDocumentRetention, getKnowledgeFile, trimKnowledgeCache, acceptSavedMarkdown, checkFileIdentity, dirty, errorText, expandParents, fileType, findNode, flattenTree, isConflict, isMarkdown, knowledgeSession, markdownName, nameError, nextDraftKey, parentOf, pathTaken, readableKind, recordKnowledgeDocumentRetention, renderKnowledgeMarkdown, safeImageSource, type KnowledgeDraft } from "./knowledgeWorkspace";
import { draftReleaseConfirmed, externalChangeNotice, reconcileKnownEntries, REFRESH_DIRECTORY_LABEL, selectionGoneNotice, sourceRevisionDecision, type ReaderNoticeAction } from './performanceModel';
import "./knowledge.css";
import "./knowledge-cr045.css";

export { fileType } from "./knowledgeWorkspace";
/** CR-051：14 类扩展名映射与类型色令牌统一来自 components/icon-tiles（UI-CR051 §5.2 唯一来源）。 */
function FileGlyph({ type, folder = false, open = false, size = 15 }: { type: string; folder?: boolean; open?: boolean; size?: number }) {
  const glyph = fileTypeGlyph(type);
  return <span className={`kb-tree-file type-${folder ? "folder" : glyph.token}`} aria-hidden>
    <Icon name={folder ? (open ? "folderOpen" : "folder") : glyph.icon} size={size} />
  </span>;
}
const depthStyle = (depth: number) => ({ "--kw-depth": depth }) as CSSProperties;

export function Reader(props: { libId: string; noteId?: string; visible?: boolean }) {
  return <ReaderView key={props.libId} libId={props.libId} initialNoteId={props.noteId} visible={props.visible ?? true} />;
}

function ReaderView({ libId, initialNoteId, visible }: { libId: string; initialNoteId?: string; visible: boolean }) {
  const { go } = useApp();
  const session = useMemo(() => knowledgeSession(libId), [libId]);
  const [revision, setRevision] = useState(0);
  const [library, setLibrary] = useState<KnowledgeLibrary | null>(null);
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
  const [imageZoom, setImageZoom] = useState(false);
  const [imageError, setImageError] = useState(false);
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
    setNoteError(null); setNoteLoading(true); setSelectionGone(false);
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
      if (seq === requestSeq.current && mounted.current && visibleRef.current) setNoteError(`读取失败：${errorText(error)}`);
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
      keep, reachable: new Set(session.directory.entries.keys()), rootComplete: parentId === '' && complete,
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
    if (query.trim()) {
      // 检索态下文件树未挂载，没有可调用的刷新句柄；先回到目录树再刷新。
      setQuery("");
      await new Promise<void>(resolve => { window.setTimeout(resolve, 0); });
    }
    await loadTree();
    const node = current ? knownEntries.current.get(current) ?? null : null;
    if (node && !node.isDir) { setNoteError(null); void loadFile(node); return; }
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
    api.kbList().then(libraries => { if (alive && mounted.current && visibleRef.current) setLibrary(libraries.find(item => item.id === libId) ?? null); }).catch(error => { if (alive && mounted.current && visibleRef.current) { session.notice = '知识库元信息加载失败：' + errorText(error); refresh(); } });
    // Deep links need not enumerate the whole library. The backend resolves this file directly.
    const target = session.current || initialNoteId;
    if (target && !knownEntries.current.has(target) && !session.drafts.has(target)) {
      api.kbFileInfo(libId, target).then(metadata => {
        if (!alive || !mounted.current || (session.current && session.current !== target)) return;
        knownEntries.current.set(target, { noteId: metadata.noteId, title: metadata.title, relativeUri: metadata.relativeUri, isDir: false, children: [], external: true });
        session.current = metadata.noteId; setTree([...knownEntries.current.values()]); refresh();
      }).catch(error => { if (alive && mounted.current) setNoteError('文件定位失败：' + errorText(error)); });
    }
    return () => { alive = false; session.visible = false; trimKnowledgeCache(session); treeSeq.current += 1; requestSeq.current += 1; };
  }, [libId, visible, initialNoteId, refresh, session]);

  // R03: a changed directory revision invalidates a clean body; a dirty draft is kept with an
  // explicit notice instead of being silently replaced or saved over the new original.
  useEffect(() => {
    if (!visible || !current) return;
    const activeDraft = session.drafts.get(current);
    const action = sourceRevisionDecision(activeDraft, selectedRevision);
    const node = knownEntries.current.get(activeDraft?.noteId ?? current) ?? null;
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
    if (node && !node.isDir) void loadFile(node);
    else if (tree !== null && !treeError) {
      // v1.4：只提示并可刷新目录，不跳到其它文件、不清除草稿。
      setNoteLoading(false); setSelectionGone(true); setNoteError(selectionGoneNotice().text); setNoticeAction(null);
    }
    return () => { requestSeq.current += 1; };
  }, [current, visible, loadFile, tree === null, treeError, selectedRevision, session, refresh]);

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
      return;
    }
    if (mainRef.current && current) session.scroll.set(current, mainRef.current.scrollTop);
    requestSeq.current += 1; setNoteError(null); setToc([]); setNoteLoading(!session.drafts.has(key)); setSelectionGone(false);
    clearKnowledgeDocumentRetention(session);
    session.current = key; trimKnowledgeCache(session);
    const node = findNode(tree ?? [], session.drafts.get(key)?.noteId ?? key);
    if (node) { session.selectedFolder = parentOf(node.relativeUri); expandParents(session, tree ?? [], node.noteId); }
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
      session.notice = ""; setNoticeAction(null); setSelectionGone(false); setNoteError(null);
      refresh();
    } catch (error) {
      target.error = `原件重新读取失败，草稿仍保留：${errorText(error)}`;
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
  const upload = async () => {
    if (uploadBusy.current || ownerDisabled || !visibleRef.current) return;
    uploadBusy.current = true; setUploading(true);
    try {
      const result = await api.kbUploadFiles(libId, session.selectedFolder);
      session.notice = result.cancelled ? "已取消本机文件选择，没有上传文件。" : result.items.map(item => item.success ? `${item.name}：已上传${item.indexError ? `，索引失败：${item.indexError}` : ""}` : `${item.name}：上传失败，${item.error ?? "未提供原因"}`).join("；") || "没有上传文件。";
      if (!result.cancelled && result.items.some(item => item.success) && mounted.current && visibleRef.current) void loadTree();
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
  let imageSource: string | undefined;
  let imageValidationError: string | undefined;
  if (info?.kind === "image" && data?.base64) { try { imageSource = safeImageSource(info, data.base64); } catch (error) { imageValidationError = errorText(error); } }
  const fileInfo = info ? <dl className="kw-info"><dt>类型 / MIME</dt><dd>{fileType(info.relativeUri).toUpperCase()} / {info.mime}</dd><dt>路径</dt><dd className="mono">{info.relativeUri}</dd><dt>大小</dt><dd>{info.sizeBytes.toLocaleString()} B</dd><dt>更新</dt><dd>{info.modifiedAt ? new Date(info.modifiedAt).toLocaleString() : "接口未提供"}</dd><dt>原件版本</dt><dd className="mono">{info.hash ?? "接口未提供"}</dd></dl> : <p className="caption">选择文件后读取真实元信息。</p>;
  const preview = noteLoading && !draft ? <div className="kw-empty">读取原件中…</div> : noteError && !draft ? <Empty title="无法显示原件" desc={noteError} action={selectionGone ? <button type="button" className="btn" id="refresh-directory" data-action="refresh-directory" onClick={() => void refreshDirectory()}>{REFRESH_DIRECTORY_LABEL}</button> : selected ? <button className="btn" onClick={() => void loadFile(selected)}>重试</button> : undefined} /> : md ? <MarkdownContent key={current ?? "empty"} documentKey={current ?? "empty"} source={body ?? ""} onToc={updateToc} onRetention={reportRetention} /> : info?.kind === "text" && typeof data?.text === "string" ? <><div className="kw-type-note">UTF-8 {type.toUpperCase()} · 安全源码阅读；不执行 HTML、公式或脚本，CSV 不是电子表格引擎。</div><pre className="kw-source"><code>{data.text}</code></pre></> : info?.kind === "image" && imageSource && !imageError ? <figure className={`kw-image ${imageZoom ? "zoomed" : ""}`}><img src={imageSource} alt={info.title} onError={() => setImageError(true)} /><figcaption>{info.relativeUri} · {info.mime}</figcaption><button className="btn sm" onClick={() => setImageZoom(value => !value)}>{imageZoom ? "恢复适应" : "放大图片"}</button></figure> : info && ['markdown', 'text'].includes(info.kind) && info.sizeBytes > 1024 * 1024 && !info.editable ? <WindowDocument key={libId + ':' + info.noteId} libraryId={libId} fileId={info.noteId} visible={visible} onExport={() => exportOriginal()} /> : info ? <div className="kw-original"><FileGlyph type={type} /><h2>{info.title}</h2><p>{imageValidationError || (imageError ? "图片解码失败，不能伪造预览成功。" : info.kind === "pdf" ? "PDF 原件已保留；当前桌面未接入安全 PDF 查看器，仅支持元信息和导出，不把 Markdown 摘要当作 PDF。" : "原件附件 / 元信息：Office、压缩包或其它格式没有正文解析和原生编辑。不内嵌执行 HTML / SVG、宏或脚本，不提供假正文预览。")}</p>{fileInfo}<button className="btn" disabled={(!exportTarget) || exporting || ownerDisabled} onClick={() => exportOriginal()}><Icon name="download" size={14} />{largeExport ? "导出原件（大文件）" : "导出原件"}</button></div> : <div className="kw-empty kw-welcome"><Icon name="bookOpen" size={24} /><h2>{session.selectedFolder || "开始整理知识资料"}</h2><p>从左侧选择文件；新 MD 直接在这里编辑，首次保存成功才出现在目录树。</p><button className="btn primary" disabled={ownerDisabled} onClick={() => newMarkdown(session.selectedFolder)}><Icon name="filePlus" size={14} />新建 MD</button></div>;

  return <div ref={workspaceRef} className="kb-reader knowledge-workspace" data-library={libId} data-design-version="UI-CR055-FEAT009-v1.4" onKeyDown={event => {
    if (!visible) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && draft) { event.preventDefault(); void saveDraft(); }
    if (event.key === "Escape") { setFolderMenu(null); setConfirm(null); if (treePane.overlay) treePane.setVisible(false); if (tocPane.overlay) tocPane.setVisible(false); if (folderMenu !== null) { event.stopPropagation(); menuTrigger.current?.focus(); } }
  }}>
    <aside {...treePane.paneProps} ref={treeRef} className={`kb-side kw-tree ${treePane.paneProps.className}`} data-pane="kb-tree" id={`kb-tree-${libId}`}>
      <div className="kb-side-top"><b className="row"><Icon name="book" size={14} />{library?.name ?? '知识库'}</b><div className="muted small">本机原件 · 按目录加载</div><PaneClose pane={treePane} label="知识文件树" className="icon-btn"><Icon name="x" size={14} /></PaneClose></div>
      <div className="kw-create-actions"><button className="btn sm" disabled={uploading || ownerDisabled} onClick={() => void upload()}><Icon name="upload" size={14} />{uploading ? '选择 / 上传中…' : '上传'}</button><button className="btn sm primary" disabled={ownerDisabled} onClick={() => newMarkdown('')}><Icon name="filePlus" size={14} />新建 MD</button><button className="btn sm" disabled={ownerDisabled} aria-label="在库根目录新建文件夹" onClick={() => createFolder('')}><Icon name="folderPlus" size={14} /></button></div>
      <div className="kp-entry"><button className="btn sm" disabled={ownerDisabled || transfer.busy} title="GB 级原件导入，可多选；与上方 25 MiB 内联上传不同" onClick={() => void transfer.startImport(session.selectedFolder)}><Icon name="upload" size={14} />导入原件（大文件）</button><span className="muted small">多选 · 后台复制</span></div>
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
          onOpen={treeOpen} onFolder={treeFolder} onCreateFolder={treeNewFolder} onCreateDocument={treeNewDocument} />}
      </div>
    </aside>
    <section className="kb-main kw-document" data-pane="kb-document" aria-label="正文阅读与编辑区">{!!session.drafts.size && <nav className="kw-draft-tabs" aria-label="保留的编辑草稿">{Array.from(session.drafts.values()).map(item => <button key={item.key} aria-selected={current === item.key} onClick={() => select(item.key)}><Icon name="edit" size={14} />{item.title || "未命名 MD"}{dirty(item) ? " *" : ""}{item.noteId ? "" : "（未落盘）"}</button>)}</nav>}{session.cachePressure && <div className="kw-notice kw-notice-pressure" role="status"><span>{CACHE_PRESSURE_NOTICE}</span></div>}{session.notice && <div className="kw-notice kw-notice-action" role={noticeAction ? "alert" : "status"}><span>{session.notice}</span>{noticeAction && <button type="button" className="btn sm" id={noticeAction.id} data-action={noticeAction.id} onClick={() => { if (noticeAction.confirm) setConfirm("reload-original"); else void refreshDirectory(); }}>{noticeAction.label}</button>}<button className="icon-btn" aria-label="关闭消息" onClick={() => { session.notice = ""; setNoticeAction(null); setSelectionGone(false); refresh(); }}><Icon name="x" size={14} /></button></div>}<div className="kw-document-head"><PaneToggle pane={treePane} label="知识文件树" className="icon-btn" controls={`kb-tree-${libId}`}><Icon name="panelLeft" size={14} /></PaneToggle><div className="kb-crumb"><FileGlyph type={type} size={20} /><button className="backlink" onClick={() => go({ page: "knowledge" })}>知识库</button><span>/</span><span className="ellipsis">{title}</span>{draft && !draft.noteId ? <span className="tag">未落盘草稿</span> : (info || selected) && <span className="tag">{type.toUpperCase()}</span>}</div><span className="spacer" /><PaneToggle pane={tocPane} label="目录与文件信息" className="icon-btn" controls={`kb-toc-${libId}`}><Icon name="panelRight" size={14} /></PaneToggle>{md && <div className="seg"><button aria-selected={draft?.mode !== "edit"} onClick={() => setMode("read")}>阅读</button><button aria-selected={draft?.mode === "edit"} disabled={!draft && (!info?.editable || !info.hash || noteLoading || !!noteError)} onClick={() => setMode("edit")}>编辑</button></div>}</div><div className="kw-toolbar"><span className="ellipsis" title={uri ?? draft?.parent}>{draft && !draft.noteId ? `保存位置：${draft.parent || "库根目录"}` : uri ?? "选择文件或创建内容"}</span><span className="spacer" />{draft ? <><span className="caption">{draft.saving ? "保存中…" : dirty(draft) ? "未保存" : "与原文一致"}</span><button className="btn sm primary" disabled={draft.saving || ownerDisabled || draft.conflict} onClick={() => void saveDraft()}><Icon name="save" size={14} />保存</button><button className="btn sm" disabled={draft.saving} onClick={() => dirty(draft) ? setConfirm("discard") : void discardDraft(false)}>取消编辑</button></> : <><button className="btn sm" disabled={!info || exporting || ownerDisabled} onClick={() => exportOriginal()}><Icon name="download" size={14} />{largeExport ? "导出原件（大文件）" : "导出原件"}</button><button className="btn sm" disabled={!info || info.kind !== "markdown" || false || noteLoading || !!noteError} onClick={() => setRefOpen(true)}>引用</button></>}</div><div className="kw-memory-note">草稿按库与文档保留在当前会话内存，退出应用后丢失；仅点击保存才写入本机原件。{ownerDisabled ? "当前知识库已禁用，文件操作不可用。" : ""}</div><KnowledgeTransferPanel state={transfer} disabled={ownerDisabled} />{draft?.error && <div id="kw-save-error" className="kw-save-error" role="alert">{draft.error}</div>}{confirm && <div className="kw-confirm" role="alert"><b>{confirm === "latest" ? "放弃当前草稿并读取最新原文？" : confirm === "reload-original" ? "放弃草稿并重新读取原件？" : "放弃未保存草稿？"}</b><span>{confirm === "reload-original" ? "将释放本文档未保存的草稿并从原件重新读取；不修改已保存原文，此操作不可撤销。" : "不修改已保存原文，此操作不可撤销。"}</span><div className="row"><button className="btn sm danger" onClick={() => confirm === "reload-original" ? void reloadOriginal() : void discardDraft(confirm === "latest")}>确认放弃</button><button className="btn sm" onClick={() => setConfirm(null)}>保留草稿</button></div></div>}<div className="kw-scroll" ref={mainRef} onScroll={event => { if (current) session.scroll.set(current, event.currentTarget.scrollTop); }}>
      {Array.from(session.drafts.values()).map(item => <div className="kw-editor" key={item.editorKey ?? item.key} hidden={item.key !== current || item.mode !== "edit"}><label htmlFor={`kw-title-${item.key}`}>{item.noteId ? "文件名（原路径只读；标题可在正文 H1 修改）" : "文件名（未带扩展名时补 .md）"}</label><input autoFocus={!item.noteId} id={`kw-title-${item.key}`} className="kw-title input" readOnly={!!item.noteId} aria-invalid={!!item.error} aria-describedby={item.error ? "kw-save-error" : undefined} value={item.title} placeholder="未命名.md" onChange={event => { item.title = event.target.value; refresh(); }} /><label htmlFor={`kw-body-${item.key}`}>Markdown 正文</label><textarea id={`kw-body-${item.key}`} className="textarea mono" spellCheck={false} value={item.body} placeholder={"# 标题\n\n开始编写 Markdown…"} onChange={event => { item.body = event.target.value; refresh(); }} /></div>)}{draft?.mode !== "edit" && preview}{draft?.conflict && <section className="kw-conflict"><h3>保存冲突 · 原件基线已改变</h3><p>编辑基线、当前草稿及可读取的最新版本均保留，不会静默覆盖。</p><details><summary>查看编辑基线与最新版本</summary><b>编辑基线</b><pre>{draft.baseBody}</pre><b>最新原文</b><pre>{draft.latest?.text ?? draft.latestError ?? "最新原文未提供"}</pre></details><button className="btn sm danger" onClick={() => setConfirm("latest")}>放弃草稿并载入最新原文…</button></section>}</div></section>
    <aside {...tocPane.paneProps} ref={tocRef} className={`kb-toc kw-toc ${tocPane.paneProps.className}`} data-pane="kb-toc" id={`kb-toc-${libId}`} aria-label="正文目录或文件信息"><ResizeHandle pane={tocPane} label="目录与文件信息" controls={`kb-toc-${libId}`} /><div className="kw-toc-head"><b>{md ? "本页目录" : "文件信息"}</b><PaneClose pane={tocPane} label="目录与文件信息" className="icon-btn"><Icon name="x" size={14} /></PaneClose></div>{md ? <TocPanel key={current ?? 'empty'} toc={toc} onJump={jumpToHeading} /> : fileInfo}<div className="kw-side-section"><b>本人资料管理</b><p>不受 AI 项目授权有无限制；授权只控制 AI 只读检索，不授予写入或执行。</p><button className="btn sm" disabled={!library} onClick={() => setGrantOpen(true)}><Icon name="shield" size={14} />AI 授权管理</button><KnowledgeIndexStatus libraryId={libId} visible={visible} disabled={ownerDisabled} onPublished={indexPublished} /></div><p className="kw-safety-note">正文不自动加载外链图片或本地资源。目录盘点与正文索引分别处理；Office / PDF 解析能力按实际后端反馈。</p></aside>
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
