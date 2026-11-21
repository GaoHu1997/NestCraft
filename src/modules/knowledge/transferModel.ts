import type { KbTransferPhase, KbTransferTask } from "@/api";

/** UI-CR055-FEAT009-v1.3：原件传输任务的状态推导、批次进度与错误码文案。纯函数，便于单元验证。 */
export const TRANSFER_POLL_MS = 300;
/** 超过该字节数的导出走带进度的传输任务；更小的文件沿用保存对话框直接写出。 */
export const TRANSFER_LARGE_FILE = 25 * 1024 * 1024;
const TERMINAL: ReadonlySet<KbTransferPhase> = new Set<KbTransferPhase>(["completed", "failed", "cancelled"]);

export type TransferKind = "import" | "export";

export function isTransferDone(phase: KbTransferPhase): boolean {
  return TERMINAL.has(phase);
}

/** 后端以小写十进制字符串回传字节数；非法值按未知处理，不猜成 0 或负数。 */
export function parseByteCount(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function groupBytes(text: string): string {
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 多文件任务的已成功字节合计；用 BigInt 避免 GB 级求和丢精度。 */
export function sumBytes(files: ReadonlyArray<{ bytes: string }>): string | null {
  if (!files.length) return null;
  try {
    const total = files.reduce((sum, file) => sum + BigInt(file.bytes), 0n);
    return total.toString();
  } catch { return null; }
}

export interface TransferBatch {
  /** 任务总文件数；1 表示单文件（或后端未提供），不当作批次展示。 */
  total: number;
  /** 当前文件序号（1 起）。 */
  current: number;
  /** 已成功文件数。 */
  done: number;
  /** 「第 N / 总数 个文件 · 已完成 M / 总数」；单文件时为 null。 */
  text: string | null;
}

export function transferBatch(task: Pick<KbTransferTask, "fileIndex" | "fileTotal" | "completedFiles">): TransferBatch {
  const total = Number.isFinite(task.fileTotal) && task.fileTotal > 1 ? task.fileTotal : 0;
  const current = Number.isFinite(task.fileIndex) && task.fileIndex > 0 ? task.fileIndex : 0;
  const done = task.completedFiles?.length ?? 0;
  return { total, current, done, text: total ? `第 ${Math.min(current || 1, total)} / ${total} 个文件 · 已完成 ${done} / ${total}` : null };
}

export interface TransferProgress {
  /** 整体进度 0～99（完成态 100）；无法估算整体时为 null。 */
  percent: number | null;
  /** 只有单文件且当前文件总量未知时才使用不定进度。 */
  indeterminate: boolean;
  /** 当前文件（不是任务总量）的已处理/总量文本。 */
  fileText: string;
  batchText: string | null;
}

export function transferProgress(task: Pick<KbTransferTask, "phase" | "processedBytes" | "totalBytes" | "fileIndex" | "fileTotal" | "completedFiles">): TransferProgress {
  const processedValue = parseByteCount(task.processedBytes);
  const totalValue = parseByteCount(task.totalBytes);
  const batch = transferBatch(task);
  const processed = groupBytes(String(processedValue ?? 0));
  const fileRatio = processedValue !== null && totalValue !== null && totalValue > 0 ? Math.min(1, processedValue / totalValue) : null;
  const fileText = totalValue === null
    ? `当前文件已处理 ${processed} 字节 · 总大小未知（原件可能仍在写入）`
    : `当前文件已处理 ${processed} / ${groupBytes(String(totalValue))} 字节（${Math.min(99, Math.floor((fileRatio ?? 0) * 100))}%）`;
  if (task.phase === "completed") return { percent: 100, indeterminate: false, fileText, batchText: batch.text };
  if (batch.total > 1) {
    // 整体进度只由「已完成文件数 + 当前文件占比」估算，不使用当前文件字节当任务总量。
    const overall = Math.min(99, Math.floor(((batch.done + (fileRatio ?? 0)) / batch.total) * 100));
    return { percent: overall, indeterminate: false, fileText, batchText: batch.text };
  }
  if (totalValue === null || totalValue === 0 || processedValue === null) return { percent: null, indeterminate: true, fileText, batchText: batch.text };
  return { percent: Math.min(99, Math.floor((processedValue / totalValue) * 100)), indeterminate: false, fileText, batchText: batch.text };
}

export function transferPhaseText(task: KbTransferTask): string {
  const base: Record<KbTransferPhase, string> = {
    queued: "排队中",
    picking: task.kind === "import" ? "等待选择原件" : "等待选择保存位置",
    copying: "复制中",
    completed: task.kind === "import" && task.indexPending ? "已完成 · 索引待建立" : "已完成",
    failed: (task.failedFiles?.length ?? 0) > 0 && (task.completedFiles?.length ?? 0) > 0 ? "部分失败" : "失败",
    cancelled: "已取消",
  };
  const text = base[task.phase];
  return task.cancelRequested && !isTransferDone(task.phase) ? `${text} · 已请求取消` : text;
}

export interface TransferFailure {
  code: string;
  title: string;
  hint: string;
}

/** 把后端错误码映射成可操作中文；保留原始错误码便于排查，找不到时退回原错误文本。 */
export function transferFailure(error: string | null | undefined, kind: TransferKind): TransferFailure {
  const raw = (error ?? "").trim();
  const where = kind === "import" ? "目标目录" : "保存位置";
  const rules: Array<{ test: RegExp; code: string; title: string; hint: string }> = [
    { test: /TRANSFER_TARGET_EXISTS|already exists|同名|目标.{0,4}已存在/i, code: "TRANSFER_TARGET_EXISTS", title: "同名文件已存在", hint: `${where}已有同名文件，未覆盖、未写入任何字节；改名或删除同名目标后可重试。` },
    { test: /TRANSFER_NOT_FOUND|not found|已过期|已淘汰/i, code: "TRANSFER_NOT_FOUND", title: "结果已过期", hint: "终态任务记录最多保留 64 条，该任务结果已被淘汰；界面已停止轮询，不把旧快照当成进行中或成功，需要时请重新发起。" },
    { test: /BUSY_RETRY|too many|上限|活跃任务/i, code: "BUSY_RETRY", title: "活跃任务已满", hint: "同时最多 4 个传输任务且均已活跃；已提交的任务不受影响，稍后重试即可。" },
    { test: /ENOSPC|no space|空间不足|磁盘.{0,4}(满|不足)/i, code: "ENOSPC", title: "磁盘空间不足", hint: `磁盘可用空间不足，已复制的临时数据会清理，${where}不会留下半成品；释放空间后可重试。` },
    { test: /EACCES|EPERM|permission|denied|权限/i, code: "EACCES", title: "无写入权限", hint: `没有写入${where}的权限（可能为只读或被安全软件阻止）；更换目录或调整权限后可重试。` },
    { test: /NOT_SUPPORTED|UNSUPPORTED|PUBLISH|hard.?link|文件系统/i, code: "PUBLISH_UNSUPPORTED", title: "文件系统不支持发布", hint: `${where}所在文件系统不支持原子发布（如部分网络盘、FAT32 或只读卷）；改用本机 NTFS 目录后可重试。` },
  ];
  const matched = rules.find(rule => rule.test.test(raw));
  if (matched) return { code: matched.code, title: matched.title, hint: matched.hint };
  return { code: "TRANSFER_FAILED", title: "传输未完成", hint: raw ? `后端未提供更具体的原因：${raw}` : "后端未返回原因；可重试，失败不会覆盖已有原件。" };
}

/** 终态被淘汰（TRANSFER_NOT_FOUND）不是普通失败：只标记过期并停止轮询。 */
export function isTransferExpired(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : String((error as { message?: string } | null)?.message ?? "");
  return /TRANSFER_NOT_FOUND|not found|已过期|已淘汰/i.test(text);
}

/** 部分失败时按文件列出原因；顶层 error 只作首条摘要。 */
export function transferFailureDetails(task: Pick<KbTransferTask, "failedFiles">, kind: TransferKind): Array<{ name: string; failure: TransferFailure }> {
  return (task.failedFiles ?? []).map(file => ({ name: file.name, failure: transferFailure(file.error, kind) }));
}

/** 拒绝跨任务、跨库的迟到响应，避免旧回调更新当前界面。 */
export function sameTransferTask(expected: Pick<KbTransferTask, "id" | "libraryId" | "kind">, incoming: Pick<KbTransferTask, "id" | "libraryId" | "kind">): boolean {
  return incoming.id === expected.id && incoming.libraryId === expected.libraryId && incoming.kind === expected.kind;
}

/** 面板里可展示的目标名：优先当前文件，未开始时不伪造文件名。 */
export function transferTitle(task: Pick<KbTransferTask, "kind" | "relativeUri" | "currentFile">): string {
  if (task.currentFile) return task.currentFile;
  if (task.relativeUri) return task.relativeUri;
  return task.kind === "import" ? "导入原件" : "导出原件";
}