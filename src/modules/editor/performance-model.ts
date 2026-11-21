import type { Text } from "@codemirror/state";

export type Schedule = (run: () => void, delay: number) => () => void;
const schedule: Schedule = (run, delay) => { const id = setTimeout(run, delay); return () => clearTimeout(id); };

/** Exact comparison is idle, cancellable and bounded; typing never flattens a document. */
export class DirtyTracker {
  private current: Text;
  private baseline: Text;
  private cancel: (() => void) | undefined;
  private generation = 0;
  private disposed = false;
  dirty = false;

  constructor(doc: Text, private notify: (dirty: boolean) => void, private defer: Schedule = schedule) {
    this.current = this.baseline = doc;
  }
  get saved(): Text { return this.baseline; }
  get document(): Text { return this.current; }
  update(doc: Text): void { this.current = doc; this.reconcile(); }
  savedSnapshot(doc: Text): void { this.baseline = doc; this.reconcile(); }
  dispose(): void { this.disposed = true; this.generation++; this.cancel?.(); }
  private set(value: boolean): void { if (this.dirty !== value) { this.dirty = value; this.notify(value); } }
  private reconcile(): void {
    this.cancel?.(); this.cancel = undefined;
    const generation = ++this.generation;
    if (this.disposed) return;
    const current = this.current, baseline = this.baseline;
    if (current === baseline) { this.set(false); return; }
    this.set(true);
    if (current.length !== baseline.length) return;
    let offset = 0;
    const compare = () => {
      if (this.disposed || generation !== this.generation) return;
      // Each task examines at most 64 Ki UTF-16 units, including a huge single line.
      const stop = Math.min(current.length, offset + 65536);
      for (; offset < stop; offset += 8192) {
        const end = Math.min(current.length, offset + 8192);
        if (current.sliceString(offset, end) !== baseline.sliceString(offset, end)) return;
      }
      if (offset >= current.length) { this.set(false); this.cancel = undefined; }
      else this.cancel = this.defer(compare, 0);
    };
    this.cancel = this.defer(compare, 180);
  }
}

/** One writer per session; requests while saving coalesce to the latest immutable snapshot. */
export class SaveQueue<T> {
  private pending: T | undefined;
  private running: Promise<void> | undefined;
  private disposed = false;
  constructor(private write: (snapshot: T) => Promise<void>, private committed: (snapshot: T) => void) {}
  get busy(): boolean { return this.running !== undefined; }
  request(snapshot: T): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("文档已关闭，保存未启动"));
    this.pending = snapshot;
    if (!this.running) {
      // Start in a microtask so synchronous UI calls also coalesce.
      this.running = Promise.resolve().then(async () => {
        while (this.pending !== undefined && !this.disposed) {
          const submitted = this.pending; this.pending = undefined;
          await this.write(submitted);
          this.committed(submitted);
        }
      }).finally(() => { this.running = undefined; this.pending = undefined; });
    }
    return this.running;
  }
  dispose(): void { this.disposed = true; this.pending = undefined; }
}

export interface VirtualRange { start: number; end: number; offset: number; totalHeight: number }
export function virtualRange(count: number, scrollTop: number, height: number, rowHeight = 26, overscan = 8): VirtualRange {
  const start = Math.max(0, Math.min(count, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan));
  const end = Math.min(count, Math.ceil((Math.max(0, scrollTop) + Math.max(rowHeight, height)) / rowHeight) + overscan);
  return { start, end, offset: start * rowHeight, totalHeight: count * rowHeight };
}
