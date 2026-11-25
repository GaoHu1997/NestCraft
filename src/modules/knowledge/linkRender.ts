import type { OutLink } from '@/api/knowledge-links';

export interface LinkParts { name: string; heading: string | null; display: string | null; }
/** Parse the inside of `[[...]]`; returns null for invalid or self-anchor-only links. */
export function parseLinkInner(inner: string): LinkParts | null {
  if (!inner || inner.includes('[[') || inner.includes(']]')) return null;
  const [target, display] = inner.includes('|') ? (inner.split('|', 2) as [string, string]) : [inner, null];
  const hash = target.indexOf('#');
  const name = (hash >= 0 ? target.slice(0, hash) : target).trim();
  const heading = hash >= 0 ? target.slice(hash + 1).trim() || null : null;
  if (!name) return null;
  return { name, heading, display: display ? display.trim() : null };
}

const WALK_LIMIT = 20000;
/** Wrap `[[wikilink]]` text nodes in anchors without touching HTML or executing anything. */
export function decorateLinks(root: ParentNode, links: OutLink[]): number {
  const byRaw = new Map<string, OutLink>();
  for (const link of links) byRaw.set(link.rawTarget, link);
  const doc = (root as Document).ownerDocument ?? (root as unknown as Document);
  const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let guard = 0;
  while (walker.nextNode() && guard++ < WALK_LIMIT) {
    const node = walker.currentNode as Text;
    if (node.nodeValue && node.nodeValue.includes('[[') && !node.parentElement?.closest('a,code,pre')) targets.push(node);
  }
  let count = 0;
  for (const text of targets) {
    const value = text.nodeValue ?? '';
    const parts: (string | HTMLElement)[] = [];
    let cursor = 0;
    while (cursor < value.length) {
      const open = value.indexOf('[[', cursor);
      if (open < 0) { parts.push(value.slice(cursor)); break; }
      const close = value.indexOf(']]', open + 2);
      if (close < 0) { parts.push(value.slice(cursor)); break; }
      parts.push(value.slice(cursor, open));
      const inner = value.slice(open + 2, close);
      const parsed = parseLinkInner(inner);
      if (!parsed) { parts.push(value.slice(open, close + 2)); cursor = close + 2; continue; }
      const info = byRaw.get(`[[${inner}]]`);
      const anchor = doc.createElement('a');
      anchor.className = 'kw-link';
      anchor.dataset.state = info?.state ?? 'unresolved';
      anchor.dataset.name = parsed.name;
      if (parsed.heading) anchor.dataset.heading = parsed.heading;
      if (info?.targetPath) anchor.dataset.targetPath = info.targetPath;
      if (info?.targetNoteId) anchor.dataset.targetNoteId = info.targetNoteId;
      anchor.textContent = parsed.display ?? (parsed.heading ? `${parsed.name} › ${parsed.heading}` : parsed.name);
      anchor.title = info?.state === 'resolved' ? `${info.targetPath ?? parsed.name}` : info?.state === 'ambiguous' ? '同名多个文件，点击选择' : '目标不存在，点击新建';
      parts.push(anchor);
      cursor = close + 2;
      count += 1;
    }
    if (parts.length === 1 && typeof parts[0] === 'string') continue;
    const fragment = doc.createDocumentFragment();
    for (const part of parts) fragment.append(typeof part === 'string' ? doc.createTextNode(part) : part);
    text.replaceWith(fragment);
  }
  return count;
}
