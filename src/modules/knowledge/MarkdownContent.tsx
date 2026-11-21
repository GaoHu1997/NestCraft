import { memo, useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type { TocEntry } from './TocPanel';
import { allocateHeadingIds } from './performanceModel';

interface Props { source: string; documentKey: string; onToc: (toc: TocEntry[]) => void; onRetention?: (info: { blocks: number; nodes: number; htmlChars: number } | null) => void; }
/** Full readable DOM is retained: browser find, cross-block selection and copy never use viewport-only text. */
export const MarkdownContent = memo(function MarkdownContent({ source, documentKey, onToc, onRetention }: Props) {
  const [blocks, setBlocks] = useState<string[]>([]), [done, setDone] = useState(false), [error, setError] = useState(''), [limited, setLimited] = useState(false);
  const onTocRef = useRef(onToc); onTocRef.current = onToc;
  const onRetentionRef = useRef(onRetention); onRetentionRef.current = onRetention;
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
    const requestId = crypto.randomUUID(), toc: TocEntry[] = [];
    let mountedNodes = 0, mountedBytes = 0, batches = 0;
    setBlocks([]); setDone(false); setError(''); setLimited(false); onTocRef.current([]);
    const worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' });
    const fail = (text: string) => { if (alive) { setError(text); setDone(false); } worker.terminate(); };
    worker.onerror = event => fail(`排版解析失败：${event.message || 'Worker不可用'}。原文与草稿仍保留。`);
    worker.onmessage = event => {
      const data = event.data as { type: string; requestId: string; index?: number; html?: string; message?: string; limited?: boolean };
      if (!alive || data.requestId !== requestId) return;
      if (data.type === 'error') { fail(data.message ?? '解析失败'); return; }
      if (data.type === 'done') { setDone(true); onTocRef.current([...toc]); worker.terminate(); return; }
      if (data.type !== 'chunk' || typeof data.html !== 'string') { fail('排版处理返回无效数据'); return; }
      try {
        const fragment = DOMPurify.sanitize(data.html, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'object', 'embed', 'source', 'svg', 'form', 'style'], FORBID_ATTR: ['style', 'src', 'srcset', 'background'] });
        fragment.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => {
          if (!(anchor.getAttribute('href') ?? '').startsWith('#')) { anchor.removeAttribute('href'); anchor.title = '资料阅读不自动打开外部或本地资源'; }
        });
        mountedNodes += fragment.querySelectorAll('*').length;
        if (mountedNodes > 16000) throw new Error('复杂排版超过节点预算，当前显示尚不完整；原文与可编辑缓冲保留，可导出完整原件。');
        const headings = [...fragment.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')];
        const sourceHeadingIds = headings.map(heading => heading.id);
        const reservedIds = [...fragment.querySelectorAll<HTMLElement>('[id]')].map(element => element.id).filter(Boolean);
        fragment.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
        if (data.limited) setLimited(true);
        const allocated = allocateHeadingIds(headings.map(heading => heading.textContent ?? ''), [...toc.map(item => item.id), ...reservedIds]);
        const sourceToAllocated = new Map<string, string>();
        headings.forEach((heading, index) => {
          const text = heading.textContent ?? '';
          const id = allocated[index];
          if (sourceHeadingIds[index]) sourceToAllocated.set(sourceHeadingIds[index], id);
          heading.id = id;
          toc.push({ level: Number(heading.tagName.slice(1)), text, id });
        });
        fragment.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach(anchor => {
          const target = anchor.getAttribute('href')?.slice(1) ?? '';
          const mapped = sourceToAllocated.get(target);
          if (mapped) anchor.setAttribute('href', `#${mapped}`);
        });
        const holder = document.createElement('div'); holder.append(fragment);
        const html = holder.innerHTML;
        mountedBytes += html.length; batches += 1;
        if (mountedBytes > 4 * 1024 * 1024) throw new Error('排版留存超过 4M 字符预算，当前显示尚不完整；原文与可编辑缓冲保留，可导出完整原件。');
        setBlocks(previous => [...previous, html]);
        onRetentionRef.current?.({ blocks: batches, nodes: mountedNodes, htmlChars: mountedBytes });
        // Acknowledge only after yielding to input/paint; at most one raw HTML batch is outstanding.
        timer = setTimeout(() => { if (alive) worker.postMessage({ type: 'ack', requestId }); }, 0);
      } catch (failure) { fail(`安全排版失败：${failure instanceof Error ? failure.message : String(failure)}`); }
    };
    worker.postMessage({ type: 'start', requestId, source });
    return () => { alive = false; clearTimeout(timer); worker.terminate(); onRetentionRef.current?.(null); };
  }, [source, documentKey]);
  return <>
    {!done && !error && <div className="kp-reading-state" role="status">正在后台解析正文… 已显示 {blocks.length} 个段组；全文尚未加载完成。</div>}
    {error && <div className="kp-reading-state error" role="alert">{error}</div>}
    {limited && <div className="kp-reading-state" role="status">部分超大段落或结构以完整原文显示，格式呈现受限；未截断正文，原文及草稿保持。</div>}
    <article className="kb-content kw-markdown kp-markdown" aria-busy={!done && !error} data-document-key={documentKey} onClick={event => {
      const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]'); if (!anchor) return;
      event.preventDefault(); const href = anchor.getAttribute('href'); if (!href?.startsWith('#')) return;
      try { const id = decodeURIComponent(href.slice(1)); event.currentTarget.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start' }); } catch { /* Invalid fragment remains inert. */ }
    }}>
      {blocks.map((html, index) => <div className="kp-markdown-block" key={`${documentKey}:${index}`} dangerouslySetInnerHTML={{ __html: html }} />)}
      {done && blocks.length === 0 && <p className="muted">空文档</p>}
    </article>
  </>;
});
