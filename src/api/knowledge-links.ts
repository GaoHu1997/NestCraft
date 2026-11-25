import { invoke } from './index';

export interface Backlink { sourceNoteId: string; sourcePath: string; sourceTitle: string; rawTarget: string; heading?: string | null; snippet: string; }
export interface OutLink { rawTarget: string; name: string; state: 'resolved' | 'unresolved' | 'ambiguous'; targetPath?: string | null; targetNoteId?: string | null; heading?: string | null; }
export interface LinkCandidate { path: string; title: string; noteId: string; }
export interface LinkResolution { state: 'resolved' | 'unresolved' | 'ambiguous'; targetPath?: string | null; targetNoteId?: string | null; candidates: LinkCandidate[]; }
export interface RenamePreview { affectedFiles: { path: string; count: number }[]; totalLinks: number; }

export const kbLinksBacklinks = (libraryId: string, noteId: string) => invoke<Backlink[]>('kb_links_backlinks', { libraryId, noteId });
export const kbLinksOutgoing = (libraryId: string, noteId: string) => invoke<OutLink[]>('kb_links_outgoing', { libraryId, noteId });
export const kbLinksResolve = (libraryId: string, name: string, fromPath: string) => invoke<LinkResolution>('kb_links_resolve', { libraryId, name, fromPath });
export const kbLinksRenamePreview = (libraryId: string, relativeUri: string) => invoke<RenamePreview>('kb_links_rename_preview', { libraryId, relativeUri });
export const kbLinksRebuild = (libraryId: string) => invoke<number>('kb_links_rebuild', { libraryId });
