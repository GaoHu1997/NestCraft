import { invoke } from '@tauri-apps/api/core';
import type { KnowledgeHit } from './index';

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[];
  indexEpoch: string;
  humanOnly: true;
  coverage: { state: 'ready' | 'not_indexed'; incomplete: boolean; freshness: 'unknown'; metadataOnlyCount: number };
}
export function searchIndexed(libraryId: string, query: string, requestId: string) {
  return invoke<KnowledgeSearchResult>('kb_search_indexed', { libraryId, query, requestId });
}
export function cancelSearch(libraryId: string, requestId: string) {
  return invoke<void>('kb_search_cancel', { libraryId, requestId });
}

/** CR-055 / FEAT-008. Directory completion never means full-text indexing completed. */
export interface KnowledgeEntry {
  id: string;
  noteId: string;
  title: string;
  relativeUri: string;
  isDir: boolean;
  sizeBytes: string;
  sourceRevision: string;
  hasChildren: boolean;
}
export interface KnowledgeDirectoryPage {
  items: KnowledgeEntry[];
  directoryRevision: string;
  nextCursor: string | null;
  complete: boolean;
  scanState: 'pending' | 'ready' | 'failed';
  taskId: string | null;
  error: string | null;
}
export interface KnowledgeTask {
  id: string;
  libraryId: string;
  parentId: string;
  kind: 'directory' | 'import' | 'export';
  phase: 'queued' | 'scanning' | 'copying' | 'committing' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  processedEntries: number;
  processedBytes: string;
  totalBytes: string | null;
  cancelRequested: boolean;
  error: string | null;
  completedCoverage: 'none' | 'directory' | 'original';
  updatedAt: number;
}
export interface KnowledgeDocument {
  docId: string;
  fileId: string;
  revision: string;
  sizeBytes: string;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
  mode: 'window-readonly';
  /** Original-source byte offsets, not CodeMirror UTF-16 indices. */
  offsetSpace: 'source-byte';
  initialWindow: KnowledgeWindow;
}
export interface KnowledgeWindow {
  docId: string;
  revision: string;
  text: string;
  sourceStartByte: string;
  sourceEndByte: string;
  nextOffset: string | null;
  eof: boolean;
  offsetSpace: 'source-byte';
}
export function listChildren(libraryId: string, parentId = '', cursor?: string | null, limit = 200, requestId?: string) {
  return invoke<KnowledgeDirectoryPage>('kb_list_children', { libraryId, parentId, cursor: cursor ?? null, limit, requestId: requestId ?? null });
}
export function scanDirectory(libraryId: string, parentId = '') {
  return invoke<KnowledgeTask>('kb_scan_start', { libraryId, parentId });
}
export function getTask(libraryId: string, taskId: string) {
  return invoke<KnowledgeTask>('kb_task_status', { libraryId, taskId });
}
export function cancelTask(libraryId: string, taskId: string) {
  return invoke<KnowledgeTask>('kb_task_cancel', { libraryId, taskId });
}
export function openDocument(libraryId: string, fileId: string) {
  return invoke<KnowledgeDocument>('kb_open_document', { libraryId, fileId });
}
export function readWindow(libraryId: string, docId: string, revision: string, offset: string, maxBytes = 65536) {
  return invoke<KnowledgeWindow>('kb_read_window', { libraryId, docId, revision, offset, maxBytes });
}
export interface KnowledgeIndexTask {
  id: string;
  libraryId: string;
  kind: 'index';
  phase: 'queued' | 'discovering' | 'hashing' | 'parsing' | 'building' | 'validating' | 'publishing' | 'completed' | 'cancelling' | 'cancelled' | 'failed' | 'interrupted';
  processedFiles: number;
  processedBytes: string;
  totalBytes: string | null;
  cancelRequested: boolean;
  error: string | null;
  coverage: 'none' | 'metadata_and_text';
  snapshotEpoch: string | null;
  updatedAt: number;
}
export function startIndex(libraryId: string, requestId: string) {
  return invoke<KnowledgeIndexTask>('kb_index_start', { libraryId, requestId });
}
export function getIndexTask(libraryId: string, taskId: string) {
  return invoke<KnowledgeIndexTask>('kb_index_status', { libraryId, taskId });
}
export function cancelIndexTask(libraryId: string, taskId: string) {
  return invoke<KnowledgeIndexTask>('kb_index_cancel', { libraryId, taskId });
}
export interface KnowledgeDocumentSearch {
  docId: string;
  revision: string;
  hits: { sourceStartByte: string; sourceEndByte: string; excerpt: string }[];
  nextOffset: string | null;
  incomplete: boolean;
  eof: boolean;
  scannedBytes: string;
  offsetSpace: 'source-byte';
}
export function searchDocument(libraryId: string, docId: string, revision: string, query: string, offset: string, requestId: string, maxHits = 50) {
  return invoke<KnowledgeDocumentSearch>('kb_search_document', { libraryId, docId, revision, query, offset, requestId, maxHits });
}
export function cancelDocumentSearch(libraryId: string, docId: string, requestId: string) {
  return invoke<void>('kb_search_document_cancel', { libraryId, docId, requestId });
}
export function closeDocument(libraryId: string, docId: string) {
  return invoke<void>('kb_close_document', { libraryId, docId });
}
