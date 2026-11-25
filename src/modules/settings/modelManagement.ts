import type { EffortResolution } from "@/api";

/** UI-CR085-v1：未知值不猜测；模态手动选择优先于自动来源。 */
export function resolvedModalities<T extends { text: boolean; vision: boolean | null; imageGen: boolean; modalityManual?: boolean; modalitySource?: string | null }>(model: T, hit: EffortResolution): T {
  if (model.modalityManual || !hit.modalitySource) return model;
  return { ...model, text: hit.text ?? model.text, vision: hit.vision ?? model.vision,
    imageGen: hit.imageGen ?? model.imageGen, modalitySource: hit.modalitySource };
}

export function maskKey(value: string): string {
  const chars = Array.from(value);
  if (!chars.length) return "待填写";
  if (chars.length < 2) return "••••";
  return chars.length <= 8 ? `${chars[0]}••••${chars[chars.length - 1]}` : `${chars.slice(0, 4).join("")}••••${chars.slice(-4).join("")}`;
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** 插入槽位是移除前的位置（0..length）。 */
export const dropIndex = (from: number, at: number, after: boolean) => at + Number(after) - Number(from < at + Number(after));

export function anchoredMenu(rect: Pick<DOMRect, "top" | "bottom" | "right">, height: number, viewport: { width: number; height: number }) {
  const width = Math.max(0, Math.min(208, viewport.width - 16));
  const maxHeight = Math.max(0, Math.min(260, viewport.height - 16));
  const actualHeight = Math.min(height, maxHeight);
  const below = rect.bottom + 4;
  return { width, maxHeight, left: Math.max(8, Math.min(rect.right - width, viewport.width - width - 8)),
    top: Math.max(8, Math.min(below + actualHeight <= viewport.height - 8 ? below : rect.top - actualHeight - 4, viewport.height - actualHeight - 8)) };
}
