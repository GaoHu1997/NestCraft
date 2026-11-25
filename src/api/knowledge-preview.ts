import { invoke } from './index';

/** Owner-only, revision-bound PDF bytes. This never changes AI indexing/grants. */
export interface KnowledgePreview {
  requestId: string;
  previewId: string;
  sourceRevision: string;
  sizeBytes: string;
  format: string;
  converted: boolean;
}
export interface KnowledgePreviewRange { base64: string; offset: string; eof: boolean; }
export const kbPreviewOpen = (libraryId: string, noteId: string, requestId: string) =>
  invoke<KnowledgePreview>('kb_preview_open', { libraryId, noteId, requestId });
export const kbPreviewRead = (libraryId: string, previewId: string, sourceRevision: string, offset: number, length: number) =>
  invoke<KnowledgePreviewRange>('kb_preview_read', { libraryId, previewId, sourceRevision, offset: String(offset), length });
export const kbPreviewClose = (libraryId: string, requestId: string) =>
  invoke<void>('kb_preview_close', { libraryId, requestId });
