import { Text } from "@codemirror/state";
import * as perf from "@/api/editor-performance";
import { StreamingSha256, sourceBom, sourceBytes } from "./streaming-sha256";
export interface LoadedDocument { doc: Text; hash: string; encoding: string; lineEnding: string; mixedLineEndings: boolean; endings: Text; sizeBytes: number }
export class TextBuilder {
  doc = Text.empty;
  endingMap = Text.empty;
  private pendingCR = false;
  private endings = new Set<string>();
  append(text: string, eof = false): void {
    if (this.pendingCR) { text = `\r${text}`; this.pendingCR = false; }
    if (!eof && text.endsWith("\r")) { text = text.slice(0, -1); this.pendingCR = true; }
    let codes = "";
    const normalized = text.replace(/\r\n|\r|\n/g, ending => { this.endings.add(ending); codes += ending === "\r\n" ? "C" : ending === "\r" ? "R" : "L"; return "\n"; });
    this.endingMap = this.endingMap.append(Text.of([...codes, ""]));
    this.doc = this.doc.append(Text.of(normalized.split("\n")));
  }
  get lineEnding(): string { return this.endings.values().next().value ?? "\n"; }
  get mixedLineEndings(): boolean { return this.endings.size > 1; }
}
export async function loadDocument(root: string, path: string, valid: () => boolean, progress: (bytes: number, total: number) => void, admit: (bytes: number) => void): Promise<LoadedDocument | { windowOnly: true }> {
  const info = await perf.openDocument(root, path);
  try {
    const size = Number(info.sizeBytes);
    // GB-level files use the user-authorized window path. Ordinary and 100MiB code remain editable.
    if (size >= 1024 * 1024 * 1024) return { windowOnly: true };
    admit(size);
    if (!valid()) throw new Error("OPEN_CANCELLED");
    const builder = new TextBuilder(); let cursor = info.initialCursor; let hash: string | null = null; let chunks = 0;
    for (;;) {
      if (!valid()) throw new Error("OPEN_CANCELLED");
      const page = await perf.readWindow(root, info.docId, info.revision, cursor);
      builder.append(page.text, page.eof); hash = page.sourceHash;
      if (++chunks % 16 === 0 || page.eof) { progress(Number(page.sourceEndByte), size); await new Promise(resolve => setTimeout(resolve, 0)); }
      if (page.eof) break;
      if (!page.nextCursor || page.nextCursor === cursor) throw new Error("读取游标没有前进");
      cursor = page.nextCursor;
    }
    if (!hash) throw new Error("读取未返回完整原件校验，不能进入保存路径");
    return { doc: builder.doc, hash, encoding: info.encoding, lineEnding: builder.lineEnding, mixedLineEndings: builder.mixedLineEndings, endings: builder.endingMap, sizeBytes: size };
  } finally { await perf.closeDocument(root, info.docId).catch(() => {}); }
}

export interface SaveBaseline { hash: string; encoding: string }
export interface FrozenContent { doc: Text; endings: Text }
export interface SubmissionDigest { totalBytes: string; submittedHash: string; expectedChunks: number }
export interface SaveResult<T> { snapshot: T; requestId: string; committedRevision: string; sourceHash: string; sourceBytes: string }
export type SaveTransport = Pick<typeof perf, "saveBegin" | "saveAppend" | "saveSeal" | "saveCommit" | "saveStatus" | "saveAbort" | "releaseSave">;
const SAVE_UNITS = 8192;
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Both digest and IPC replay this same immutable, bounded generator. BOM is written by begin. */
export function* frozenSaveChunks({ doc, endings }: FrozenContent, encoding: string): Generator<{ seq: number; text: string; bytes: Uint8Array }> {
  if (!["utf-8", "utf-8-bom", "utf-16le", "utf-16be"].includes(encoding)) throw new Error("ENCODING_REQUIRED");
  if (endings.length !== (doc.lines - 1) * 2) throw new Error("LINE_ENDING_MAP_INVALID");
  let newline = 0, seq = 0;
  for (let offset = 0; offset < doc.length;) {
    let end = Math.min(doc.length, offset + SAVE_UNITS);
    let chunk = doc.sliceString(offset, end);
    const last = chunk.charCodeAt(chunk.length - 1);
    if (end < doc.length && last >= 0xd800 && last <= 0xdbff) { end--; chunk = chunk.slice(0, -1); }
    // TextEncoder would silently replace lone surrogates. Reject instead, for UTF-8 and UTF-16 alike.
    for (let i = 0; i < chunk.length; i++) {
      const unit = chunk.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = chunk.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error("INVALID_UNICODE");
      } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("INVALID_UNICODE");
    }
    let count = 0;
    for (let i = 0; i < chunk.length; i++) if (chunk.charCodeAt(i) === 10) count++;
    const codes = endings.sliceString(newline * 2, (newline + count) * 2).replace(/\n/g, "");
    if (codes.length !== count || /[^LCR]/.test(codes)) throw new Error("LINE_ENDING_MAP_INVALID");
    let n = 0;
    const text = chunk.replace(/\n/g, () => { const code = codes[n++]; return code === "C" ? "\r\n" : code === "R" ? "\r" : "\n"; });
    newline += count;
    // At most 8Ki UTF-16 units + 8Ki CRs: UTF-8 IPC and encoded bytes each stay below 64KiB.
    yield { seq: seq++, text, bytes: sourceBytes(text, encoding) };
    offset = end;
  }
  if (newline !== doc.lines - 1) throw new Error("LINE_ENDING_MAP_INVALID");
}

export async function digestFrozenSave(content: FrozenContent, encoding: string, defer = yieldTask): Promise<SubmissionDigest> {
  const hash = new StreamingSha256(), bom = sourceBom(encoding);
  hash.update(bom);
  let bytes = bom.length, expectedChunks = 0;
  for (const chunk of frozenSaveChunks(content, encoding)) {
    hash.update(chunk.bytes); bytes += chunk.bytes.length; expectedChunks++;
    if (!Number.isSafeInteger(bytes)) throw new Error("SAVE_LENGTH_OVERFLOW");
    if (expectedChunks % 4 === 0) await defer();
  }
  return { totalBytes: String(bytes), submittedHash: `sha256:${hash.hex()}`, expectedChunks };
}

interface PendingSave<T> extends SubmissionDigest, FrozenContent {
  root: string; path: string; snapshot: T; baseline: SaveBaseline; requestId: string; submittedRevision: string;
}
/** An unresolved response is not a failure proof. Keep this ID and frozen state through retries. */
export class SaveUnresolvedError extends Error {
  constructor(readonly requestId: string) { super("保存失败 · 内容已保留"); }
}

/** One per Tab (including parked Tabs), not one per save attempt. No UI/undo state is mutated here. */
export class DocumentSaveSession<T> {
  private pending: PendingSave<T> | undefined;
  private running = false;
  constructor(private content: (snapshot: T) => FrozenContent, private transport: SaveTransport = perf,
    private uuid = () => crypto.randomUUID(), private defer = yieldTask) {}
  get unresolved(): boolean { return this.pending !== undefined; }
  get requestId(): string | undefined { return this.pending?.requestId; }

  async save(root: string, path: string, snapshot: T, baseline: SaveBaseline): Promise<SaveResult<T>> {
    if (this.running) throw new Error("SAVE_IN_PROGRESS");
    this.running = true;
    try {
      if (this.pending && (this.pending.root !== root || this.pending.path !== path)) throw new Error("SAVE_SCOPE");
      const retry = !!this.pending;
      if (!this.pending) {
        const content = this.content(snapshot), frozenBaseline = { hash: baseline.hash, encoding: baseline.encoding };
        const digest = await digestFrozenSave(content, frozenBaseline.encoding, this.defer);
        this.pending = { ...content, ...digest, root, path, snapshot, baseline: frozenBaseline, requestId: this.uuid(), submittedRevision: this.uuid() };
      }
      const p = this.pending;
      let beginning = !retry;
      try {
        // A retry always asks about the original ID BEFORE any begin/append/commit mutation.
        const status = retry ? await this.transport.saveStatus(root, p.requestId) : await this.transport.saveBegin(root, path,
          p.requestId, p.submittedRevision, p.baseline.hash, p.baseline.encoding, p.totalBytes, p.submittedHash);
        beginning = false;
        return await this.advance(p, status);
      } catch (error) {
        let status: perf.SaveStatus;
        try { status = await this.transport.saveStatus(root, p.requestId); }
        catch {
          // These exact begin rejections precede intent creation in v2; all other losses stay unresolved.
          if (beginning && ["BASELINE_CHANGED", "HASH_INVALID", "REQUEST_ID_INVALID", "ENCODING_REQUIRED", "SAVE_ARGUMENTS_INVALID"].includes(error instanceof Error ? error.message : String(error))) {
            this.pending = undefined; throw error;
          }
          throw new SaveUnresolvedError(p.requestId);
        }
        this.validate(p, status);
        if (status.phase === "committed" && !status.needsRecovery) return await this.acknowledge(p, status);
        if (["failed", "cancelled"].includes(status.phase) && !status.needsRecovery) {
          // Only a proven pre-commit terminal outcome permits abort/release. Neither is used for unknown.
          try {
            const aborted = await this.transport.saveAbort(root, p.requestId);
            this.validate(p, aborted);
            if (!["failed", "cancelled"].includes(aborted.phase) || aborted.needsRecovery) throw new SaveUnresolvedError(p.requestId);
          } catch { throw new SaveUnresolvedError(p.requestId); }
          this.pending = undefined;
          await this.transport.releaseSave(root, p.requestId).catch(() => {});
          throw new Error(status.error ?? "保存失败 · 内容已保留");
        }
        throw new SaveUnresolvedError(p.requestId);
      }
    } finally { this.running = false; }
  }

  private validate(p: PendingSave<T>, status: perf.SaveStatus): void {
    if (status.requestId !== p.requestId || status.submittedRevision !== p.submittedRevision ||
        !Number.isSafeInteger(status.nextSeq) || status.nextSeq < 0 || status.nextSeq > p.expectedChunks ||
        !/^(0|[1-9]\d*)$/.test(status.writtenBytes) || BigInt(status.writtenBytes) > BigInt(p.totalBytes)) throw new SaveUnresolvedError(p.requestId);
  }
  private async acknowledge(p: PendingSave<T>, status: perf.SaveStatus): Promise<SaveResult<T>> {
    this.validate(p, status);
    if (status.phase !== "committed" || status.needsRecovery || status.committedRevision !== p.submittedRevision ||
        status.sourceHash !== p.submittedHash || status.sourceBytes !== p.totalBytes || status.writtenBytes !== p.totalBytes ||
        status.nextSeq !== p.expectedChunks) throw new SaveUnresolvedError(p.requestId);
    this.pending = undefined;
    // Cleanup failure cannot undo an already proven commit or acknowledge some newer snapshot.
    await this.transport.releaseSave(p.root, p.requestId).catch(() => {});
    return { snapshot: p.snapshot, requestId: p.requestId, committedRevision: status.committedRevision, sourceHash: status.sourceHash, sourceBytes: status.sourceBytes };
  }
  private async advance(p: PendingSave<T>, initial: perf.SaveStatus): Promise<SaveResult<T>> {
    let status = initial;
    this.validate(p, status);
    if (status.phase === "committed" && !status.needsRecovery) return this.acknowledge(p, status);
    if (status.needsRecovery) throw new SaveUnresolvedError(p.requestId);
    if (status.phase === "staging") {
      const resumeSeq = status.nextSeq;
      let bytes = sourceBom(p.baseline.encoding).length;
      for (const chunk of frozenSaveChunks(p, p.baseline.encoding)) {
        if (chunk.seq >= resumeSeq) {
          if (status.phase !== "staging" || status.writtenBytes !== String(bytes) || status.nextSeq !== chunk.seq) throw new SaveUnresolvedError(p.requestId);
          status = await this.transport.saveAppend(p.root, p.requestId, chunk.seq, chunk.text);
          this.validate(p, status);
          if (status.needsRecovery || status.phase !== "staging" || status.nextSeq !== chunk.seq + 1 || status.writtenBytes !== String(bytes + chunk.bytes.length)) throw new SaveUnresolvedError(p.requestId);
        }
        bytes += chunk.bytes.length;
        if ((chunk.seq + 1) % 4 === 0) await this.defer();
      }
      if (status.nextSeq !== p.expectedChunks || status.writtenBytes !== String(bytes) || String(bytes) !== p.totalBytes) throw new SaveUnresolvedError(p.requestId);
      status = await this.transport.saveSeal(p.root, p.requestId, p.expectedChunks);
      this.validate(p, status);
    }
    if (status.phase === "sealed" && !status.needsRecovery) {
      if (status.writtenBytes !== p.totalBytes || status.nextSeq !== p.expectedChunks) throw new SaveUnresolvedError(p.requestId);
      status = await this.transport.saveCommit(p.root, p.requestId);
    }
    return this.acknowledge(p, status);
  }
}
