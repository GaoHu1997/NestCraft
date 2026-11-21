import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as api from "@/api";
import type { KbTransferTask } from "@/api";
import { errorText } from "./knowledgeWorkspace";
import { TRANSFER_POLL_MS, groupBytes, isTransferDone, isTransferExpired, sameTransferTask, sumBytes, transferBatch, transferFailure, transferFailureDetails, transferPhaseText, transferProgress, transferTitle, type TransferKind } from "./transferModel";
import "./knowledge-performance.css";

/**
 * UI-CR055-FEAT009-v1.3：GB 级原件导入/导出的界面任务状态消费。
 * 任务登记在模块级 Map（按 taskId），状态轮询只覆盖当前库 + 当前作用域的活跃任务；
 * 组件卸载/切库/切文件时清计时器与在途请求，迟到回调按 id/libraryId/kind + scope 校验后被丢弃。
 * 进度语义：processedBytes/totalBytes 只描述当前文件，整体进度用 fileIndex/fileTotal/completedFiles。
 */
interface TransferRecord {
  task: KbTransferTask;
  /** 任务发起时的作用域（库 + 当前文件/目录），用于隔离旧任务对当前视图的更新。 */
  scope: string;
  kind: TransferKind;
  /** 重试所需的原始目标：导入为目录相对路径，导出为 noteId。 */
  target: string;
  /** 已完成导入只刷新一次目录，避免轮询重复触发。 */
  notified: boolean;
  /** 终态被淘汰（TRANSFER_NOT_FOUND）：显示“结果已过期”，不再当作进行中。 */
  expired: boolean;
}

const store = new Map<string, TransferRecord>();
const listeners = new Set<() => void>();
let revision = 0;
const emit = () => { revision += 1; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => revision;
function put(record: TransferRecord): void { store.set(record.task.id, record); emit(); }
function drop(taskId: string): void { if (store.delete(taskId)) emit(); }
function recordsFor(libraryId: string, scope: string): TransferRecord[] {
  return [...store.values()].filter(record => record.task.libraryId === libraryId && record.scope === scope);
}
const settled = (record: TransferRecord) => record.expired || isTransferDone(record.task.phase);
const shortHash = (hash: string | null) => (hash && hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash ?? "接口未提供 SHA-256");

export interface KnowledgeTransferState {
  tasks: TransferRecord[];
  busy: boolean;
  error: string;
  confirmCancel: string | null;
  startImport: (parentUri: string) => Promise<void>;
  startExport: (noteId: string) => Promise<void>;
  requestCancel: (taskId: string) => void;
  abortCancel: () => void;
  confirmCancelNow: (taskId: string) => Promise<void>;
  retry: (taskId: string) => Promise<void>;
  dismiss: (taskId: string) => void;
  refreshImported: () => void;
  copyHash: (taskId: string) => void;
}

export function useKnowledgeTransfer(options: { libraryId: string; visible: boolean; scopeKey: string; disabled: boolean; onImported: () => void }): KnowledgeTransferState {
  const { libraryId, visible, scopeKey, disabled, onImported } = options;
  const version = useSyncExternalStore(subscribe, snapshot, snapshot);
  const tasks = useMemo(() => recordsFor(libraryId, scopeKey), [version, libraryId, scopeKey]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const libraryRef = useRef(libraryId); libraryRef.current = libraryId;
  const importedRef = useRef(onImported); importedRef.current = onImported;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setConfirmCancel(null); }, [scopeKey]);

  const accept = useCallback((expected: TransferRecord, next: KbTransferTask): boolean => {
    if (!sameTransferTask(expected.task, next)) return false;
    const record: TransferRecord = { ...expected, task: next, expired: false };
    if (next.phase === "completed" && next.kind === "import" && !expected.notified) record.notified = true;
    put(record);
    // 旧作用域的更新只留在登记表里，不改当前视图、不触发当前目录刷新。
    return expected.scope === scopeRef.current;
  }, []);

  const pollSignature = tasks.filter(record => !settled(record)).map(record => `${record.task.id}:${record.task.phase}:${record.task.cancelRequested ? 1 : 0}`).join("|");
  useEffect(() => {
    if (!visible || !pollSignature) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      // 每轮重新读取登记表，避免闭包里拿到旧对象；只轮询当前作用域的活跃任务。
      const active = recordsFor(libraryRef.current, scopeRef.current).filter(record => !settled(record));
      for (const record of active) {
        if (cancelled || !visibleRef.current) return;
        const taskId = record.task.id;
        try {
          const result = await api.kbTransferStatus(taskId);
          if (cancelled || !alive.current) return;
          if (result.id !== taskId) { setError("传输状态返回了其它任务，已忽略该结果。"); continue; }
          if (!sameTransferTask(record.task, result)) { setError("传输任务身份不一致，已忽略该结果。"); continue; }
          accept(record, result);
        } catch (failure) {
          if (cancelled || !alive.current) return;
          // 终态记录超过 64 条会被淘汰：展示“结果已过期”并停止轮询，不当作失败或进行中。
          if (isTransferExpired(failure)) { put({ ...record, expired: true }); continue; }
          setError(`传输状态读取失败：${errorText(failure)}`);
        }
      }
      if (!cancelled && visibleRef.current) timer = setTimeout(() => { void loop(); }, TRANSFER_POLL_MS);
    };
    void loop();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [visible, pollSignature, accept]);

  // 导入完成：只提示原件已落盘并刷新当前目录；索引是否建立由全文索引任务单独表示。
  useEffect(() => {
    if (!visible) return;
    for (const record of recordsFor(libraryId, scopeKey)) {
      if (record.task.phase === "completed" && record.task.kind === "import" && record.notified) {
        importedRef.current();
        put({ ...record, notified: false });
      }
    }
  }, [version, visible, libraryId, scopeKey]);

  const start = useCallback(async (kind: TransferKind, target: string, call: (taskId: string) => Promise<KbTransferTask>) => {
    if (busyRef.current || disabledRef.current || !visibleRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    const taskId = crypto.randomUUID();
    const scope = scopeRef.current;
    try {
      const task = await call(taskId);
      if (!alive.current) return;
      if (task.id !== taskId || task.libraryId !== libraryRef.current || task.kind !== kind) throw new Error("传输任务身份不一致，未采用该结果");
      put({ task, scope, kind, target, notified: false, expired: false });
      if (task.phase === "failed") { const failure = transferFailure(task.error, kind); setError(`${failure.title}：${failure.hint}`); }
    } catch (failure) {
      // 任务未创建时（如 BUSY_RETRY）也要给出设计态的可操作提示，而不是裸错误文本。
      if (alive.current) {
        const mapped = transferFailure(errorText(failure), kind);
        setError(`${kind === "import" ? "导入" : "导出"}未开始：${mapped.title}。${mapped.hint}`);
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);

  const startImport = useCallback((parentUri: string) => start("import", parentUri, taskId => api.kbTransferImport(libraryRef.current, parentUri, taskId)), [start]);
  const startExport = useCallback((noteId: string) => start("export", noteId, taskId => api.kbTransferExport(libraryRef.current, noteId, taskId)), [start]);

  const requestCancel = useCallback((taskId: string) => {
    const record = store.get(taskId);
    if (!record || settled(record)) return;
    setConfirmCancel(taskId);
  }, []);

  const confirmCancelNow = useCallback(async (taskId: string) => {
    const record = store.get(taskId);
    setConfirmCancel(null);
    if (!record) return;
    if (record.task.cancelRequested) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const result = await api.kbTransferCancel(taskId);
      if (!alive.current) return;
      if (result.id !== taskId) throw new Error("取消响应返回其它任务，未采用该结果");
      // 取消竞态：返回 copying 时任务可能随即 completed，继续轮询并以后续 status 终态为准。
      accept(record, result);
    } catch (failure) {
      if (!alive.current) return;
      if (isTransferExpired(failure)) put({ ...record, expired: true });
      else setError(`取消请求未确认：${errorText(failure)}`);
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }, [accept]);

  const retry = useCallback(async (taskId: string) => {
    const record = store.get(taskId);
    if (!record) return;
    drop(taskId);
    if (record.kind === "import") await startImport(record.target);
    else await startExport(record.target);
  }, [startExport, startImport]);

  const refreshImported = useCallback(() => { importedRef.current(); }, []);
  const copyHash = useCallback((taskId: string) => {
    const record = store.get(taskId);
    const hash = record?.task.sha256 ?? record?.task.completedFiles?.[0]?.sha256;
    if (!hash) { setError("该任务没有返回 SHA-256，无法复制校验值。"); return; }
    void navigator.clipboard?.writeText(hash).catch(() => setError("复制校验值失败：剪贴板不可用。"));
  }, []);

  return { tasks, busy, error, confirmCancel, startImport, startExport, requestCancel, abortCancel: () => setConfirmCancel(null), confirmCancelNow, retry, dismiss: drop, refreshImported, copyHash };
}

export function KnowledgeTransferPanel({ state, disabled }: { state: KnowledgeTransferState; disabled: boolean }) {
  const { tasks, busy, error, confirmCancel } = state;
  if (!tasks.length && !error) return null;
  return <section className="kp-transfer" role="region" aria-label="原件传输任务">
    <div className="kp-transfer-head"><b>原件传输</b><span>GB 级原件导入 / 导出 · 与 25 MiB 上传、全文索引分开；队列可滚动</span></div>
    <div className="kp-transfer-queue" tabIndex={0} aria-label="原件传输任务队列">
      {tasks.map(record => {
        const { task } = record;
        const progress = transferProgress(task);
        const batch = transferBatch(task);
        const failure = task.phase === "failed" ? transferFailure(task.error, record.kind) : null;
        const details = task.phase === "failed" ? transferFailureDetails(task, record.kind) : [];
        const where = record.kind === "import" ? "目标目录" : "保存位置";
        const activeWork = !settled(record);
        const phaseTone = record.expired ? "muted" : task.phase === "completed" ? "ok" : task.phase === "failed" ? "bad" : task.phase === "cancelled" ? "muted" : "";
        const phaseText = record.expired ? "结果已过期" : transferPhaseText(task);
        const totalDone = sumBytes(task.completedFiles ?? []);
        const meta = record.expired
          ? "TRANSFER_NOT_FOUND · 终态记录最多保留 64 条"
          : task.phase === "completed"
            ? record.kind === "import"
              ? `已导入 ${task.completedFiles?.length ?? 1} 个原件${totalDone ? ` · 共 ${groupBytes(totalDone)} 字节` : ""}${batch.text ? ` · ${batch.text}` : ""} · SHA-256 ${shortHash(task.completedFiles?.[0]?.sha256 ?? task.sha256)}`
              : `完整原件已写出 · ${groupBytes(task.totalBytes ?? task.processedBytes)} 字节 · SHA-256 ${shortHash(task.sha256 ?? task.completedFiles?.[0]?.sha256 ?? null)}`
            : task.phase === "failed"
              ? `${batch.total > 1 || (task.completedFiles?.length ?? 0) > 0 ? `已完成 ${task.completedFiles?.length ?? 0} / ${batch.total || (task.completedFiles?.length ?? 0) + (task.failedFiles?.length ?? 0)} · 失败 ${task.failedFiles?.length ?? 1} · ` : ""}错误码 ${failure!.code} · ${failure!.title}`
              : task.phase === "cancelled"
                ? `已处理 ${groupBytes(task.processedBytes)} 字节已丢弃 · 未${record.kind === "import" ? "完成导入" : "生成目标文件"}${(task.completedFiles?.length ?? 0) > 0 ? ` · 已成功 ${task.completedFiles!.length} 个文件保留` : ""}`
                : task.phase === "picking"
                  ? (record.kind === "import" ? "系统文件选择器已打开 · 可多选；选定前不复制任何字节，此阶段可取消。" : "系统保存对话框已打开 · 写出完整原件字节，不拼接当前已显示窗口；此阶段可取消。")
                  : progress.fileText;
        return <div className="kp-transfer-row" key={task.id} data-indeterminate={progress.indeterminate}>
          <div className="kp-transfer-line"><b title={transferTitle(task)}>{transferTitle(task)}</b><span className={`kp-transfer-phase ${phaseTone}`}>{phaseText}</span></div>
          {batch.text && !record.expired && <div className="kp-transfer-meta">{batch.text}</div>}
          {!record.expired && (task.phase === "copying" || task.phase === "queued" || (task.phase === "completed" && progress.percent === 100)) && (progress.indeterminate
            ? <div className="kp-transfer-bar" role="progressbar" aria-label="整体进度（总量未知）"><i /></div>
            : <div className="kp-transfer-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent ?? 0} aria-label="整体进度"><i style={{ width: `${progress.percent ?? 0}%` }} /></div>)}
          <div className="kp-transfer-meta">{meta}</div>
          {(task.completedFiles?.length ?? 0) > 1 && <ul className="kp-transfer-files">{task.completedFiles!.map(file => <li key={file.noteId}><span>{file.name}</span><span>{groupBytes(file.bytes)} B · {shortHash(file.sha256)}</span></li>)}</ul>}
          {details.length > 0 && <ul className="kp-transfer-files bad">{details.map(file => <li key={file.name}><span>{file.name}</span><span>{file.failure.title}：{file.failure.hint}</span></li>)}</ul>}
          <div className="kp-transfer-ops">
            {activeWork && (task.cancelRequested
              ? <button className="btn sm" disabled>已请求取消…</button>
              : <button className="btn sm" disabled={busy || disabled} onClick={() => state.requestCancel(task.id)}>取消…</button>)}
            {task.phase === "completed" && record.kind === "import" && <button className="btn sm" onClick={() => state.refreshImported()}>刷新当前目录</button>}
            {task.phase === "completed" && record.kind === "export" && <button className="btn sm" onClick={() => state.copyHash(task.id)}>复制校验值</button>}
            {task.phase === "failed" && <button className="btn sm" disabled={busy || disabled} onClick={() => void state.retry(task.id)}>{details.length ? "重试失败项" : failure!.code === "BUSY_RETRY" ? "稍后重试" : "重试"}</button>}
            {task.phase === "cancelled" && <button className="btn sm" disabled={busy || disabled} onClick={() => void state.retry(task.id)}>重新开始</button>}
            {record.expired && <button className="btn sm" disabled={busy || disabled} onClick={() => void state.retry(task.id)}>重新发起</button>}
            {(settled(record) || record.expired) && <button className="btn sm" onClick={() => state.dismiss(task.id)}>关闭</button>}
          </div>
          {confirmCancel === task.id && <div className="kp-transfer-note" role="alert"><b>取消{record.kind === "import" ? "导入" : "导出"}？</b>已复制的临时数据会清理，{where}不会留下半成品；已成功的文件保留，原件、阅读位置与未保存草稿不受影响。<div className="kp-transfer-ops"><button className="btn sm" disabled={busy} onClick={() => void state.confirmCancelNow(task.id)}>确认取消</button><button className="btn sm" onClick={() => state.abortCancel()}>继续</button></div></div>}
          {task.phase === "completed" && <p className="kp-transfer-note good">{record.kind === "import"
            ? (task.indexPending ? "原件已导入，全文索引待建立：可阅读、可导出原件，但全文检索要等索引任务完成；目录盘点与全文索引是不同任务。" : "原件已导入；本任务只完成原件落盘，是否建立全文索引以全文索引任务为准。")
            : "导出的是完整原件字节，不是当前阅读窗口片段；未保存的编辑草稿不在导出内容中。"}</p>}
          {failure && <p className="kp-transfer-note bad">{failure.hint}{details.length > 0 ? "部分成功不回滚：已完成的文件保留，可只重试失败项。" : ""}</p>}
          {record.expired && <p className="kp-transfer-note plain">该任务结果已被淘汰：界面已停止轮询并按“结果已过期”展示，不把旧快照当成进行中或成功；需要时重新发起传输。</p>}
          {task.phase === "cancelled" && <p className="kp-transfer-note plain">{record.kind === "import" ? "已取消导入 · 未完成的文件未写入目标目录，已成功导入的文件保留；原件未修改。" : "已取消导出 · 未生成目标文件；阅读窗口、选区与草稿保持。"}</p>}
        </div>;
      })}
    </div>
    {error && <p className="kw-error-text" role="alert">{error}</p>}
  </section>;
}