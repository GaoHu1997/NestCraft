import { useEffect, useRef, useState } from 'react';
import * as perf from '@/api/knowledge-performance';
import type { KnowledgeIndexTask } from '@/api/knowledge-performance';
const tasks = new Map<string, KnowledgeIndexTask>();
const terminal = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
const labels: Record<KnowledgeIndexTask['phase'], string> = { queued: '排队中', discovering: '盘点原件', hashing: '校验原件', parsing: '解析正文', building: '构建索引', validating: '验证新快照', publishing: '发布新快照', completed: '任务已完成', cancelling: '正在取消', cancelled: '已取消', failed: '失败', interrupted: '已中断' };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function KnowledgeIndexStatus({ libraryId, visible, disabled, onPublished }: { libraryId: string; visible: boolean; disabled: boolean; onPublished: () => void }) {
  const [task, setTask] = useState<KnowledgeIndexTask | null>(() => tasks.get(libraryId) ?? null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const live = useRef(true), current = useRef(task), published = useRef<string | null>(null), callback = useRef(onPublished); callback.current = onPublished;
  const accept = (value: KnowledgeIndexTask) => {
    if (value.libraryId !== libraryId || value.kind !== 'index') throw new Error('索引任务身份不一致');
    tasks.set(libraryId, value); current.current = value;
    if (live.current) setTask(value);
    if (value.phase === 'completed' && value.coverage === 'metadata_and_text' && value.snapshotEpoch && published.current !== value.id) { published.current = value.id; if (live.current) callback.current(); }
  };
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (!visible || !task || terminal.has(task.phase)) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const taskId = task.id;
    const poll = async () => {
      try {
        const result = await perf.getIndexTask(libraryId, taskId);
        if (!alive || !live.current || current.current?.id !== taskId) return;
        if (result.id !== taskId) throw new Error('索引状态返回其它任务');
        accept(result); setError('');
        if (terminal.has(result.phase)) return;
      } catch (failure) { if (alive && live.current) setError('状态读取失败：' + message(failure)); }
      if (alive) timer = setTimeout(poll, 750);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [libraryId, visible, task?.id, task ? terminal.has(task.phase) : true]);
  const start = async () => {
    if (busy || disabled) return;
    setBusy(true); setError('');
    try { accept(await perf.startIndex(libraryId, crypto.randomUUID())); }
    catch (failure) { if (live.current) setError('索引任务启动失败：' + message(failure)); }
    finally { if (live.current) setBusy(false); }
  };
  const cancel = async () => {
    if (!task || busy) return;
    const taskId = task.id; setBusy(true); setError('');
    try { const result = await perf.cancelIndexTask(libraryId, taskId); if (current.current?.id === taskId && result.id === taskId) accept(result); }
    catch (failure) { if (live.current) setError('取消请求未确认：' + message(failure)); }
    finally { if (live.current) setBusy(false); }
  };
  const active = !!task && !terminal.has(task.phase);
  return <div className="kp-task-panel" aria-label="全文索引任务">
    <b>全文索引</b>
    <p>重建期间仍可查询已发布快照；目录盘点与全文索引是不同任务。</p>
    {task && <div role="status"><span>{labels[task.phase]}{task.cancelRequested && active ? ' · 已请求取消' : ''}</span><br />已处理 {task.processedFiles} 个文件 · {task.processedBytes} 字节
      {task.phase === 'completed' && <p>{task.coverage === 'metadata_and_text' && task.snapshotEpoch ? `已发布索引快照 v${task.snapshotEpoch}；支持的文本有正文，其它格式仅元信息。原件新鲜度仍待核验。` : '任务未确认有效新快照发布，不视为索引完成。'}</p>}
      {(task.phase === 'failed' || task.phase === 'cancelled' || task.phase === 'interrupted') && <p>本任务未发布新快照，已有快照保持。{task.error}</p>}
    </div>}
    {error && <p className="kw-error-text" role="alert">{error}</p>}
    <button className="btn sm" disabled={disabled || busy || active} onClick={() => void start()}>{busy && !active ? '请求中…' : '重建全文索引'}</button>
    {active && <button className="btn sm" disabled={busy || !!task?.cancelRequested} onClick={() => void cancel()}>取消索引任务</button>}
  </div>;
}
