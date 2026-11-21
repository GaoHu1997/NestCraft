import { invoke } from "./index";

export interface DirectoryEntry { name: string; path: string; isDir: boolean; size: number | null }
export interface DirectoryPage { items: DirectoryEntry[]; nextCursor: string | null; directoryRevision: string; complete: boolean }
export interface SearchHit { path: string; lineNo: number; lineText: string }
export interface SearchPoll { batches: { seq: number; hits: SearchHit[] }[]; status: "running" | "done" | "cancelled"; error: string | null; files: number; bytes: number; skipped: number; limited: boolean }
export interface DocumentInfo { docId: string; revision: string; sizeBytes: string; encoding: string; initialCursor: string }
export interface WindowData { text: string; nextCursor: string | null; eof: boolean; sourceStartByte: string; sourceEndByte: string; canonicalStartByte: string; canonicalEndByte: string; sourceHash: string | null }
export type SavePhase = "staging" | "sealed" | "committing" | "durability" | "committed" | "cancelled" | "failed" | "needs_recovery";
export interface SaveStatus { requestId: string; submittedRevision: string; phase: SavePhase | string; nextSeq: number; writtenBytes: string; sourceHash: string | null; sourceBytes: string | null; committedRevision: string | null; cancelTooLate: boolean; needsRecovery: boolean; error: string | null }
export const directoryPage = (rootUri: string, relPath: string, cursor: string | null = null) => invoke<DirectoryPage>("fs_perf_dir_page", { rootUri, relPath, cursor, limit: 200 });
export const searchStart = (rootUri: string, query: string, requestId: string) => invoke<void>("fs_perf_search_start", { rootUri, query, requestId });
export const searchPoll = (rootUri: string, requestId: string, ackSeq: number | null) => invoke<SearchPoll>("fs_perf_search_poll", { rootUri, requestId, ackSeq });
export const cancel = (rootUri: string, requestId: string) => invoke<boolean>("fs_perf_cancel", { rootUri, requestId });
export const openDocument = (rootUri: string, path: string) => invoke<DocumentInfo>("fs_perf_open_document", { rootUri, path });
export const readWindow = (rootUri: string, docId: string, revision: string, cursor: string) => invoke<WindowData>("fs_perf_read_window", { rootUri, docId, revision, cursor });
export const closeDocument = (rootUri: string, docId: string) => invoke<void>("fs_perf_close_document", { rootUri, docId });
export const saveBegin = (rootUri: string, path: string, requestId: string, submittedRevision: string, expectedHash: string, encoding: string, totalBytes: string, submittedHash: string) => invoke<SaveStatus>("fs_perf_save_begin_v2", { rootUri, path, requestId, submittedRevision, expectedHash, encoding, totalBytes, submittedHash });
export const saveAppend = (rootUri: string, requestId: string, seq: number, text: string) => invoke<SaveStatus>("fs_perf_save_append_v2", { rootUri, requestId, seq, text });
export const saveSeal = (rootUri: string, requestId: string, expectedChunks: number) => invoke<SaveStatus>("fs_perf_save_seal_v2", { rootUri, requestId, expectedChunks });
export const saveCommit = (rootUri: string, requestId: string) => invoke<SaveStatus>("fs_perf_save_commit_v2", { rootUri, requestId });
export const saveStatus = (rootUri: string, requestId: string) => invoke<SaveStatus>("fs_perf_save_status_v2", { rootUri, requestId });
export const saveAbort = (rootUri: string, requestId: string) => invoke<SaveStatus>("fs_perf_save_abort_v2", { rootUri, requestId });
export const releaseSave = (rootUri: string, requestId: string) => invoke<void>("fs_perf_save_release_v2", { rootUri, requestId });
