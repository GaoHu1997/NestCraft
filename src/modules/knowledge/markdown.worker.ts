import { marked, type Token, type TokensList } from 'marked';
type Input = { type: 'start'; requestId: string; source: string } | { type: 'ack'; requestId: string };
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<Input>) => void) | null; postMessage: (value: unknown) => void };
const encoder = new TextEncoder();
const weight = (html: string) => encoder.encode(JSON.stringify(html)).byteLength;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let requestId = '', ordinal = 0, stream: Generator<{ html: string; limited: boolean }> | null = null;
function* frames(tokens: TokensList): Generator<{ html: string; limited: boolean }> {
  let pending = '', bytes = 0;
  for (const token of tokens) {
    const oversized = token.raw.length > 16 * 1024;
    const html = !oversized
      ? marked.parser(Object.assign([token], { links: tokens.links }) as TokensList, { async: false })
      : '';
    // Space/definition tokens legitimately emit no HTML. Only oversized raw tokens force fallback.
    const size = oversized ? Number.POSITIVE_INFINITY : weight(html);
    if (size > 16 * 1024 || (html.match(/</g)?.length ?? 0) > 128) {
      if (pending) { yield { html: pending, limited: false }; pending = ''; bytes = 0; }
      // A giant paragraph/table/fence is not a bounded HTML batch. Preserve its complete raw text,
      // explicitly flag reduced formatting, and split only at Unicode scalar boundaries.
      const raw = token.raw;
      for (let from = 0; from < raw.length;) {
        let to = Math.min(raw.length, from + 1000);
        if (to < raw.length && /[\uD800-\uDBFF]/.test(raw[to - 1])) to--;
        yield { html: `<pre class="kp-large-raw">${escape(raw.slice(from, to))}</pre>`, limited: true }; from = to;
      }
    } else {
      if ((bytes + size > 16 * 1024 || ((pending + html).match(/</g)?.length ?? 0) > 128) && pending) { yield { html: pending, limited: false }; pending = ''; bytes = 0; }
      pending += html; bytes += size;
    }
  }
  if (pending) yield { html: pending, limited: false };
}
function sendNext() {
  const next = stream?.next();
  if (!next || next.done) { scope.postMessage({ type: 'done', requestId }); stream = null; return; }
  scope.postMessage({ type: 'chunk', requestId, index: ordinal++, ...next.value });
}
scope.onmessage = ({ data }) => {
  try {
    if (data.type === 'start') {
      requestId = data.requestId; ordinal = 0;
      if (data.source.length > 1024 * 1024) throw new Error('当前完整排版最多接受 1M 字符，原件与编辑草稿保持；大文件请使用窗口阅读或完整导出。');
      stream = frames(marked.lexer(data.source)); sendNext();
    } else if (data.type === 'ack' && data.requestId === requestId) sendNext();
  } catch (error) { scope.postMessage({ type: 'error', requestId, message: error instanceof Error ? error.message : String(error) }); stream = null; }
};
