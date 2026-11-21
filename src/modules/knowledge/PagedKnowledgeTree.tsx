import { memo, forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/icons';
import { fileTypeGlyph } from '@/components/icon-tiles';
import * as perf from '@/api/knowledge-performance';
import type { KnowledgeEntry } from '@/api/knowledge-performance';
import { DirectoryModel, directoryPathSegments, directoryUriAt, findDirectoryId, resolveTreeLead, type DirectoryRow } from './performanceModel';
import './knowledge-performance.css';

const ROW = 40;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const terminal = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
export interface KnowledgeTreeHandle { refresh: (parentUri?: string) => Promise<void>; }
interface Props {
  libraryId: string; visible: boolean; model: DirectoryModel; selected: string | null; disabled?: boolean;
  onEntries: (parentId: string, entries: KnowledgeEntry[], complete: boolean) => void; onOpen: (entry: KnowledgeEntry) => void;
  onFolder: (entry: KnowledgeEntry) => void; onCreateFolder: (uri: string) => void; onCreateDocument: (uri: string) => void;
}

export const PagedKnowledgeTree = memo(forwardRef<KnowledgeTreeHandle, Props>(function PagedKnowledgeTree(props, ref) {
  const { libraryId, visible, model } = props;
  const callbacks = useRef(props); callbacks.current = props;
  const live = useRef(false), shown = useRef(visible); shown.current = visible;
  const [, setVersion] = useState(0);
  const [top, setTop] = useState(model.scrollTop), [height, setHeight] = useState(400), [focusKey, setFocusKey] = useState('');
  const leadIndex = useRef(0);
  const viewport = useRef<HTMLDivElement>(null);
  const refresh = useCallback(() => { if (live.current) setVersion(v => v + 1); }, []);
  const load = useCallback(async (parentId: string, append = false) => {
    if (!shown.current || !live.current) return;
    const page = model.page(parentId); if (page.loading || (append && !page.cursor)) return;
    const token = model.begin(parentId); refresh();
    try {
      const response = await perf.listChildren(libraryId, parentId, append ? page.cursor : null, 200, crypto.randomUUID());
      if (!live.current || !shown.current || page.request !== token) return;
      if (model.accept(parentId, token, response, append) && response.scanState === 'ready') callbacks.current.onEntries(parentId, response.items, response.complete && !append);
    } catch (error) { model.fail(parentId, token, message(error)); }
    refresh();
  }, [libraryId, model, refresh]);
  const rescan = useCallback(async (parentId: string) => {
    if (!live.current || callbacks.current.disabled) return;
    const page = model.page(parentId);
    if (page.taskId && !terminal.has(page.task?.phase ?? 'queued')) return;
    const token = model.begin(parentId); refresh();
    try {
      const task = await perf.scanDirectory(libraryId, parentId);
      if (!live.current || page.request !== token) return;
      if (task.libraryId !== libraryId || task.kind !== 'directory') throw new Error('目录任务身份不一致');
      page.taskId = task.id; page.task = task; page.state = 'pending'; page.loading = false; model.version++;
    } catch (error) { model.fail(parentId, token, message(error)); }
    refresh();
  }, [libraryId, model, refresh]);
  /** Resolve an arbitrary directory URI to its loaded page id, loading parents page by page. */
  const locate = useCallback(async (uri: string): Promise<string | null> => {
    const segments = directoryPathSegments(uri);
    let parentId = '';
    for (let index = 0; index < segments.length; index++) {
      if (model.page(parentId).state !== 'ready') {
        await load(parentId);
        if (model.page(parentId).state !== 'ready') return null;
      }
      const currentUri = directoryUriAt(segments, index);
      let found = findDirectoryId(model.entries.values(), currentUri);
      // A large directory may place the child on a later page; follow the cursor a bounded number of times.
      for (let pageCount = 0; !found && model.page(parentId).cursor && pageCount < 25; pageCount++) {
        if (model.page(parentId).loading) break;
        const before = model.page(parentId).cursor;
        await load(parentId, true);
        found = findDirectoryId(model.entries.values(), currentUri);
        if (model.page(parentId).cursor === before) break;
      }
      if (!found) return null;
      parentId = found;
    }
    return parentId;
  }, [load, model]);
  const refreshTree = useCallback(async (parentUri = '') => {
    const parent = await locate(parentUri);
    if (parent === null) { await rescan(''); return; }
    if (!parent) {
      // Root refresh also revalidates every already-loaded subtree so source revisions propagate.
      for (const parentId of ['', ...[...model.pages.keys()].filter(id => id !== '')]) {
        await rescan(parentId);
      }
      return;
    }
    // The refreshed directory must be open so a newly created child row becomes visible.
    model.expanded.add(parent); model.version++; refresh();
    await rescan(parent);
  }, [locate, model, refresh, rescan]);
  useImperativeHandle(ref, () => ({ refresh: refreshTree }), [refreshTree]);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; model.invalidateRequests(); };
  }, [model]);
  useEffect(() => {
    if (!visible) { model.invalidateRequests(); return; }
    if (!model.pages.get('')?.taskId) void load('');
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      for (const [parentId, page] of model.pages) {
        if (!alive || !shown.current) break;
        if (!page.taskId || (page.task && terminal.has(page.task.phase))) continue;
        const taskId = page.taskId;
        try {
          const task = await perf.getTask(libraryId, taskId);
          if (!alive || !live.current || page.taskId !== taskId) continue;
          if (task.libraryId !== libraryId || task.id !== taskId || task.kind !== 'directory') throw new Error('返回的目录任务身份不一致');
          page.task = task; model.version++; refresh();
          if (task.phase === 'completed') {
            if (task.completedCoverage !== 'directory') { page.error = '任务未确认目录发布，请重试。'; refresh(); }
            else { page.taskId = null; page.loading = false; await load(parentId); }
          } else if (terminal.has(task.phase)) {
            page.loading = false; page.error = task.error || (task.phase === 'cancelled' ? '目录盘点已取消，未发布新目录。' : '目录盘点未完成，请重试。'); refresh();
          }
        } catch (error) { if (alive && live.current) { page.error = `任务状态读取失败：${message(error)}`; refresh(); } }
      }
      if (alive && shown.current) timer = setTimeout(poll, 500);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [visible, libraryId, model, load, refresh]);
  useLayoutEffect(() => {
    const element = viewport.current; if (!element) return;
    element.scrollTop = model.scrollTop;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight || 400)); observer.observe(element);
    return () => observer.disconnect();
  }, [model]);

  const rows = useMemo(() => model.rows(), [model, model.version]);
  // R05: resolve the keyboard lead by stable node key, never by a stale index.
  const lead = useMemo(() => resolveTreeLead(rows, focusKey, leadIndex.current), [rows, focusKey]);
  useEffect(() => {
    if (!lead) return;
    leadIndex.current = lead.index;
    if (focusKey && lead.key !== focusKey) { setFocusKey(lead.key); return; }
    const element = viewport.current;
    if (!focusKey || !element) return;
    if (lead.index * ROW < element.scrollTop) element.scrollTop = lead.index * ROW;
    else if ((lead.index + 1) * ROW > element.scrollTop + element.clientHeight) element.scrollTop = (lead.index + 1) * ROW - element.clientHeight;
  }, [lead, focusKey]);
  const start = Math.max(0, Math.floor(top / ROW) - 5), end = Math.min(rows.length, Math.ceil((top + height) / ROW) + 5);
  const cancel = async (parentId: string) => {
    const page = model.page(parentId); if (!page.taskId) return;
    try {
      const taskId = page.taskId, task = await perf.cancelTask(libraryId, taskId);
      if (!live.current || page.taskId !== taskId || task.id !== taskId || task.libraryId !== libraryId) return;
      page.task = task; model.version++; refresh();
    } catch (error) { page.error = `取消未确认：${message(error)}`; refresh(); }
  };
  const toggle = (entry: KnowledgeEntry) => {
    if (model.expanded.has(entry.id)) model.expanded.delete(entry.id);
    else { model.expanded.add(entry.id); if (!model.pages.has(entry.id)) void load(entry.id); }
    model.version++; refresh(); callbacks.current.onFolder(entry);
  };
  const reveal = (key: string) => {
    const at = rows.findIndex(r => r.key === key);
    if (at < 0) return;
    leadIndex.current = at; setFocusKey(key);
    const element = viewport.current;
    if (!element) return;
    if (at * ROW < element.scrollTop) element.scrollTop = at * ROW;
    else if ((at + 1) * ROW > element.scrollTop + element.clientHeight) element.scrollTop = (at + 1) * ROW - element.clientHeight;
  };
  const renderStatus = (row: DirectoryRow) => {
    const page = model.page(row.parentId), task = page.task;
    if (page.error) return <div className="kp-tree-status" role="status"><span title={page.error}>{page.error}</span><button onClick={() => void rescan(row.parentId)} disabled={props.disabled}>重试</button></div>;
    if (page.loading) return <div className="kp-tree-status" role="status">读取目录页…</div>;
    if (page.state === 'pending') return <div className="kp-tree-status" role="status"><span>{task?.cancelRequested ? '取消请求已发送…' : `目录盘点中${task ? ` · ${task.processedEntries} 项` : ''}`}</span>{page.taskId && <button disabled={task?.cancelRequested} onClick={() => void cancel(row.parentId)}>取消</button>}</div>;
    return <div className="kp-tree-status">此目录没有文件</div>;
  };
  const root = model.page('');
  return <div className="kp-tree-panel">
    <div className="kp-tree-tools"><span>已加载 {model.entries.size} 项</span><button disabled={props.disabled || root.loading || (!!root.taskId && !terminal.has(root.task?.phase ?? 'queued'))} onClick={() => void refreshTree('')}>刷新目录</button></div>
    <div ref={viewport} className="kp-tree-viewport" role="tree" tabIndex={0} aria-label="知识文件树（按目录分页）" aria-busy={root.loading || root.state === 'pending'}
      aria-activedescendant={lead && rows.slice(start, end).some(r => r.key === lead.key) ? `kp-row-${encodeURIComponent(libraryId)}-${encodeURIComponent(lead.key)}` : undefined}
      onScroll={event => { model.scrollTop = event.currentTarget.scrollTop; setTop(model.scrollTop); }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || !rows.length) return;
        const resolved = resolveTreeLead(rows, focusKey, leadIndex.current);
        const at = focusKey && resolved ? resolved.index : -1;
        const active = at >= 0 ? rows[at] : undefined;
        const focusable = (from: number, direction: number) => {
          for (let index = from + direction; index >= 0 && index < rows.length; index += direction) if (rows[index].kind !== 'status') return index;
          return -1;
        };
        const edge = (fromEnd: boolean) => {
          for (let index = fromEnd ? rows.length - 1 : 0; index >= 0 && index < rows.length; index += fromEnd ? -1 : 1) if (rows[index].kind !== 'status') return index;
          return -1;
        };
        let next = at;
        if (event.key === 'ArrowDown') next = focusable(at, 1);
        else if (event.key === 'ArrowUp') next = at < 0 ? edge(false) : focusable(at, -1);
        else if (event.key === 'Home') next = edge(false);
        else if (event.key === 'End') next = edge(true);
        else if (event.key === 'ArrowRight' && active?.entry?.isDir) { event.preventDefault(); if (!model.expanded.has(active.entry.id)) toggle(active.entry); return; }
        else if (event.key === 'ArrowLeft' && active) { event.preventDefault(); const entry = active.entry; if (entry?.isDir && model.expanded.has(entry.id)) toggle(entry); else if (active.parentId) reveal(active.parentId); return; }
        else if (event.key === 'Enter' && active) { event.preventDefault(); if (active.entry) active.entry.isDir ? toggle(active.entry) : callbacks.current.onOpen(active.entry); else if (active.kind === 'more') void load(active.parentId, true); return; }
        else return;
        if (next < 0) { event.preventDefault(); return; }
        event.preventDefault(); reveal(rows[next].key);
      }}>
      <div className="kp-tree-spacer" style={{ height: rows.length * ROW }}>
        {rows.slice(start, end).map((row, offset) => {
          const entry = row.entry, glyph = fileTypeGlyph(entry?.relativeUri.split('.').pop() ?? '');
          return <div className={`kp-tree-slot ${focusKey === row.key ? 'keyboard-focus' : ''}`} key={row.key} style={{ top: (start + offset) * ROW, paddingLeft: row.depth * 14 }}>
            {entry ? <div id={`kp-row-${encodeURIComponent(libraryId)}-${encodeURIComponent(row.key)}`} className={`kp-tree-entry ${props.selected === entry.noteId ? 'selected' : ''}`} role="treeitem" aria-level={row.depth + 1} aria-selected={props.selected === entry.noteId} aria-expanded={entry.isDir ? model.expanded.has(entry.id) : undefined}>
              <button className="kp-tree-label" tabIndex={-1} title={entry.relativeUri} onClick={() => { reveal(row.key); viewport.current?.focus(); entry.isDir ? toggle(entry) : callbacks.current.onOpen(entry); }}>
                {entry.isDir && <Icon name={model.expanded.has(entry.id) ? 'chevronDown' : 'chevronRight'} size={11} />}
                <Icon name={entry.isDir ? (model.expanded.has(entry.id) ? 'folderOpen' : 'folder') : glyph.icon} size={15} />
                <span>{entry.title}</span>
              </button>
              {entry.isDir && <div className="kp-tree-actions"><button disabled={props.disabled} aria-label={`在 ${entry.title} 新建文档`} onClick={() => callbacks.current.onCreateDocument(entry.relativeUri)}><Icon name="filePlus" size={13} /></button><button disabled={props.disabled} aria-label={`在 ${entry.title} 新建文件夹`} onClick={() => callbacks.current.onCreateFolder(entry.relativeUri)}><Icon name="folderPlus" size={13} /></button></div>}
            </div> : row.kind === 'more' ? <button id={`kp-row-${encodeURIComponent(libraryId)}-${encodeURIComponent(row.key)}`} role="treeitem" tabIndex={-1} className="kp-more" onClick={() => { reveal(row.key); viewport.current?.focus(); void load(row.parentId, true); }}>加载此目录下一页</button> : renderStatus(row)}
          </div>;
        })}
      </div>
    </div>
    <p className="kp-tree-caption">目录盘点只更新文件列表，不代表全文索引完成。</p>
  </div>;
}));
