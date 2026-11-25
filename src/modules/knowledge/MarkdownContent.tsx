import { memo, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type { TocEntry } from './TocPanel';
import { allocateHeadingIds } from './performanceModel';
import { decorateLinks } from './linkRender';
import type { OutLink } from '@/api/knowledge-links';
import { MARKDOWN_HTML_LIMIT, MARKDOWN_NODE_LIMIT, MARKDOWN_PARSE_LIMIT, sourceRanges } from './markdownReadingModel';
import './markdown-reading.css';

interface Props { source: string; documentKey: string; onToc: (toc: TocEntry[]) => void; onRetention?: (info: { blocks: number; nodes: number; htmlChars: number } | null) => void; links?: OutLink[]; onLinkClick?: (link: { name: string; heading: string | null; state: string; targetPath: string | null; targetNoteId: string | null }) => void; }
interface ReadingResult { source: string; key: string; blocks: string[]; toc: TocEntry[]; done: boolean; limited: boolean; fallback: string; nodes: number; htmlChars: number; }
const initial = (source: string, key: string): ReadingResult => ({ source, key, blocks: [], toc: [], done: false, limited: false, fallback: '', nodes: 0, htmlChars: 0 });
/** CR-084: retain full formatted DOM only while bounded; original source always remains reachable. */
export const MarkdownContent = memo(function MarkdownContent({ source, documentKey, onToc, onRetention, links, onLinkClick }: Props) {
  const [result, setResult] = useState<ReadingResult>(() => initial(source, documentKey));
  const [view, setView] = useState<'reading' | 'source'>('reading');
  const [segment, setSegment] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const onTocRef = useRef(onToc); onTocRef.current = onToc;
  const onRetentionRef = useRef(onRetention); onRetentionRef.current = onRetention;
  const linksRef = useRef<OutLink[]>(links ?? []); linksRef.current = links ?? [];
  const onLinkClickRef = useRef(onLinkClick); onLinkClickRef.current = onLinkClick;
  const ranges = useMemo(() => sourceRanges(source), [source]);
  // Before effects run, never render a previously selected document's blocks or completion label.
  const current = result.source === source && result.key === documentKey ? result : initial(source, documentKey);
  const raw = view === 'source' || !!current.fallback;
  const index = Math.min(Math.max(segment, 0), ranges.length - 1), range = ranges[index];

  useEffect(() => { setView('reading'); setSegment(0); }, [source, documentKey]);
  useEffect(() => {
    let alive = true, settled = false, timer: ReturnType<typeof setTimeout> | undefined, worker: Worker | undefined;
    const requestId = crypto.randomUUID(), toc: TocEntry[] = [];
    let mountedNodes = 0, mountedChars = 0;
    setResult(initial(source, documentKey));
    const fallback = (reason: string) => {
      if (!alive || settled) return;
      settled = true;
      clearTimeout(timer); worker?.terminate();
      // Release the prefix, not the original source. No incomplete formatted DOM is left as success.
      setResult({ ...initial(source, documentKey), fallback: reason });
      setSegment(0);
    };
    if (source.length > MARKDOWN_PARSE_LIMIT) {
      fallback('正文超过完整排版预算，已改用原文分段阅读。');
      return () => { alive = false; };
    }
    try {
      worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' });
      worker.onerror = event => { event.preventDefault(); fallback('排版解析失败，已改用原文阅读。'); };
      worker.onmessage = event => {
        const data = event.data as { type: string; requestId: string; html?: string; message?: string; limited?: boolean };
        if (!alive || settled || data.requestId !== requestId) return;
        if (data.type === 'error') { fallback('排版解析失败，已改用原文阅读。'); return; }
        if (data.type === 'done') {
          setResult(previous => ({ ...previous, done: true, toc: [...toc] })); worker?.terminate(); return;
        }
        if (data.type !== 'chunk' || typeof data.html !== 'string') { fallback('排版结果无效，已改用原文阅读。'); return; }
        if (data.limited) { fallback('部分内容改用原文阅读；正文仍可完整访问。'); return; }
        try {
          const fragment = DOMPurify.sanitize(data.html, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'object', 'embed', 'source', 'svg', 'form', 'style'], FORBID_ATTR: ['style', 'src', 'srcset', 'background'] });
          fragment.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => {
            if (!(anchor.getAttribute('href') ?? '').startsWith('#')) { anchor.removeAttribute('href'); anchor.title = '资料阅读不自动打开外部或本地资源'; }
          });
          // Include each mounted batch wrapper in the node budget, and check before accepting a batch.
          const nextNodes = mountedNodes + fragment.querySelectorAll('*').length + 1;
          if (nextNodes > MARKDOWN_NODE_LIMIT) { fallback('复杂排版超过节点预算，已改用原文阅读。'); return; }
          const headings = [...fragment.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')];
          const sourceHeadingIds = headings.map(heading => heading.id);
          const reservedIds = [...fragment.querySelectorAll<HTMLElement>('[id]')].map(element => element.id).filter(Boolean);
          fragment.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
          const allocated = allocateHeadingIds(headings.map(heading => heading.textContent ?? ''), [...toc.map(item => item.id), ...reservedIds]);
          const sourceToAllocated = new Map<string, string>();
          const newToc: TocEntry[] = [];
          headings.forEach((heading, n) => {
            const text = heading.textContent ?? '', id = allocated[n];
            if (sourceHeadingIds[n]) sourceToAllocated.set(sourceHeadingIds[n], id);
            heading.id = id; newToc.push({ level: Number(heading.tagName.slice(1)), text, id });
          });
          fragment.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach(anchor => {
            const target = anchor.getAttribute('href')?.slice(1) ?? '', mapped = sourceToAllocated.get(target);
            if (mapped) anchor.setAttribute('href', `#${mapped}`);
          });
          const holder = document.createElement('div'); holder.append(fragment);
          if (linksRef.current.length) decorateLinks(holder, linksRef.current);
          const html = holder.innerHTML, nextChars = mountedChars + html.length;
          if (nextChars > MARKDOWN_HTML_LIMIT) { fallback('排版留存超过字符预算，已改用原文阅读。'); return; }
          mountedNodes = nextNodes; mountedChars = nextChars; toc.push(...newToc);
          setResult(previous => ({ ...previous, blocks: [...previous.blocks, html], limited: previous.limited || !!data.limited, nodes: mountedNodes, htmlChars: mountedChars }));
          // At most one bounded raw HTML batch is outstanding; yield before requesting the next.
          timer = setTimeout(() => { if (alive) worker?.postMessage({ type: 'ack', requestId }); }, 0);
        } catch { fallback('安全排版失败，已改用原文阅读。'); }
      };
      worker.postMessage({ type: 'start', requestId, source });
    } catch { fallback('排版组件不可用，已改用原文阅读。'); }
    return () => { alive = false; clearTimeout(timer); worker?.terminate(); };
  }, [source, documentKey]);

  useEffect(() => {
    onTocRef.current(raw ? [] : current.toc);
    onRetentionRef.current?.(raw
      ? { blocks: 1, nodes: 1, htmlChars: range.end - range.start }
      : { blocks: current.blocks.length, nodes: current.nodes, htmlChars: current.htmlChars });
  }, [raw, current.toc, current.blocks.length, current.nodes, current.htmlChars, range.start, range.end]);
  useEffect(() => () => { onRetentionRef.current?.(null); }, []);
  const moveSegment = (next: number) => { setSegment(Math.max(0, Math.min(ranges.length - 1, next))); root.current?.querySelector('pre')?.scrollIntoView({ block: 'start' }); };
  const segmented = raw && ranges.length > 1;
  const coverage = raw
    ? segmented ? `原文第 ${index + 1}/${ranges.length} 段 · 字符范围 ${range.start}–${range.end} · ${range.end === source.length ? '已到文件末尾' : '后续仍有内容'}；复制与查找仅限当前段。`
      : `完整原文已加载 · ${source.length} 个 UTF-16 字符 · 已到文件末尾`
    : current.done ? `全文已加载 · ${current.toc.length} 个章节` : `正在后台解析正文… 已显示 ${current.blocks.length} 个段组；全文尚未加载完成。`;
  return <div className="cr084-markdown" ref={root} data-design-version="UI-CR084-v1" data-document-key={documentKey} data-reading-mode={raw ? 'source' : 'reading'}>
    {(current.fallback || current.limited) && <div className="cr084-markdown-notice" role="status">
      <span>{current.fallback || '部分内容改用原文阅读；正文仍可完整访问。'}</span>
      <button type="button" onClick={() => setView('source')}>{ranges.length > 1 ? '查看原文分段' : '查看完整原文'}</button>
    </div>}
    <div className="cr084-markdown-tools" role="group" aria-label="正文阅读方式">
      <button type="button" className="btn sm" disabled={!!current.fallback} aria-pressed={!raw} onClick={() => setView('reading')}>阅读</button>
      <button type="button" className="btn sm" aria-pressed={raw} onClick={() => setView('source')}>原文</button>
      {segmented && <><button type="button" className="btn sm" disabled={index === 0} onClick={() => moveSegment(index - 1)}>上一段</button><span>第 {index + 1} / {ranges.length} 段</span><button type="button" className="btn sm" disabled={index === ranges.length - 1} onClick={() => moveSegment(index + 1)}>下一段</button></>}
    </div>
    {raw ? <pre className="cr084-markdown-source" data-source-start={range.start} data-source-end={range.end} data-source-eof={range.end === source.length}>{source.slice(range.start, range.end)}</pre>
      : <article className="kb-content kw-markdown kp-markdown" aria-busy={!current.done} onClick={event => {
        const wikilink = (event.target as Element).closest<HTMLAnchorElement>('a.kw-link');
        if (wikilink) {
          event.preventDefault();
          onLinkClickRef.current?.({ name: wikilink.dataset.name ?? '', heading: wikilink.dataset.heading ?? null, state: wikilink.dataset.state ?? 'unresolved', targetPath: wikilink.dataset.targetPath ?? null, targetNoteId: wikilink.dataset.targetNoteId ?? null });
          return;
        }
        const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]'); if (!anchor) return;
        event.preventDefault(); const href = anchor.getAttribute('href'); if (!href?.startsWith('#')) return;
        try { const id = decodeURIComponent(href.slice(1)); event.currentTarget.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start' }); } catch { /* Invalid fragment remains inert. */ }
      }}>
        {current.blocks.map((html, n) => <div className="kp-markdown-block" key={`${documentKey}:${n}`} dangerouslySetInnerHTML={{ __html: html }} />)}
        {current.done && current.blocks.length === 0 && <p className="muted">空文档</p>}
      </article>}
    <div className="cr084-markdown-coverage" role="status" aria-live="polite">{coverage}</div>
  </div>;
});
