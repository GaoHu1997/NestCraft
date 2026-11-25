import { useEffect, useRef, useState } from "react";

/** WP-074-F011：raw 编辑草稿不受规范化查询/异步结果回写影响；不持有分页数据。 */
export function useHistorySearch(keyword: string, onSearch: (q: string) => void, onShowAll: () => void) {
  const [raw, setRaw] = useState(keyword);
  const rawRef = useRef(keyword);
  const issued = useRef(keyword.trim());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composing = useRef(false);
  const focused = useRef(false);
  const dirty = useRef(false);
  const ownsDraft = useRef(false);
  const callbacks = useRef({ onSearch, onShowAll });
  callbacks.current = { onSearch, onShowAll };

  const cancelPending = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const assignRaw = (value: string) => { ownsDraft.current = true; rawRef.current = value; setRaw(value); };
  const schedule = () => {
    cancelPending();
    if (composing.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (composing.current) return;
      const normalized = rawRef.current.trim();
      dirty.current = false;
      if (issued.current === normalized) return;
      issued.current = normalized;
      callbacks.current.onSearch(normalized);
    }, 250);
  };

  useEffect(() => {
    // ChatPanel 会立即回传 trim 值；相同规范词不能擦掉用户原始空格或移动选区。
    if (keyword.trim() === rawRef.current.trim()) return;
    // 旧查询/外部受控值不能覆盖正在编辑、组合输入或等待防抖的本地草稿。
    if (ownsDraft.current || focused.current || composing.current || dirty.current || timer.current !== null) return;
    issued.current = keyword.trim();
    rawRef.current = keyword;
    setRaw(keyword);
  }, [keyword]);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  return {
    raw,
    canReset: Boolean(raw.trim() || keyword.trim()),
    onFocus: () => { focused.current = true; },
    onBlur: () => { focused.current = false; },
    onChange: (value: string, isComposing = false) => {
      assignRaw(value); dirty.current = true;
      if (isComposing || composing.current) { cancelPending(); return; }
      schedule();
    },
    onCompositionStart: () => { composing.current = true; cancelPending(); },
    onCompositionEnd: (value: string) => {
      composing.current = false; assignRaw(value); dirty.current = true; schedule();
    },
    reset: () => {
      cancelPending(); composing.current = false; dirty.current = false; issued.current = "";
      assignRaw(""); callbacks.current.onShowAll();
    },
  };
}
