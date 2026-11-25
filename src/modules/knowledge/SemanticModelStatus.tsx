// CR-089 / FEAT-009：本地语义模型状态与首次下载（UI-CR089 SC-M01～M04）。
// 模型不打进安装包：首次启动由主进程后台下载；本组件只读取状态、触发/重试下载并显示进度。
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './semantic-model.css';

interface ModelState { installed: boolean; dir?: string; error?: string; }
interface Progress { phase?: string; file?: string; done?: number; total?: number; }
type Phase = 'checking' | 'missing' | 'downloading' | 'ready' | 'error';

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

export function SemanticModelStatus({ visible }: { visible: boolean }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [progress, setProgress] = useState<Progress>({});
  const [error, setError] = useState('');
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const downloading = useRef(false);

  const read = useCallback(async () => {
    try {
      const state = await invoke<ModelState>('kb_semantic_model_state');
      if (!live.current) return;
      setDir(state.dir ?? '');
      if (state.installed) { setPhase('ready'); setError(''); }
      else if (!downloading.current) { setPhase('missing'); setError(state.error ?? ''); }
    } catch (failure) {
      if (live.current) { setPhase('error'); setError(String(failure)); }
    }
  }, []);

  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (visible) void read(); }, [visible, read]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let alive = true;
    void (async () => {
      const offProgress = await listen<Progress>('kb-semantic-progress', event => {
        if (!alive || !live.current) return;
        downloading.current = true;
        setPhase('downloading');
        setProgress(event.payload ?? {});
      });
      const offError = await listen<{ error?: string }>('kb-semantic-error', event => {
        if (!alive || !live.current) return;
        downloading.current = false;
        setPhase('error');
        setError(event.payload?.error ?? '下载失败');
      });
      if (!alive) { offProgress(); offError(); return; }
      unlisteners.push(offProgress, offError);
    })();
    return () => { alive = false; for (const off of unlisteners) off(); };
  }, []);

  const start = async () => {
    if (busy) return;
    setBusy(true); setError(''); downloading.current = true; setPhase('downloading');
    try {
      const result = await invoke<ModelState>('kb_semantic_install');
      if (!live.current) return;
      downloading.current = false;
      if (result.installed) { setPhase('ready'); setDir(result.dir ?? ''); }
      else { setPhase('error'); setError(result.error ?? '下载未完成'); }
    } catch (failure) {
      if (live.current) { downloading.current = false; setPhase('error'); setError(String(failure)); }
    } finally {
      if (live.current) setBusy(false);
    }
  };

  if (!visible) return null;

  const total = progress.total ?? 0;
  const done = progress.done ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return <ModelPanelView phase={phase} progress={progress} error={error} dir={dir} busy={busy} onStart={() => void start()} onDismiss={() => setPhase('missing')} />;
}


export interface ModelPanelViewProps {
  phase: Phase;
  progress?: Progress;
  error?: string;
  dir?: string;
  busy?: boolean;
  onStart?: () => void;
  onDismiss?: () => void;
}

/** 纯展示：四态（未安装/下载中/已就绪/失败），供真实面板与设计对照共用。 */
export function ModelPanelView({ phase, progress = {}, error = '', dir = '', busy = false, onStart, onDismiss }: ModelPanelViewProps) {
  const total = progress.total ?? 0;
  const done = progress.done ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return <div className="kw-model-panel" aria-label="本地语义模型">
    <div className="kw-model-head"><b>本地语义模型</b>
      <span className="kw-model-tag" data-state={phase} data-testid="model-tag">
        {phase === 'ready' ? '已就绪' : phase === 'downloading' ? '下载中' : phase === 'checking' ? '检测中' : phase === 'error' ? '不可用' : '未安装'}
      </span>
    </div>
    {phase === 'missing' && <>
      <p>首次使用需下载约 34MB（模型 24MB + 运行时约 9MB），仅一次。下载完成后自动建立语义索引。</p>
      <div className="kw-model-row">
        <button className="btn sm primary" disabled={busy} onClick={onStart}>立即下载</button>
        <span className="caption">也可先用关键词检索，随时回来下载。</span>
      </div>
    </>}
    {phase === 'downloading' && <>
      <div className="kw-model-row"><span>{progress.file ?? progress.phase ?? '准备中'}</span><span>{percent}%</span></div>
      <div className="kw-model-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${percent}%` }} /></div>
      <p className="caption">{total > 0 ? `${mb(done)} / ${mb(total)} MB` : `已接收 ${mb(done)} MB`} · 可继续阅读，语义稍后可用</p>
    </>}
    {phase === 'ready' && <>
      <p>bge-small-zh-v1.5 · int8 · 512 维</p>
      {dir && <p className="caption" title={dir}>模型目录：{dir}</p>}
      <p className="caption">新建或保存的笔记会自动更新向量；缺失时检索自动回落关键词。</p>
    </>}
    {phase === 'error' && <>
      <p className="kw-error-text" role="alert">下载失败：{error || '未知原因'}。已自动使用关键词检索，其他功能不受影响。</p>
      <div className="kw-model-row">
        <button className="btn sm primary" disabled={busy} onClick={onStart}>重试</button>
        <button className="btn sm" onClick={onDismiss}>稍后再说</button>
      </div>
    </>}
    {phase === 'checking' && <p className="caption">正在检查模型状态…</p>}
  </div>;
}
