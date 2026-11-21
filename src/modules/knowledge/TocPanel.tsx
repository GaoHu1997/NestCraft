import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { clampTocLead, tocMoveTarget, tocScrollTarget } from './performanceModel';
export interface TocEntry { level: number; text: string; id: string; }
const ROW = 28;

/** Headings come from the same sanitized Markdown fragments, not a second full-document DOM parse. */
export function TocPanel({ toc, onJump }: { toc: TocEntry[]; onJump: (id: string) => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLElement>(null);
  const [top, setTop] = useState(0), [height, setHeight] = useState(420), [lead, setLead] = useState(0);
  const focusWanted = useRef(false), focusInside = useRef(false);
  const identity = toc.map(item => `${item.id}:${item.text}`).join('\u0000');
  // R08: render never uses an index that the current heading list no longer has.
  const active = clampTocLead(toc.length, lead);
  useLayoutEffect(() => {
    const host = viewport.current ?? list.current;
    // Runs before the next DOM mutation, so it records focus on the still-mounted item.
    return () => { focusInside.current = !!host?.contains(document.activeElement); };
  });
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight || 420)); observer.observe(element);
    const max = Math.max(0, toc.length * ROW - element.clientHeight);
    const clamped = Math.min(Math.max(0, element.scrollTop), max);
    if (element.scrollTop !== clamped) element.scrollTop = clamped;
    setTop(clamped);
    return () => observer.disconnect();
  }, [identity, toc.length]);
  // A shorter document or a re-parse can invalidate the previous lead position.
  useEffect(() => {
    setLead(current => clampTocLead(toc.length, current));
    const next = clampTocLead(toc.length, lead);
    // The item list changed under keyboard focus; re-focus the clamped lead after it re-mounts.
    if (focusInside.current && next >= 0) focusWanted.current = true;
  }, [identity, toc.length]); // lead is intentionally read from the frame before the clamp
  // R08: after the virtual window moves, focus the mounted item instead of a stale index.
  useEffect(() => {
    if (!focusWanted.current) return;
    const host = viewport.current ?? list.current;
    const button = host?.querySelector<HTMLButtonElement>(`[data-toc-index="${active}"]`);
    if (!button) return;
    focusWanted.current = false;
    button.focus();
  }, [active, top, identity, toc.length]);
  if (!toc.length) return <div className="kb-toc-panel"><div className="kb-toc-head">正文目录</div><div className="muted small kb-toc-empty">暂无目录</div></div>;

  /** Moves the lead and keeps it inside the virtual window, so unmounted headings stay reachable. */
  const move = (index: number) => {
    const next = tocMoveTarget(toc.length, index, 0);
    if (next < 0) return;
    focusWanted.current = true;
    setLead(next);
    const element = viewport.current;
    if (!element) return;
    const desired = tocScrollTarget(toc.length, next, element.clientHeight || 420, ROW);
    element.scrollTop = desired; setTop(desired);
  };
  const keyDown = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step) { event.preventDefault(); move(active + step); return; }
    if (event.key === 'Home') { event.preventDefault(); move(0); }
    if (event.key === 'End') { event.preventDefault(); move(toc.length - 1); }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onJump(toc[active]?.id ?? ''); }
  };
  const item = (entry: TocEntry, index: number, virtual: boolean) => <button key={entry.id} data-toc-index={index} className={`kb-toc-item ellipsis${index === active ? ' kb-toc-lead' : ''}`}
    style={{ paddingLeft: 8 + (entry.level - 1) * 14, ...(virtual ? { top: index * ROW } : {}) }} title={entry.text}
    tabIndex={index === active ? 0 : -1} aria-current={index === active ? 'true' : undefined}
    onFocus={() => { focusInside.current = true; setLead(index); }} onClick={() => onJump(entry.id)}>{entry.text}</button>;

  if (toc.length <= 100) return <div className="kb-toc-panel"><div className="kb-toc-head">正文目录</div>
    <nav ref={list} className="kb-toc-list" aria-label="正文标题目录" onKeyDown={keyDown}>{toc.map((entry, index) => item(entry, index, false))}</nav></div>;

  const start = Math.max(0, Math.floor(top / ROW) - 5), end = Math.min(toc.length, Math.ceil((top + height) / ROW) + 5);
  return <div className="kb-toc-panel"><div className="kb-toc-head">正文目录 · {toc.length} 个标题</div>
    <div className="kp-toc-viewport" ref={viewport} tabIndex={0} role="listbox" aria-label="正文标题目录"
      aria-activedescendant={active >= start && active < end ? `kp-toc-${active}` : undefined}
      onScroll={event => setTop(event.currentTarget.scrollTop)}
      onKeyDown={keyDown}>
      <nav className="kp-toc-spacer" style={{ height: toc.length * ROW }} aria-label="正文标题目录">
        {toc.slice(start, end).map((entry, index) => <span key={entry.id} id={`kp-toc-${start + index}`} role="option" aria-selected={start + index === active}>
          {item(entry, start + index, true)}
        </span>)}
      </nav>
    </div></div>;
}