/** CR-084: limits bound rendered content, never the source a reader can reach. */
export const MARKDOWN_NODE_LIMIT = 16_000;
export const MARKDOWN_HTML_LIMIT = 4 * 1024 * 1024;
export const MARKDOWN_PARSE_LIMIT = 1024 * 1024;
export const MARKDOWN_SOURCE_SEGMENT = 64 * 1024;

export interface SourceRange { start: number; end: number; }

/** UTF-16 offsets are used only against the same immutable JS source string, not byte offsets. */
export function sourceRanges(source: string, limit = MARKDOWN_SOURCE_SEGMENT): SourceRange[] {
  if (!Number.isInteger(limit) || limit < 2) throw new Error('原文分段长度无效');
  const ranges: SourceRange[] = [];
  for (let start = 0; start < source.length;) {
    let end = Math.min(source.length, start + limit);
    if (end < source.length) {
      const before = source.charCodeAt(end - 1), after = source.charCodeAt(end);
      // Keep surrogate pairs and CRLF intact; concatenating all ranges is byte-for-byte the JS source.
      if ((before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) || (before === 13 && after === 10)) end--;
    }
    ranges.push({ start, end });
    start = end;
  }
  return ranges.length ? ranges : [{ start: 0, end: 0 }];
}
