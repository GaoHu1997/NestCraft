import { useLayoutEffect, useRef, useState } from 'react';
import * as perf from '@/api/knowledge-performance';
import type { KnowledgeDocument, KnowledgeDocumentSearch, KnowledgeWindow } from '@/api/knowledge-performance';

const err = (error: unknown) => error instanceof Error ? error.message : String(error);
function validateWindow(doc: KnowledgeDocument, window: KnowledgeWindow) {
  if (window.docId !== doc.docId || window.revision !== doc.revision || window.offsetSpace !== 'source-byte') throw new Error('窗口版本或偏移类型不一致，未显示混合版本');
  if (![window.sourceStartByte, window.sourceEndByte, doc.sizeBytes].every(value => /^\d+$/.test(value))) throw new Error('窗口字节范围无效');
  if (BigInt(window.sourceEndByte) < BigInt(window.sourceStartByte) || BigInt(window.sourceEndByte) > BigInt(doc.sizeBytes)) throw new Error('窗口超出原件范围');
}
/** Additive capability for files the existing full reader cannot open; never replaces an editable buffer. */
export function WindowDocument({ libraryId, fileId, visible, onExport }: { libraryId: string; fileId: string; visible: boolean; onExport: () => void }) {
  const documentRef = useRef<KnowledgeDocument | null>(null), live = useRef(false), readSeq = useRef(0), searchSeq = useRef(0), searchRequest = useRef<string | null>(null);
  const [document, setDocument] = useState<KnowledgeDocument | null>(null), [window, setWindow] = useState<KnowledgeWindow | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [offset, setOffset] = useState('0'), [reopen, setReopen] = useState(0);
  const [query, setQuery] = useState(''), [searching, setSearching] = useState(false), [searchError, setSearchError] = useState('');
  const [hits, setHits] = useState<KnowledgeDocumentSearch['hits']>([]), [nextSearch, setNextSearch] = useState<string | null>(null), [progress, setProgress] = useState('0'), [complete, setComplete] = useState(false);
  const queryInput = useRef<HTMLInputElement>(null);
  const stop = async (silent = false) => {
    searchSeq.current++; const request = searchRequest.current, doc = documentRef.current; searchRequest.current = null;
    if (live.current) { setSearching(false); if (!silent) setSearchError('搜索已停止继续扫描，已有结果仅覆盖已扫描范围。'); }
    if (request && doc) try { await perf.cancelDocumentSearch(libraryId, doc.docId, request); } catch (failure) { if (live.current && !silent) setSearchError('已停止继续扫描；后端取消未确认：' + err(failure)); }
  };
  useLayoutEffect(() => {
    live.current = true; const seq = ++readSeq.current;
    setDocument(null); setWindow(null); setHits([]); setNextSearch(null); setComplete(false); setError('');
    setSearching(false); setSearchError(''); setProgress('0'); setQuery('');
    if (visible) {
      setLoading(true);
      perf.openDocument(libraryId, fileId).then(doc => {
        if (!live.current || seq !== readSeq.current) { void perf.closeDocument(libraryId, doc.docId).catch(() => {}); return; }
        if (doc.mode !== 'window-readonly' || doc.offsetSpace !== 'source-byte') throw new Error('后端未提供受支持的源字节窗口');
        validateWindow(doc, doc.initialWindow); documentRef.current = doc; setDocument(doc); setWindow(doc.initialWindow); setOffset(doc.initialWindow.sourceStartByte);
      }).catch(failure => { if (live.current && seq === readSeq.current) setError(err(failure)); }).finally(() => { if (live.current && seq === readSeq.current) setLoading(false); });
    }
    return () => {
      live.current = false; readSeq.current++; searchSeq.current++;
      const doc = documentRef.current, request = searchRequest.current; documentRef.current = null; searchRequest.current = null;
      if (doc) { if (request) void perf.cancelDocumentSearch(libraryId, doc.docId, request).catch(() => {}); void perf.closeDocument(libraryId, doc.docId).catch(() => {}); }
    };
  }, [libraryId, fileId, visible, reopen]);
  const read = async (start: string) => {
    const doc = documentRef.current; if (!doc || loading) return;
    if (!/^\d{1,19}$/.test(start) || BigInt(start) > BigInt(doc.sizeBytes)) { setError('请输入原文件范围内的字节位置；不以行号猜测偏移。'); return; }
    const seq = ++readSeq.current; setLoading(true); setError('');
    try { const result = await perf.readWindow(libraryId, doc.docId, doc.revision, start, 65536); if (!live.current || seq !== readSeq.current) return; validateWindow(doc, result); setWindow(result); setOffset(result.sourceStartByte); }
    catch (failure) { if (live.current && seq === readSeq.current) setError(err(failure)); }
    finally { if (live.current && seq === readSeq.current) setLoading(false); }
  };
  const search = async (start = '0') => {
    const doc = documentRef.current, needle = query.trim(); if (!doc || !needle || searching) return;
    if ([...needle].length > 128) { setSearchError('全文搜索词最多128个字符。'); return; }
    const seq = ++searchSeq.current; setSearching(true); setSearchError(''); setHits([]); setComplete(false); setNextSearch(null);
    const found = new Map<string, KnowledgeDocumentSearch['hits'][number]>(); let cursor: string | null = start;
    try {
      while (cursor !== null && live.current && seq === searchSeq.current) {
        const requestId = crypto.randomUUID(); searchRequest.current = requestId;
        const result = await perf.searchDocument(libraryId, doc.docId, doc.revision, needle, cursor, requestId, 50 - found.size);
        if (!live.current || seq !== searchSeq.current) return;
        if (result.docId !== doc.docId || result.revision !== doc.revision || result.offsetSpace !== 'source-byte') throw new Error('搜索结果版本不一致，结果已拒绝');
        for (const hit of result.hits) found.set(hit.sourceStartByte + ':' + hit.sourceEndByte, hit);
        setHits([...found.values()]); setProgress(result.nextOffset ?? doc.sizeBytes); setNextSearch(result.nextOffset); setComplete(result.eof && !result.incomplete);
        if (result.nextOffset !== null && (!/^\d+$/.test(result.nextOffset) || BigInt(result.nextOffset) <= BigInt(cursor))) throw new Error('搜索未取得有效进展，请重新打开原件');
        cursor = result.nextOffset;
        if (result.eof || found.size >= 50) break;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } catch (failure) { if (live.current && seq === searchSeq.current) setSearchError(err(failure)); }
    finally { if (live.current && seq === searchSeq.current) { searchRequest.current = null; setSearching(false); } }
  };
  return <section className="kp-window-document" aria-label="大文件源字节窗口" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); queryInput.current?.focus(); }
  }}>
    <div className="kp-coverage">只读窗口 · {document?.sizeBytes ?? '…'} 源字节 · {document?.encoding ?? '读取编码中'}。当前显示片段不是全文；全文搜索会扫描原件，完整内容可导出。此窗口不替代已有可编辑文档。</div>
    <div className="kp-window-tools"><span>{window ? `${window.sourceStartByte}–${window.sourceEndByte}` : '尚未读取'} / {document?.sizeBytes ?? '…'}</span><input className="input" aria-label="跳转到原文件字节" inputMode="numeric" value={offset} onChange={event => setOffset(event.target.value)} /><button className="btn sm" disabled={!document || loading} onClick={() => void read(offset)}>定位字节</button><button className="btn sm" disabled={!window?.nextOffset || loading} onClick={() => window?.nextOffset && void read(window.nextOffset)}>下一片段</button><button className="btn sm" onClick={onExport}>导出完整原件</button></div>
    <div className="kp-window-tools"><input className="input" ref={queryInput} aria-label="搜索整个文件" placeholder="搜索整个文件（区分大小写）" value={query} onChange={event => { void stop(true); setQuery(event.target.value); setHits([]); setComplete(false); setNextSearch(null); setProgress('0'); setSearchError(''); }} onKeyDown={event => { if (event.key === 'Enter') void search(); }} /><button className="btn sm" disabled={!document || searching || !query.trim()} onClick={() => void search()}>全文搜索</button><button className="btn sm" disabled={!searching} onClick={() => void stop()}>取消搜索</button></div>
    {(searching || hits.length > 0 || complete || searchError) && <div className="kp-reading-state" role="status">{searching ? '全文搜索进行中' : complete ? '全文搜索完成' : '搜索未完成'} · 扫描进度至源字节 {progress} · 当前页 {hits.length} 个命中{searchError && <p>{searchError}</p>}{!searching && nextSearch && <button className="btn sm" onClick={() => void search(nextSearch)}>继续查找下一批</button>}</div>}
    {hits.map(hit => <button className="kp-window-hit" key={`${hit.sourceStartByte}:${hit.sourceEndByte}`} onClick={() => void read(hit.sourceStartByte)}><b>源字节 {hit.sourceStartByte}</b><span>{hit.excerpt}</span></button>)}
    {error && <div className="kp-reading-state error" role="alert">{error}<button className="btn sm" onClick={() => setReopen(v => v + 1)}>重新打开受检原件</button></div>}
    {loading && <div className="kp-reading-state" role="status">正在读取受检窗口…</div>}
    {window && !error && <pre className="kp-window-source" aria-label="当前原件片段，可选中复制" data-source-start={window.sourceStartByte}>{window.text}</pre>}
  </section>;
}
