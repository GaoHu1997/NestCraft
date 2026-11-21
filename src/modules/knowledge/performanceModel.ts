import type { KnowledgeDirectoryPage, KnowledgeEntry, KnowledgeTask } from '@/api/knowledge-performance';

export function allocateHeadingIds(texts: string[], reserved: string[] = []): string[] {
  const used = new Set(reserved), counts = new Map<string, number>(), ids: string[] = [];
  for (const text of texts) {
    const stem = 'h-' + text.trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 60);
    const base = stem === 'h-' ? `h-section-${ids.length}` : stem;
    let count = counts.get(stem) ?? 0, id = count ? `${base}-${count}` : base;
    while (used.has(id)) id = `${base}-${++count}`;
    counts.set(stem, count + 1); used.add(id); ids.push(id);
  }
  return ids;
}

export function visibleRange(total: number, scrollTop: number, viewportHeight: number, rowHeight: number, overscan = 5): { start: number; end: number; offset: number } {
  const maxScroll = Math.max(0, total * rowHeight - viewportHeight);
  const top = Math.min(Math.max(0, scrollTop), maxScroll);
  const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((top + viewportHeight) / rowHeight) + overscan);
  return { start, end: Math.max(start, end), offset: start * rowHeight };
}

export interface DirectoryPageState {
  ids: string[]; cursor: string | null; revision: string; state: 'pending' | 'ready' | 'failed';
  loading: boolean; error: string | null; taskId: string | null; task: KnowledgeTask | null; request: number;
}
export type DirectoryRow = { key: string; parentId: string; depth: number; entry?: KnowledgeEntry; kind: 'entry' | 'more' | 'status' };

/** Page mutations touch only one parent and its returned entities; scrolling never rebuilds this projection. */
export class DirectoryModel {
  readonly entries = new Map<string, KnowledgeEntry>();
  readonly pages = new Map<string, DirectoryPageState>();
  readonly parents = new Map<string, string>();
  readonly expanded = new Set<string>();
  scrollTop = 0;
  version = 0;
  page(parentId: string): DirectoryPageState {
    let page = this.pages.get(parentId);
    if (!page) { page = { ids: [], cursor: null, revision: '', state: 'pending', loading: false, error: null, taskId: null, task: null, request: 0 }; this.pages.set(parentId, page); }
    return page;
  }
  begin(parentId: string) { const page = this.page(parentId); page.loading = true; page.error = null; this.version++; return ++page.request; }
  accept(parentId: string, request: number, result: KnowledgeDirectoryPage, append: boolean): boolean {
    const page = this.page(parentId);
    if (page.request !== request) return false;
    page.loading = false;
    if (append && page.revision && page.revision !== result.directoryRevision) {
      page.error = '目录已变化，请刷新此目录后继续。当前选择保留。'; page.cursor = null; this.version++; return false;
    }
    const ids = append ? [...page.ids] : [];
    const seen = new Set(ids);
    for (const entry of result.items) {
      if (!entry.id || !entry.noteId || typeof entry.relativeUri !== 'string') throw new Error('目录项身份不完整');
      this.entries.set(entry.id, entry); this.parents.set(entry.id, parentId);
      if (!seen.has(entry.id)) { seen.add(entry.id); ids.push(entry.id); }
    }
    // Pending rescans retain the previous complete directory until the new snapshot is ready.
    if (result.scanState === 'ready') {
      if (!append) for (const oldId of page.ids) if (!seen.has(oldId) && result.complete) this.removeSubtree(oldId);
      page.ids = ids;
    }
    page.cursor = result.nextCursor; page.revision = result.directoryRevision;
    page.state = result.scanState; page.error = result.error; page.taskId = result.taskId;
    this.version++; return true;
  }
  fail(parentId: string, request: number, error: string) {
    const page = this.page(parentId); if (page.request !== request) return;
    page.loading = false; page.error = error; this.version++;
  }
  removeSubtree(id: string) {
    const page = this.pages.get(id);
    if (page) for (const child of page.ids) this.removeSubtree(child);
    this.pages.delete(id); this.expanded.delete(id); this.entries.delete(id); this.parents.delete(id);
  }
  invalidateRequests() { for (const page of this.pages.values()) { page.request++; page.loading = false; } this.version++; }
  rows(): DirectoryRow[] {
    const rows: DirectoryRow[] = [];
    const visit = (parentId: string, depth: number, ancestors: Set<string>) => {
      if (depth > 32 || ancestors.has(parentId)) return;
      const page = this.pages.get(parentId); if (!page) return;
      const nextAncestors = new Set(ancestors); nextAncestors.add(parentId);
      for (const id of page.ids) {
        const entry = this.entries.get(id); if (!entry) continue;
        rows.push({ key: id, kind: 'entry', entry, parentId, depth });
        if (entry.isDir && this.expanded.has(id)) visit(id, depth + 1, nextAncestors);
      }
      if (page.error || page.loading || page.state !== 'ready' || !page.ids.length) rows.push({ key: `status:${parentId}`, kind: 'status', parentId, depth });
      if (page.cursor && !page.loading && !page.error) rows.push({ key: `more:${parentId}`, kind: 'more', parentId, depth });
    };
    visit('', 0, new Set()); return rows;
  }
}

/** Shared across libraries, estimated retained UTF-16/base64 weight rather than file count. */
export class ByteLru<T> {
  private readonly values = new Map<string, { value: T; bytes: number }>();
  bytes = 0;
  constructor(public budget: number, private readonly protectedKey: (key: string) => boolean = () => false, private readonly onEvict: (key: string) => void = () => {}) {}
  get(key: string): T | undefined { const item = this.values.get(key); if (!item) return undefined; this.values.delete(key); this.values.set(key, item); return item.value; }
  set(key: string, value: T, bytes: number): boolean {
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error('Invalid cache byte weight');
    this.delete(key);
    if (bytes > this.budget && this.protectedKey(key)) return false;
    this.values.set(key, { value, bytes }); this.bytes += bytes; this.trim();
    if (this.bytes > this.budget && this.protectedKey(key)) { this.delete(key); return false; }
    return true;
  }
  delete(key: string) { const old = this.values.get(key); if (!old) return; this.bytes -= old.bytes; this.values.delete(key); }
  trim() { this.trimTo(this.budget); }
  /** Evict unprotected clean entries down to an explicit limit (retention after draft/DOM reservations). */
  trimTo(limit: number) {
    const target = Math.max(0, Number.isFinite(limit) ? limit : 0);
    for (const [key, entry] of this.values) {
      if (this.bytes <= target) break;
      if (this.protectedKey(key)) continue;
      this.values.delete(key); this.bytes -= entry.bytes; this.onEvict(key);
    }
  }
  has(key: string) { return this.values.has(key); }
  /** Bytes the ledger could reclaim without touching current/dirty documents. */
  evictableBytes() {
    let total = 0;
    for (const [key, entry] of this.values) if (!this.protectedKey(key)) total += entry.bytes;
    return total;
  }
  get size() { return this.values.size; }
}

/**
 * R02 retention ledger. The three classes share one budget; drafts and the mounted DOM are reserved
 * before clean files, because they are either unsaved user work or already rendered.
 * Estimates are deltas in UTF-16/base64 retention, not measured browser pixels or process RSS.
 */
export interface RetentionLedger {
  cleanBytes: number;
  /** All draft title/body retention, including saved-but-clean drafts that can be released. */
  draftBytes: number;
  /** Estimated mounted DOM for the document currently displayed. */
  domBytes: number;
  budgetBytes: number;
}
export interface RetentionAdmission extends RetentionLedger {
  incomingBytes: number;
  /** Budget left for clean files after reserving drafts and mounted DOM. */
  cleanTargetBytes: number;
  evictCleanBytes: number;
  evictDraftBytes: number;
  totalBytes: number;
  admit: boolean;
  pressure: boolean;
}
/** Title/body UTF-16 units plus a fixed metadata allowance per draft (map entry, hashes, flags). */
export function draftRetentionBytes(title: string, body: string): number {
  return 512 + 2 * (title.length + body.length);
}
/**
 * Conservative DOM estimate: one block wrapper (~512 B), one element/node (~96 B) and the retained
 * HTML string (2 B per UTF-16 unit). Assumption only; real DOM/process memory is not measured.
 */
export function domRetentionBytes(blocks: number, nodes: number, htmlChars: number): number {
  const n = (value: number) => Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
  return n(blocks) * 512 + n(nodes) * 96 + n(htmlChars) * 2;
}
export function retentionTotal(ledger: RetentionLedger): number {
  return Math.max(0, ledger.cleanBytes) + Math.max(0, ledger.draftBytes) + Math.max(0, ledger.domBytes);
}
/**
 * R02 admission order: trim clean files first, then release saved-and-clean drafts, and only then
 * refuse with pressure feedback. Unsaved/dirty drafts are never evictable, so they stay in the ledger.
 */
export function planRetentionAdmission(input: RetentionLedger & { incomingBytes: number; evictableCleanBytes: number; evictableDraftBytes: number }): RetentionAdmission {
  const budget = Math.max(0, input.budgetBytes || 0);
  const clean = Math.max(0, input.cleanBytes || 0);
  const drafts = Math.max(0, input.draftBytes || 0);
  const dom = Math.max(0, input.domBytes || 0);
  const incoming = Math.max(0, input.incomingBytes || 0);
  const evictableDrafts = Math.min(drafts, Math.max(0, input.evictableDraftBytes || 0));
  const reservedDrafts = drafts - evictableDrafts;
  // Only unsaved/dirty drafts (and the mounted DOM) are truly non-evictable for the clean budget;
  // saved clean drafts are released in the second step if clean files cannot cover the gap.
  const cleanTarget = Math.max(0, budget - reservedDrafts - dom - incoming);
  const cleanFreed = Math.min(Math.max(0, input.evictableCleanBytes || 0), Math.max(0, clean - cleanTarget));
  const afterClean = clean - cleanFreed + reservedDrafts + dom + incoming;
  const draftFreed = Math.min(evictableDrafts, Math.max(0, afterClean + evictableDrafts - budget));
  const totalBytes = afterClean + evictableDrafts - draftFreed;
  const admit = totalBytes <= budget;
  return { cleanBytes: clean - cleanFreed, draftBytes: drafts - draftFreed, domBytes: dom, budgetBytes: budget, incomingBytes: incoming, cleanTargetBytes: cleanTarget, evictCleanBytes: cleanFreed, evictDraftBytes: draftFreed, totalBytes, admit, pressure: !admit };
}

/** R03: resolve an arbitrary directory URI to a loaded entry without assuming it is on the current page. */
export function normalizeRelativeUri(uri: string): string {
  return uri.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}
export function directoryPathSegments(uri: string): string[] {
  return normalizeRelativeUri(uri).split('/').filter(Boolean);
}
export function directoryUriAt(segments: string[], index: number): string {
  return segments.slice(0, index + 1).join('/');
}
export function findDirectoryId(entries: Iterable<{ id: string; isDir: boolean; relativeUri: string }>, uri: string): string | null {
  const target = normalizeRelativeUri(uri).toLocaleLowerCase();
  for (const entry of entries) if (entry.isDir && normalizeRelativeUri(entry.relativeUri).toLocaleLowerCase() === target) return entry.id;
  return null;
}

/** R05: rows that may receive keyboard lead; status text is not a treeitem. */
export interface LeadRow { key: string; kind: 'entry' | 'more' | 'status'; }
/**
 * R05 stable lead resolution by node key, never by index. When the previous lead disappeared
 * (delete/reorder/refresh), map to the nearest focusable row around its old index.
 */
export function resolveTreeLead(rows: LeadRow[], leadKey: string, previousIndex: number): { index: number; key: string } | null {
  if (!rows.length) return null;
  const direct = rows.findIndex(row => row.key === leadKey && row.kind !== 'status');
  if (direct >= 0) return { index: direct, key: rows[direct].key };
  const start = Math.min(rows.length - 1, Math.max(0, Number.isFinite(previousIndex) ? previousIndex : 0));
  for (let distance = 0; distance < rows.length; distance++) {
    for (const index of distance ? [start - distance, start + distance] : [start]) {
      if (index >= 0 && index < rows.length && rows[index].kind !== 'status') return { index, key: rows[index].key };
    }
  }
  return null;
}

/** R08: a shorter document/heading list must clamp the old TOC lead instead of keeping a dead index. */
export function clampTocLead(total: number, lead: number): number {
  if (!Number.isFinite(total) || total <= 0) return -1;
  const value = Number.isFinite(lead) ? Math.floor(lead) : 0;
  return Math.min(Math.ceil(total) - 1, Math.max(0, value));
}
export function tocMoveTarget(total: number, lead: number, delta: number): number {
  const current = clampTocLead(total, lead);
  if (current < 0) return -1;
  return clampTocLead(total, current + (Number.isFinite(delta) ? delta : 0));
}
/** Scroll offset that guarantees a moved-to heading enters the virtual window (mounted before focus). */
export function tocScrollTarget(total: number, index: number, viewportHeight: number, rowHeight = 28): number {
  const lead = clampTocLead(total, index);
  if (lead < 0) return 0;
  const max = Math.max(0, total * rowHeight - viewportHeight);
  return Math.min(Math.max(0, lead * rowHeight - viewportHeight / 2), max);
}

/** R03: clean bodies must be re-read when the directory reports a different source revision. */
export type SourceRevisionAction = 'none' | 'reload' | 'drop-clean-draft' | 'warn-dirty';
export interface RevisionDraftLike {
  noteId: string | null; title: string; baseTitle: string; body: string; baseBody: string;
  sourceRevision?: string | null;
}
export function sourceRevisionDecision(draft: RevisionDraftLike | undefined, selectedRevision: string | undefined): SourceRevisionAction {
  if (!selectedRevision) return 'none';
  if (!draft) return 'reload';
  if (!draft.noteId) return 'none';
  if (draft.sourceRevision == null) return 'none';
  if (draft.sourceRevision === selectedRevision) return 'none';
  return draft.title !== draft.baseTitle || draft.body !== draft.baseBody ? 'warn-dirty' : 'drop-clean-draft';
}

/**
 * UI-CR055-FEAT009-v1.4：原件外部变化（external-change）与所选文件已不存在（selection-gone）的
 * 提示与动作模型。文案是可视稿唯一基线，界面只消费这里的常量，避免两套文案。
 */
export type ReaderNoticeActionId = 'reload-original' | 'refresh-directory';
export interface ReaderNoticeAction {
  id: ReaderNoticeActionId;
  label: string;
  /** true 表示必须先二次确认再执行，绝不静默丢弃未保存草稿。 */
  confirm: boolean;
}
export interface ReaderNotice { kind: 'external-change' | 'selection-gone'; text: string; action: ReaderNoticeAction }
export const EXTERNAL_CHANGE_TEXT = '原件已在外部变化，当前未保存草稿保留；保存时会提示版本冲突。';
export const SELECTION_GONE_TEXT = '所选文件已不存在；不会跳到其它文件或清除草稿。';
export const RELOAD_ORIGINAL_LABEL = '放弃草稿并重新读取';
export const REFRESH_DIRECTORY_LABEL = '刷新目录';
/** 只有「原件已变化且草稿有未保存修改」才提供放弃草稿并重新读取的入口。 */
export function externalChangeNotice(draft: RevisionDraftLike | undefined, selectedRevision: string | undefined): ReaderNotice | null {
  if (sourceRevisionDecision(draft, selectedRevision) !== 'warn-dirty') return null;
  return { kind: 'external-change', text: EXTERNAL_CHANGE_TEXT, action: { id: 'reload-original', label: RELOAD_ORIGINAL_LABEL, confirm: true } };
}
/** 目录已刷新但仍定位不到所选文件：只提示并给出刷新入口，不跳到其它文件、不清理草稿。 */
export function selectionGoneNotice(): ReaderNotice {
  return { kind: 'selection-gone', text: SELECTION_GONE_TEXT, action: { id: 'refresh-directory', label: REFRESH_DIRECTORY_LABEL, confirm: false } };
}
/** 二次确认期间草稿又被编辑时不得释放：只有内容仍与确认快照一致才允许放弃。 */
export function draftReleaseConfirmed(snapshot: { title: string; body: string }, draft: { title: string; body: string }): boolean {
  return snapshot.title === draft.title && snapshot.body === draft.body;
}

/** R03: merge one loaded page and drop known entries that are no longer reachable. */
export interface KnownNodeLike { noteId: string; relativeUri: string; }
export interface KnownNodeMeta { parentUri?: string; external?: boolean; }
export function reconcileKnownEntries<T extends KnownNodeLike>(
  known: Map<string, T & KnownNodeMeta>,
  update: { parentUri: string; entries: T[]; complete: boolean },
  options: { keep: ReadonlySet<string>; reachable: ReadonlySet<string>; rootComplete: boolean },
): string[] {
  const removed: string[] = [];
  const fresh = new Set(update.entries.map(entry => entry.noteId));
  for (const entry of update.entries) {
    const previous = known.get(entry.noteId);
    known.set(entry.noteId, { ...(previous ?? {}), ...entry, parentUri: update.parentUri, external: false } as T & KnownNodeMeta);
  }
  const drop = (id: string) => { if (known.delete(id)) removed.push(id); };
  if (update.complete) {
    for (const [id, node] of known) {
      if (options.keep.has(id)) continue;
      if (node.parentUri === update.parentUri && !fresh.has(id)) drop(id);
    }
  }
  // Unreachable entries from pages that were removed are stale; keep the current file/drafts and
  // deep-link/search nodes only until a complete root refresh proves they no longer exist.
  for (const [id, node] of known) {
    if (options.keep.has(id) || options.reachable.has(id)) continue;
    if (node.external && !options.rootComplete) continue;
    drop(id);
  }
  return removed;
}
