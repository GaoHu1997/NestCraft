// CR-097 / SC-097-02：Office 转换组件状态卡。
// 缺组件时不再只显示一行错误码：说明原因、提供准备组件/重试/下载原件，并在准备完成后自动重试预览。
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { kbOfficePrepare, kbOfficeState, type OfficeState } from '@/api/knowledge-preview';

interface Progress { phase?: string; done?: number; total?: number; }
type Phase = 'checking' | 'missing' | 'preparing' | 'ready' | 'error';

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(0);

export function OfficeConverterCard({ fileName, exporting, onRetry, onExport, onRefreshDirectory }: {
  fileName: string;
  exporting?: boolean;
  onRetry: () => void;
  onExport: () => void;
  onRefreshDirectory: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [state, setState] = useState<OfficeState | null>(null);
  const [progress, setProgress] = useState<Progress>({});
  const [error, setError] = useState('');
  const live = useRef(true);
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;

  const read = useCallback(async () => {
    try {
      const next = await kbOfficeState();
      if (!live.current) return;
      setState(next);
      setError(next.error || '');
      setPhase(next.installed ? 'ready' : next.error.startsWith('OFFICE_UNSUPPORTED_PLATFORM') ? 'error' : 'missing');
    } catch (failure) {
      if (live.current) { setPhase('error'); setError(String(failure)); }
    }
  }, []);

  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { void read(); }, [read]);

  useEffect(() => {
    const offs: Array<() => void> = [];
    let alive = true;
    void (async () => {
      const offProgress = await listen<Progress>('kb-office-progress', event => {
        if (!alive || !live.current) return;
        setPhase('preparing');
        setProgress(event.payload ?? {});
      });
      const offError = await listen<{ error?: string }>('kb-office-error', event => {
        if (!alive || !live.current) return;
        setPhase('error');
        setError(event.payload?.error ?? '组件准备失败');
      });
      if (!alive) { offProgress(); offError(); return; }
      offs.push(offProgress, offError);
    })();
    return () => { alive = false; for (const off of offs) off(); };
  }, []);

  const prepare = async () => {
    if (phase === 'preparing') return;
    setPhase('preparing'); setError(''); setProgress({});
    try {
      const result = await kbOfficePrepare();
      if (!live.current) return;
      if (result.installed) {
        setState(current => current ? { ...current, installed: true, dir: result.dir ?? current.dir, error: '' } : current);
        setPhase('ready');
        retryRef.current();
      } else {
        setPhase('error'); setError(result.error ?? '组件未就绪');
      }
    } catch (failure) {
      if (live.current) { setPhase('error'); setError(String(failure)); }
    }
  };

  const total = progress.total ?? 0;
  const done = progress.done ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const extracting = progress.phase === 'extract';

  return <section className="kp-office-card" role={phase === 'error' ? 'alert' : 'status'} aria-live="polite">
    <span className="kp-office-tag" data-state={phase}>
      {phase === 'ready' ? '组件已就绪' : phase === 'preparing' ? (extracting ? '正在解包' : '正在下载') : phase === 'checking' ? '检测中' : phase === 'error' ? '组件不可用' : '需要本机转换组件'}
    </span>
    <h2>{phase === 'ready' ? '转换组件已就绪，可重新生成预览' : '暂时无法在库内预览这个 Office 文件'}</h2>
    <p>{phase === 'ready'
      ? `${fileName} 现在可以只读分页预览。转换在私有临时目录进行，不执行宏、不加载外链。`
      : '该格式的只读预览需要本机受管的文档转换组件（LibreOffice）。当前未检测到可用组件，因此没有伪造正文预览。'}</p>
    {phase === 'preparing' && <>
      <div className="kp-office-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${percent}%` }} /></div>
      <p className="kp-office-meta">{extracting ? '正在解包组件（只展开文件，不安装、不改文件关联）…' : total > 0 ? `${mb(done)} / ${mb(total)} MB · ${percent}%` : '正在连接下载源…'}</p>
    </>}
    {phase === 'error' && <p className="kp-office-error" role="alert">{error.replace(/^[A-Z_]+:\s*/, '')}</p>}
    {phase === 'missing' && <ul>
      <li>PDF 可以直接预览，不需要此组件。</li>
      <li>准备组件可在本页重试；也可以先下载原件用本机应用查看。</li>
      <li>组件放在统一数据目录，下载约 300MB，只准备一次。</li>
    </ul>}
    <div className="kp-office-actions">
      {phase === 'ready'
        ? <button type="button" className="btn primary" onClick={() => retryRef.current()}>重新生成预览</button>
        : phase === 'preparing'
          ? <button type="button" className="btn" onClick={() => retryRef.current()}>先看其它文件</button>
          : <><button type="button" className="btn primary" disabled={phase === 'checking'} onClick={() => void prepare()}>{phase === 'error' ? '重试准备组件' : '准备组件'}</button><button type="button" className="btn" onClick={() => retryRef.current()}>重试预览</button></>}
      <button type="button" className="btn" disabled={exporting} onClick={onExport}>{exporting ? '导出中…' : '下载原件'}</button>
      <button type="button" className="btn" onClick={onRefreshDirectory}>刷新目录</button>
    </div>
    {state?.dir && <p className="kp-office-meta" title={state.dir}>组件目录：{state.dir}</p>}
  </section>;
}
