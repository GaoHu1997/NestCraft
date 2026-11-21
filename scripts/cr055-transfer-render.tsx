import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KnowledgeTransferPanel, type KnowledgeTransferState } from '@/modules/knowledge/KnowledgeTransfer';

const base = (over: Record<string, unknown> = {}) => ({
  id: 't1', libraryId: 'lib-1', kind: 'import', phase: 'copying', processedBytes: '0', totalBytes: null, sha256: null,
  noteId: null, relativeUri: null, error: null, indexPending: false, cancelRequested: false, currentFile: null,
  fileIndex: 0, fileTotal: 0, completedFiles: [], failedFiles: [], ...over,
});
const record = (task: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ task, scope: 'lib-1:file-a', kind: 'import', target: '', notified: false, expired: false, ...over });
const state = (tasks: unknown[], over: Partial<KnowledgeTransferState> = {}): KnowledgeTransferState => ({
  tasks: tasks as KnowledgeTransferState['tasks'], busy: false, error: '', confirmCancel: null,
  startImport: async () => {}, startExport: async () => {}, requestCancel: () => {}, abortCancel: () => {}, confirmCancelNow: async () => {},
  retry: async () => {}, dismiss: () => {}, refreshImported: () => {}, copyHash: () => {}, ...over,
});
const html = (value: KnowledgeTransferState) => renderToStaticMarkup(React.createElement(KnowledgeTransferPanel, { state: value, disabled: false }));
export const renders = {
  copyingMulti: html(state([record(base({ phase: 'copying', fileTotal: 3, fileIndex: 2, currentFile: 'b.zip', processedBytes: '1234567890', totalBytes: '4294967296', completedFiles: [{ name: 'a.zip', relativeUri: 'a/a.zip', noteId: 'n1', bytes: '1073741824', sha256: 'a'.repeat(64) }] }))])),
  completedPendingIndex: html(state([record(base({ phase: 'completed', indexPending: true, currentFile: null, relativeUri: 'b.zip', completedFiles: [{ name: 'a.zip', relativeUri: 'a/a.zip', noteId: 'n1', bytes: '1073741824', sha256: 'a'.repeat(64) }, { name: 'b.zip', relativeUri: 'a/b.zip', noteId: 'n2', bytes: '2147483648', sha256: 'b'.repeat(64) }, { name: 'c.zip', relativeUri: 'a/c.zip', noteId: 'n3', bytes: '3221225472', sha256: 'c'.repeat(64) }] }))])),
  completedExport: html(state([record(base({ kind: 'export', phase: 'completed', currentFile: null, relativeUri: 'big.log', totalBytes: '5368709120', processedBytes: '5368709120', sha256: 'f'.repeat(64) }), { kind: 'export' })])),
  partialFailure: html(state([record(base({ phase: 'failed', fileTotal: 3, fileIndex: 3, completedFiles: [{ name: 'a.zip', relativeUri: 'a/a.zip', noteId: 'n1', bytes: '1000', sha256: 'a'.repeat(64) }, { name: 'b.zip', relativeUri: 'a/b.zip', noteId: 'n2', bytes: '2000', sha256: 'b'.repeat(64) }], failedFiles: [{ name: 'c.zip', error: 'TRANSFER_TARGET_EXISTS' }], error: 'TRANSFER_TARGET_EXISTS' }))])),
  expired: html(state([record(base({ phase: 'copying' }), { expired: true })])),
  cancelled: html(state([record(base({ phase: 'cancelled', processedBytes: '4096' }))])),
  picking: html(state([record(base({ phase: 'picking' }))])),
  cancelRequested: html(state([record(base({ phase: 'copying', cancelRequested: true, totalBytes: '100', processedBytes: '10' }))])),
  cancelConfirm: html(state([record(base({ phase: 'copying', totalBytes: '100', processedBytes: '10' }))], { confirmCancel: 't1' })),
  busyDisabled: html(state([record(base({ phase: 'picking' }))], { busy: true })),
  scopeIsolation: html(state([])),
};
