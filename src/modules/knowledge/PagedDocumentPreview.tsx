import { useEffect, useRef, useState, useCallback } from 'react';
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { kbPreviewOpen, kbPreviewRead, kbPreviewClose, type KnowledgePreview } from '@/api/knowledge-preview';
import type { KnowledgeFileInfo } from '@/api';
import { OfficeConverterCard } from './OfficeConverterCard';
import './document-preview.css';

GlobalWorkerOptions.workerSrc = workerUrl;
const RANGE_SIZE = 64 * 1024;
const MAX_PDF_BYTES = 512 * 1024 * 1024;
export interface PreviewNavigation { noteId: string; pages: number; page: number; }
export function isPagedDocument(info: KnowledgeFileInfo | undefined): boolean {
  return !!info && /\.(pdf|docx?|rtf|pptx?|pps|pot|xlsx?)$/i.test(info.relativeUri);
}
function bytesOf(value: string): Uint8Array {
  const text = atob(value); return Uint8Array.from(text, char => char.charCodeAt(0));
}
function previewLabel(info: KnowledgeFileInfo) {
  const ext = info.relativeUri.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'pdf' ? 'PDF 原件' : /^xls/.test(ext) ? 'Excel · 打印页预览' : /^(ppt|pps|pot)/.test(ext) ? 'PPT · 转换预览' : 'Word · 转换预览';
}
export function previewFailure(error: unknown): { title: string; message: string; retry: boolean; download: boolean } {
  const raw = error instanceof Error ? error.message : String(error);
  if (/PASSWORD|PasswordException|password/i.test(raw)) return { title: '文件已加密', message: '当前不支持打开加密文件，可下载原件后使用本机应用查看。', retry: false, download: true };
  if (/CONVERTER_UNAVAILABLE/.test(raw)) return { title: '本机转换组件不可用', message: '未找到本机 Office 转换组件。组件就绪后可重试，也可下载原件。', retry: true, download: true };
  if (/SOURCE_CHANGED|SOURCE_INVALID|STALE/.test(raw)) return { title: '原件已变化或源不可用', message: '当前页面不再代表原件，请检查知识库源后重新读取。', retry: true, download: true };
  if (/MISSING|不存在/.test(raw)) return { title: '原件不存在', message: '文件可能已移动或删除，请刷新目录后重新选择。', retry: false, download: false };
  if (/ACCESS_DENIED|不可读取|权限|被占用/.test(raw)) return { title: '没有本机读取权限或文件被占用', message: '恢复本机文件读取权限或关闭占用程序后重试。', retry: true, download: false };
  if (/CANCELLED/.test(raw)) return { title: '已取消预览', message: '原件未改变，可重新开始。', retry: true, download: true };
  if (/UNSUPPORTED|FORMAT_UNSUPPORTED|TOO_LARGE/.test(raw)) return { title: '此文件暂不支持预览', message: raw.replace(/^[A-Z_]+:\s*/, ''), retry: false, download: true };
  return { title: /TIMEOUT/.test(raw) ? '预览超时' : '预览生成失败', message: /TIMEOUT/.test(raw) ? '本机转换或页面读取超时，原件未改变，可重试。' : `文件损坏或无法解析。${raw.replace(/^[A-Z_]+:\s*/, '').slice(0, 240)}`, retry: true, download: true };
}

/** UI-CR084: one rendered page, bounded IPC range reads, no PDF scripts/links/annotations. */
export function PagedDocumentPreview({ libraryId, info, visible, exporting, onExport, onNavigation, requestedPage, onToggleTree, onToggleNavigation, onRefreshDirectory }: {
  libraryId: string; info: KnowledgeFileInfo; visible: boolean; exporting?: boolean; onExport: () => void;
  onNavigation: (state: PreviewNavigation | null) => void; requestedPage?: number;
  onToggleTree: () => void; onToggleNavigation: () => void; onRefreshDirectory: () => void;
}) {
  const [phase, setPhase] = useState<'loading' | 'converting' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState('');
  const [page, setPage] = useState(1); const [pages, setPages] = useState(0);
  const [pageInput, setPageInput] = useState('1'); const [zoom, setZoom] = useState('fit');
  const [generation, setGeneration] = useState(0); const [width, setWidth] = useState(760);
  const [rendering, setRendering] = useState(false);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null); const textRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null); const requestRef = useRef('');
  const navRef = useRef(onNavigation); navRef.current = onNavigation;
  const label = previewLabel(info);
  const cancel = useCallback(() => {
    const request = requestRef.current; requestRef.current = '';
    if (request) void kbPreviewClose(libraryId, request).catch(() => undefined);
    documentRef.current = null; setPhase('failed'); setError('CANCELLED'); navRef.current(null);
  }, [libraryId]);

  useEffect(() => {
    navRef.current(null); setPages(0); setPage(1); setPageInput('1'); setError('');
    if (!visible) return;
    let alive = true; let range: PDFDataRangeTransport | undefined;
    let loading: ReturnType<typeof getDocument> | undefined;
    const requestId = crypto.randomUUID(); requestRef.current = requestId;
    const fail = (reason: unknown) => {
      if (!alive || requestRef.current !== requestId) return;
      setError(reason instanceof Error ? reason.message : String(reason)); setPhase('failed');
      navRef.current(null); void loading?.destroy().catch(() => undefined);
      void kbPreviewClose(libraryId, requestId).catch(() => undefined);
    };
    setPhase(/\.pdf$/i.test(info.relativeUri) ? 'loading' : 'converting');
    void (async () => {
      const preview: KnowledgePreview = await kbPreviewOpen(libraryId, info.noteId, requestId);
      if (!alive || requestRef.current !== requestId) { await kbPreviewClose(libraryId, requestId); return; }
      const size = Number(preview.sizeBytes);
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PDF_BYTES) throw new Error('TOO_LARGE: PDF 预览大小无效或超过512 MiB');
      const read = async (begin: number, length: number) => {
        const response = await kbPreviewRead(libraryId, preview.previewId, preview.sourceRevision, begin, length);
        const bytes = bytesOf(response.base64);
        if (response.offset !== String(begin) || bytes.length !== length) throw new Error('SOURCE_CHANGED: 预览字节范围不完整');
        return bytes;
      };
      const initial = await read(0, Math.min(RANGE_SIZE, size));
      if (!alive || requestRef.current !== requestId) return;
      class RangeTransport extends PDFDataRangeTransport {
        stopped = false;
        constructor() { super(size, initial, true); }
        requestDataRange(begin: number, end: number) {
          void (async () => {
            for (let from = begin; from < end && alive && !this.stopped; from += RANGE_SIZE) {
              const bytes = await read(from, Math.min(RANGE_SIZE, end - from));
              if (alive && !this.stopped && requestRef.current === requestId) this.onDataRange(from, bytes);
            }
          })().catch(fail);
        }
        abort() { this.stopped = true; }
      }
      range = new RangeTransport();
      loading = getDocument({ range, rangeChunkSize: RANGE_SIZE, disableAutoFetch: true, disableStream: true,
        isEvalSupported: false, enableXfa: false, useSystemFonts: true, cMapUrl: new URL('knowledge-pdf/cmaps/', document.baseURI).href,
        cMapPacked: true, standardFontDataUrl: new URL('knowledge-pdf/standard_fonts/', document.baseURI).href,
      });
      loading.onPassword = () => fail(new Error('PASSWORD_REQUIRED'));
      const pdf = await loading.promise;
      if (!alive || requestRef.current !== requestId) { await pdf.destroy(); return; }
      if (!pdf.numPages || pdf.numPages > 10000) throw new Error('TOO_LARGE: 页数为空或超过10000页');
      documentRef.current = pdf; setPages(pdf.numPages); setPhase('ready');
    })().catch(fail);
    return () => {
      alive = false; range?.abort(); documentRef.current = null;
      if (requestRef.current === requestId) requestRef.current = '';
      void loading?.destroy().catch(() => undefined);
      void kbPreviewClose(libraryId, requestId).catch(() => undefined); navRef.current(null);
    };
  }, [libraryId, info.noteId, info.relativeUri, visible, generation]);
  useEffect(() => {
    if (phase === 'ready') navRef.current({ noteId: info.noteId, pages, page });
  }, [phase, page, pages, info.noteId]);
  useEffect(() => { if (requestedPage && requestedPage >= 1 && requestedPage <= pages) setPage(requestedPage); }, [requestedPage, pages]);
  useEffect(() => { setPageInput(String(page)); if (stageRef.current) stageRef.current.scrollTop = 0; }, [page]);
  useEffect(() => {
    const stage = stageRef.current; if (!stage) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(180, stage.clientWidth - 56)));
    observer.observe(stage); return () => observer.disconnect();
  }, [phase]);
  useEffect(() => {
    const pdf = documentRef.current, canvas = canvasRef.current, text = textRef.current;
    if (phase !== 'ready' || !pdf || !canvas || !text) return;
    let alive = true; let renderingTask: RenderTask | undefined; let textLayer: TextLayer | undefined;
    setRendering(true); text.replaceChildren();
    void (async () => {
      const pdfPage = await pdf.getPage(page); if (!alive) return;
      const native = pdfPage.getViewport({ scale: 1 });
      const scale = zoom === 'fit' ? Math.min(760, width) / native.width : Number(zoom) / 100;
      const viewport = pdfPage.getViewport({ scale });
      text.style.setProperty('--scale-factor', String(scale));
      text.style.setProperty('--total-scale-factor', String(scale));
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / Math.max(1, viewport.width * viewport.height)));
      if (viewport.width * viewport.height > 24_000_000) throw new Error('TOO_LARGE: 单页尺寸过大，请选择适合宽度');
      setPageSize({ width: viewport.width, height: viewport.height });
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio)); canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      const context = canvas.getContext('2d'); if (!context) throw new Error('无法取得页面画布');
      renderingTask = pdfPage.render({ canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await renderingTask.promise; if (!alive) return;
      // TextLayer writes text nodes, not PDF actions. No annotation/script layer is created.
      textLayer = new TextLayer({ textContentSource: await pdfPage.getTextContent(), container: text, viewport });
      await textLayer.render(); if (alive) setRendering(false);
    })().catch(reason => { if (alive && reason?.name !== 'RenderingCancelledException') { setError(String(reason?.message ?? reason)); setPhase('failed'); navRef.current(null); } });
    return () => { alive = false; renderingTask?.cancel(); textLayer?.cancel(); };
  }, [phase, page, width, zoom]);
  const failure = previewFailure(error);
  const converterMissing = phase === 'failed' && /CONVERTER_UNAVAILABLE/.test(error);
  const setSafePage = () => { const value = Number(pageInput); setPage(Number.isFinite(value) ? Math.max(1, Math.min(pages, Math.trunc(value))) : page); };
  return <div className="kp-paged-document" data-design-version="UI-CR084-v1.1" data-note-id={info.noteId}>
    <header className="kp-preview-head"><button className="btn sm" onClick={onToggleTree}>文件</button><div><h1>{info.title}</h1><p>{label}</p></div><div className="kp-preview-actions"><button className="btn sm" disabled={exporting || (phase === 'failed' && !failure.download)} onClick={onExport}>{exporting ? '导出中…' : '下载原件'}</button><button className="btn sm" onClick={onToggleNavigation}>目录</button></div></header>
    {phase === 'ready' && <div className="kp-preview-toolbar"><button className="btn sm" disabled={page <= 1 || rendering} onClick={() => setPage(value => value - 1)}>上一页</button><label>第 <input aria-label="页码" type="number" min={1} max={pages} value={pageInput} onChange={event => setPageInput(event.target.value)} onBlur={setSafePage} onKeyDown={event => { if (event.key === 'Enter') setSafePage(); }} /> / {pages} 页</label><button className="btn sm" disabled={page >= pages || rendering} onClick={() => setPage(value => value + 1)}>下一页</button><select aria-label="缩放" value={zoom} onChange={event => setZoom(event.target.value)}><option value="fit">适合宽度</option><option value="100">100%</option><option value="125">125%</option></select></div>}
    <div className="kp-preview-stage" ref={stageRef} tabIndex={0} aria-label="文档阅读区" aria-busy={phase === 'loading' || phase === 'converting' || rendering}>
      {converterMissing ? <OfficeConverterCard fileName={info.title} exporting={exporting} onRetry={() => setGeneration(value => value + 1)} onExport={onExport} onRefreshDirectory={onRefreshDirectory} /> : phase === 'ready' ? <div className="kp-pdf-page" style={{ width: pageSize.width || undefined, height: pageSize.height || undefined }}><canvas ref={canvasRef} style={{ width: pageSize.width, height: pageSize.height }} aria-label={`第 ${page} 页`} /><div ref={textRef} className="textLayer" />{rendering && <div className="kp-page-loading" role="status">正在读取第 {page} 页…</div>}</div> : <section className="kp-preview-state" role={phase === 'failed' ? 'alert' : 'status'}><h2>{phase === 'converting' ? '正在准备转换预览' : phase === 'loading' ? '正在读取原件' : failure.title}</h2><p>{phase === 'converting' ? '本机正在处理文档，当前总页数未知。' : phase === 'loading' ? '正在核对文件版本并读取页面…' : failure.message}</p>{phase !== 'failed' ? <button className="btn" onClick={cancel}>取消</button> : <>{failure.retry && <button className="btn" onClick={() => setGeneration(value => value + 1)}>重试</button>}{failure.download && <button className="btn" disabled={exporting} onClick={onExport}>下载原件</button>}{!failure.download && <button className="btn" onClick={onRefreshDirectory}>刷新目录</button>}</>}</section>}
    </div>
    <footer className="kp-preview-coverage">{phase === 'ready' ? `当前第 ${page} / ${pages} 页 · ${page === pages ? '已到最后一页' : '可继续翻页'}` : '尚无当前版本预览'}{label.startsWith('Excel') && <span>打印页预览仅展示原件打印范围。</span>}</footer>
  </div>;
}
