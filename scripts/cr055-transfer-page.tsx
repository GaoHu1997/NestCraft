import React from 'react';
import { createRoot } from 'react-dom/client';
import { KnowledgeTransferPanel, type KnowledgeTransferState } from '@/modules/knowledge/KnowledgeTransfer';
import { installScrollbarReveal } from '@/components/scrollbar';

installScrollbarReveal();
const noop = () => {};
const toState = (input: { tasks?: unknown[] } & Partial<KnowledgeTransferState>): KnowledgeTransferState => ({
  tasks: (input.tasks ?? []) as KnowledgeTransferState['tasks'],
  busy: false, error: '', confirmCancel: null,
  startImport: noop, startExport: noop, requestCancel: noop, abortCancel: noop, confirmCancelNow: noop,
  retry: noop, dismiss: noop, refreshImported: noop, copyHash: noop,
  ...input,
});
const root = createRoot(document.getElementById('root')!);
(window as unknown as { renderTransfer: (input: unknown) => void }).renderTransfer = input => {
  root.render(React.createElement(KnowledgeTransferPanel, { state: toState(input as { tasks?: unknown[] }), disabled: false }));
};
(window as unknown as { renderTransfer: (input: unknown) => void }).renderTransfer({ tasks: [] });
