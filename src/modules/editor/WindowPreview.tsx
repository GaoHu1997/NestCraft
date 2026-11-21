import { useEffect, useRef, useState } from "react";
import type { Text } from "@codemirror/state";
import * as perf from "@/api/editor-performance";

export function WindowPreview({ rootUri, path, buffer, onClose }: { rootUri: string; path: string; buffer?: Text; onClose: () => void }) {
  const lease = useRef<perf.DocumentInfo | null>(null);
  const next = useRef<string | null>(null);
  const offset = useRef(0);
  const sequence = useRef(0);
  const [text, setText] = useState("");
  const [range, setRange] = useState("");
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const view = useRef<HTMLPreElement>(null);
  const readNext = async () => {
    const seq = sequence.current;
    setLoading(true); setError("");
    try {
      if (buffer) {
        const start = offset.current; let end = Math.min(buffer.length, start + 32768);
        const tail = buffer.sliceString(Math.max(start, end - 1), end).charCodeAt(0);
        if (end < buffer.length && tail >= 0xd800 && tail <= 0xdbff) end--;
        setText(buffer.sliceString(start, end)); offset.current = end; setRange(`当前缓冲字符 ${start}–${end}`); setMore(end < buffer.length);
      } else {
        const current = lease.current; if (!current || next.current === null) return;
        const data = await perf.readWindow(rootUri, current.docId, current.revision, next.current);
        if (seq !== sequence.current) return;
        setText(data.text); setRange(`原件字节 ${data.sourceStartByte}–${data.sourceEndByte}`); next.current = data.nextCursor; setMore(!data.eof);
      }
      if (view.current) view.current.scrollTop = 0;
    } catch (e) { if (seq === sequence.current) { setError(`${String(e)}；窗口内容未替换为其它版本，可关闭后重新打开。`); setMore(false); } }
    finally { if (seq === sequence.current) setLoading(false); }
  };
  useEffect(() => {
    const seq = ++sequence.current; offset.current = 0;
    setText(""); setRange(""); setMore(false); setError(""); setLoading(true); next.current = null;
    if (buffer) void readNext();
    else void perf.openDocument(rootUri, path).then(info => {
      if (sequence.current !== seq) { void perf.closeDocument(rootUri, info.docId).catch(() => {}); return; }
      lease.current = info; next.current = info.initialCursor; void readNext();
    }).catch(e => { if (sequence.current === seq) { setError(String(e)); setLoading(false); } });
    return () => { sequence.current++; const old = lease.current; lease.current = null; if (old) void perf.closeDocument(rootUri, old.docId).catch(() => {}); };
  }, [rootUri, path, buffer]);
  return <div className="cda-window"><div className="cda-window-tools"><span>只读窗口 · {buffer ? "当前编辑草稿仍保留" : "大文件按需读取"} · {range}</span><span className="spacer" /><button className="btn sm" onClick={onClose}>{buffer ? "返回编辑" : "关闭窗口"}</button><button className="btn sm" disabled={loading || !more} onClick={() => void readNext()}>下一段</button></div>
    {error && <div className="cda-perf-notice error" role="alert">{error}</div>}{loading && <div className="cda-perf-notice" role="status">正在读取窗口…</div>}<pre ref={view} className="cda-window-text" tabIndex={0}>{text}</pre>
  </div>;
}
