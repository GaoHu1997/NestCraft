import type { KnowledgeFileData, KnowledgeFileInfo, NoteNode } from "@/api";
import { renderMarkdown } from "@/components/ui";
import { ByteLru, DirectoryModel, domRetentionBytes, draftRetentionBytes, planRetentionAdmission } from './performanceModel';

/** UI-CR045-v1：仅当前进程的库/文档草稿与阅读偏好；不是数据库或自动保存。 */
export interface KnowledgeDraft {
  editorKey?: string;
  key: string;
  noteId: string | null;
  parent: string;
  title: string;
  body: string;
  baseTitle: string;
  baseBody: string;
  expectedHash: string | null;
  /** Directory source revision this draft was opened/saved against; undefined means not bound yet. */
  sourceRevision?: string | null;
  mode: "read" | "edit";
  saving: boolean;
  error: string;
  conflict: boolean;
  latest?: KnowledgeFileData;
  latestError?: string;
}
/** R02: estimated retained DOM for the document currently mounted (not a pixel/process measurement). */
export interface KnowledgeDocumentRetention { id: string; blocks: number; nodes: number; htmlChars: number; bytes: number; }
export interface KnowledgeSession {
  id: string;
  visible: boolean;
  directory: DirectoryModel;
  current: string | null;
  selectedFolder: string;
  drafts: Map<string, KnowledgeDraft>;
  files: Map<string, KnowledgeFileData>;
  collapsed: Set<string>;
  scroll: Map<string, number>;
  folderInput: { key: string; parent: string; name: string; error: string; saving: boolean } | null;
  notice: string;
  cachePressure: boolean;
  documentRetention: KnowledgeDocumentRetention | null;
}
const DEFAULT_CACHE_BUDGET = 128 * 1024 * 1024;
let cacheBudget = DEFAULT_CACHE_BUDGET;
const sessions = new Map<string, KnowledgeSession>();
let cacheEvictions = 0;
/** UI-CR055-FEAT009-v1.4：缓存压力文案唯一来源，常驻压力横幅与准入拒绝提示共用同一句。 */
export const CACHE_PRESSURE_NOTICE = "阅读缓存已达预算；清洁正文和已保存且无修改的草稿可回收，未保存草稿保留。请先关闭不需要的清洁文档后重试。";
const cacheKey = (session: KnowledgeSession, id: string) => JSON.stringify([session.id, id]);
/** Current document and dirty/unsaved drafts are not reclaimable, so their cached source stays pinned. */
function protectedClean(session: KnowledgeSession, id: string): boolean {
  if (session.visible && session.current === id) return true;
  for (const draft of session.drafts.values()) {
    if (draft.noteId === id && (draft.key === session.current || dirty(draft))) return true;
  }
  return false;
}
const cleanCache = new ByteLru<KnowledgeFileData>(cacheBudget, key => {
  const [libraryId, id] = JSON.parse(key) as [string, string];
  const session = sessions.get(libraryId);
  return !!session && protectedClean(session, id);
}, key => {
  const [libraryId, id] = JSON.parse(key) as [string, string];
  sessions.get(libraryId)?.files.delete(id); cacheEvictions++;
});
export function draftBytesOf(session: KnowledgeSession): number {
  let total = 0;
  for (const draft of session.drafts.values()) total += draftRetentionBytes(draft.title, draft.body);
  return total;
}
/** Saved drafts without unsaved edits may be released; unsaved or dirty drafts never are. */
export function evictableDraftBytesOf(session: KnowledgeSession): number {
  let total = 0;
  for (const draft of session.drafts.values()) {
    if (!draft.noteId || dirty(draft) || draft.key === session.current) continue;
    total += draftRetentionBytes(draft.title, draft.body);
  }
  return total;
}
export function evictCleanDrafts(session: KnowledgeSession, maxBytes: number): number {
  let freed = 0;
  for (const [key, draft] of [...session.drafts]) {
    if (freed >= maxBytes) break;
    if (!draft.noteId || dirty(draft) || draft.key === session.current) continue;
    session.drafts.delete(key);
    freed += draftRetentionBytes(draft.title, draft.body);
  }
  return freed;
}
function cleanTargetFor(session: KnowledgeSession): number {
  return Math.max(0, cacheBudget - draftBytesOf(session) - (session.documentRetention?.bytes ?? 0));
}
/** R02 admission draws on the same ledger as clean files and trims clean bodies before refusing. */
export function canAdmitKnowledgeFile(session: KnowledgeSession, id: string, bytes: number): boolean {
  const key = cacheKey(session, id);
  if (cleanCache.has(key)) return true;
  if (!Number.isFinite(bytes) || bytes < 0) return false;
  const plan = planRetentionAdmission({
    cleanBytes: cleanCache.bytes, draftBytes: draftBytesOf(session), domBytes: session.documentRetention?.bytes ?? 0,
    budgetBytes: cacheBudget, incomingBytes: bytes,
    evictableCleanBytes: cleanCache.evictableBytes(), evictableDraftBytes: evictableDraftBytesOf(session),
  });
  if (plan.evictCleanBytes > 0) cleanCache.trimTo(plan.cleanTargetBytes);
  if (plan.evictDraftBytes > 0) evictCleanDrafts(session, plan.evictDraftBytes);
  // Re-check actual retained bytes: protected entries may not be reclaimable in the planned amount.
  const total = cleanCache.bytes + draftBytesOf(session) + (session.documentRetention?.bytes ?? 0);
  const admitted = plan.admit && total + bytes <= cacheBudget;
  session.cachePressure = !admitted || total > cacheBudget;
  if (!admitted) session.notice = CACHE_PRESSURE_NOTICE;
  return admitted;
}
export function cacheKnowledgeFile(session: KnowledgeSession, id: string, data: KnowledgeFileData): boolean {
  const infoWeight = (data.info.title.length + data.info.relativeUri.length + data.info.noteId.length) * 2 + 1024;
  const weight = infoWeight + 2 * (data.text?.length ?? 0) + 2 * (data.base64?.length ?? 0);
  const accepted = cleanCache.set(cacheKey(session, id), data, weight);
  if (accepted) { session.files.set(id, data); trimKnowledgeCache(session); }
  else session.files.delete(id);
  session.cachePressure = !accepted || cleanCache.bytes + draftBytesOf(session) + (session.documentRetention?.bytes ?? 0) > cacheBudget;
  return accepted;
}
export function getKnowledgeFile(session: KnowledgeSession, id: string): KnowledgeFileData | undefined {
  return cleanCache.get(cacheKey(session, id)) ?? session.files.get(id);
}
export function trimKnowledgeCache(session?: KnowledgeSession): void {
  if (!session) { cleanCache.trimTo(cacheBudget); return; }
  cleanCache.trimTo(cleanTargetFor(session));
  session.cachePressure = cleanCache.bytes + draftBytesOf(session) + (session.documentRetention?.bytes ?? 0) > cacheBudget;
}
/** R02: record the mounted document's conservative DOM estimate; null releases it on unmount. */
export function recordKnowledgeDocumentRetention(session: KnowledgeSession, id: string, info: { blocks: number; nodes: number; htmlChars: number } | null): void {
  const bytes = info ? domRetentionBytes(info.blocks, info.nodes, info.htmlChars) : 0;
  if (info && bytes > 0) session.documentRetention = { id, blocks: info.blocks, nodes: info.nodes, htmlChars: info.htmlChars, bytes };
  else if (session.documentRetention?.id === id) session.documentRetention = null;
  trimKnowledgeCache(session);
}
export function clearKnowledgeDocumentRetention(session: KnowledgeSession): void {
  if (!session.documentRetention) return;
  session.documentRetention = null;
  trimKnowledgeCache(session);
}
export function knowledgeCacheStats(session?: KnowledgeSession) {
  const active = session ? [session] : [...sessions.values()];
  const draftBytes = active.reduce((total, item) => total + draftBytesOf(item), 0);
  const domBytes = active.reduce((total, item) => total + (item.documentRetention?.bytes ?? 0), 0);
  const cleanBytes = cleanCache.bytes;
  const totalBytes = cleanBytes + draftBytes + domBytes;
  return { estimatedBytes: cleanBytes, cleanBytes, draftBytes, domBytes, totalBytes, budgetBytes: cacheBudget, evictions: cacheEvictions, pressure: totalBytes > cacheBudget };
}
/** Test/diagnostic hook: verify admission without allocating a full 128 MiB fixture. */
export function configureKnowledgeCacheBudget(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error("知识缓存预算必须是正数");
  cacheBudget = Math.floor(bytes);
  cleanCache.budget = cacheBudget;
  cleanCache.trimTo(cacheBudget);
  return cacheBudget;
}
let serial = 0;
export function nextDraftKey(): string { return `local-draft:${++serial}`; }
export function knowledgeSession(id: string): KnowledgeSession {
  let session = sessions.get(id);
  if (!session) {
    session = { id, visible: false, directory: new DirectoryModel(), current: null, selectedFolder: "", drafts: new Map(), files: new Map(), collapsed: new Set(), scroll: new Map(), folderInput: null, notice: "", cachePressure: false, documentRetention: null };
    sessions.set(id, session);
  }
  return session;
}
export function fileType(uri: string): string {
  return /\.([a-z0-9]+)$/i.exec(uri.replace(/\\/g, "/"))?.[1].toLowerCase() ?? "unknown";
}
export function isMarkdown(uri: string): boolean { return /\.(md|markdown)$/i.test(uri); }
export function parentOf(uri: string): string { return uri.replace(/\\/g, "/").split("/").slice(0, -1).join("/"); }
export function markdownName(name: string): string { return isMarkdown(name) ? name : `${name}.md`; }
export function nameError(name: string): string {
  if (!name.trim()) return "名称不能为空。";
  if (name !== name.trim()) return "名称首尾不能有空白，输入已保留。";
  if (name.length > 120) return "名称不能超过 120 个字符。";
  if (/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name) || name === "." || name === ".." || /[. ]$/.test(name)) return "不能含路径分隔符、保留符号或末尾点号。";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return "这是系统保留名称，请更换。";
  return "";
}
export function dirty(draft: KnowledgeDraft): boolean { return !draft.noteId || draft.title !== draft.baseTitle || draft.body !== draft.baseBody; }
/** Accept only the submitted revision; edits made while saving remain unsaved. */
export function acceptSavedMarkdown(
  draft: KnowledgeDraft,
  submitted: { title: string; body: string },
  saved: { noteId: string; relativeUri: string; title: string; content: string; hash?: string },
): boolean {
  const bodyChanged = draft.body !== submitted.body;
  const titleChanged = draft.title !== submitted.title;
  draft.noteId = saved.noteId; draft.key = saved.noteId; draft.parent = parentOf(saved.relativeUri);
  draft.baseBody = saved.content; draft.baseTitle = saved.title; draft.expectedHash = saved.hash ?? null;
  // The save itself changes the source revision; rebind only after the directory reports it.
  draft.sourceRevision = undefined;
  if (!bodyChanged) draft.body = saved.content;
  if (!titleChanged) draft.title = saved.title;
  draft.error = ""; draft.conflict = false; draft.latest = undefined; draft.latestError = undefined;
  return bodyChanged || titleChanged;
}
export function flattenTree(nodes: NoteNode[]): NoteNode[] {
  return nodes.flatMap(node => [node, ...flattenTree(node.children)]);
}
export function findNode(nodes: NoteNode[], id: string): NoteNode | null {
  for (const node of nodes) { if (node.noteId === id) return node; const found = findNode(node.children, id); if (found) return found; }
  return null;
}
export function expandParents(session: KnowledgeSession, nodes: NoteNode[], id: string): boolean {
  for (const node of nodes) {
    if (node.noteId === id) return true;
    if (expandParents(session, node.children, id)) { session.collapsed.delete(node.noteId); return true; }
  }
  return false;
}
export function pathTaken(nodes: NoteNode[], parent: string, name: string): boolean {
  const normalize = (path: string) => path.replace(/\\/g, "/").normalize("NFC").toLocaleLowerCase();
  const target = normalize(parent ? `${parent}/${name}` : name);
  return flattenTree(nodes).some(node => normalize(node.relativeUri) === target);
}
export function checkFileIdentity(info: KnowledgeFileInfo, node: NoteNode): void {
  if (info.noteId !== node.noteId || info.relativeUri.replace(/\\/g, "/") !== node.relativeUri.replace(/\\/g, "/")) throw new Error("返回的文件身份与所选文件不一致");
}
export function readableKind(info: KnowledgeFileInfo): boolean {
  if (!info.previewSupported) return false;
  if (info.kind === "markdown") return isMarkdown(info.relativeUri);
  if (info.kind === "text") return /\.(txt|text|json|csv|log|yaml|yml)$/i.test(info.relativeUri);
  return info.kind === "image" && /\.(png|jpe?g|gif|webp)$/i.test(info.relativeUri);
}
/** 仅允许受检光栅图的真实字节；不接受 SVG、URL 或 MIME/文件头不匹配。 */
export function safeImageSource(info: KnowledgeFileInfo, base64: string | undefined): string {
  const expected: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  const mime = expected[fileType(info.relativeUri)];
  if (info.kind !== "image" || !mime || info.mime !== mime || !base64) throw new Error("图片格式、MIME 或原件数据不完整，不能预览");
  if (base64.length > Math.ceil(25 * 1024 * 1024 / 3) * 4 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("图片 base64 无效或超过 25 MiB");
  const prefix = atob(base64.slice(0, 32));
  const byte = (i: number) => prefix.charCodeAt(i);
  const matches = mime === "image/png" ? [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => byte(i) === n)
    : mime === "image/jpeg" ? byte(0) === 255 && byte(1) === 216 && byte(2) === 255
    : mime === "image/gif" ? /^(GIF87a|GIF89a)/.test(prefix)
    : prefix.slice(0, 4) === "RIFF" && prefix.slice(8, 12) === "WEBP";
  if (!matches) throw new Error("图片原件头与 MIME 不一致，已拒绝预览");
  return `data:${mime};base64,${base64}`;
}
/** 单独限制知识正文资源：不会自动请求外链图片或执行 HTML/脚本/本地资源。 */
export function renderKnowledgeMarkdown(text: string): Promise<string> {
  return renderMarkdown(text, { restrictResources: true });
}
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}
export function isConflict(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return /conflict|hash.*(?:mismatch|changed)|版本.*(?:改变|冲突)|外部.*修改|基线/i.test(`${code} ${errorText(error)}`);
}
