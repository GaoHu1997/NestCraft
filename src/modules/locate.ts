/** 会话来源定位：请求只分发一次，保留尚未挂载的目标请求。 */
export type LocateDetail =
  | { kind: "file"; path: string; line?: number; col?: number; projectId?: string; rootUri?: string }
  | { kind: "requirement"; entityId: string; projectId?: string }
  | { kind: "knowledge"; libraryId: string; noteId: string; projectId?: string }
  | { kind: "office-file"; projectId: string; fileId: string };

const EVENT = "app:locate";
let pending: LocateDetail | null = null;

export function requestLocate(detail: LocateDetail) {
  pending = detail;
  window.dispatchEvent(new CustomEvent<LocateDetail>(EVENT, { detail }));
}

export function takePendingLocate(predicate?: (detail: LocateDetail) => boolean): LocateDetail | null {
  if (!pending || (predicate && !predicate(pending))) return null;
  const result = pending;
  pending = null;
  return result;
}

export function onLocate(handler: (detail: LocateDetail) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<LocateDetail>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
