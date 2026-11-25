/**
 * history.ts —— 导航历史（模块级数组 + 指针，上限 100）。
 *
 * 模型：线性访问列表 + 当前指针。
 * - historyOf(path,line,col)：记录一次访问；若与当前指针位置同文件且行差 ≤4 则跳过。
 * - historyBack / historyForward：移动指针并用宿主提供的 openAt 打开对应位置。
 * - clearHistory：切换项目时由主代理调用。
 */

export interface HistoryEntry {
  path: string;
  line: number;
  col: number;
}

const MAX_ENTRIES = 100;
const SAME_FILE_LINE_TOLERANCE = 4;

let entries: HistoryEntry[] = [];
let pointer = -1;

const normPath = (p: string): string => p.replace(/\\/g, "/").toLowerCase();

/** 记录一个访问位置（应在跳转到目标前后由 goto 编排调用）。 */
export function historyOf(path: string, line: number, col: number): void {
  if (!path) return;
  const current = pointer >= 0 ? entries[pointer] : undefined;
  if (current && normPath(current.path) === normPath(path) && Math.abs(current.line - line) <= SAME_FILE_LINE_TOLERANCE) {
    return;
  }
  // 丢弃当前指针之后的「前进」分支
  entries = entries.slice(0, pointer + 1);
  entries.push({ path, line, col });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  pointer = entries.length - 1;
}

/** 后退；成功返回 true。 */
export function historyBack(openAt: (p: string, l: number, c?: number) => void): boolean {
  if (pointer <= 0) return false;
  pointer--;
  const entry = entries[pointer];
  if (!entry) return false;
  try {
    openAt(entry.path, entry.line, entry.col);
  } catch {
    return false;
  }
  return true;
}

/** 前进；成功返回 true。 */
export function historyForward(openAt: (p: string, l: number, c?: number) => void): boolean {
  if (pointer < 0 || pointer >= entries.length - 1) return false;
  pointer++;
  const entry = entries[pointer];
  if (!entry) return false;
  try {
    openAt(entry.path, entry.line, entry.col);
  } catch {
    return false;
  }
  return true;
}

/** 清空历史（切换项目时调用）。 */
export function clearHistory(): void {
  entries = [];
  pointer = -1;
}
