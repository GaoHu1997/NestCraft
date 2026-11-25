/**
 * adapters/registry.ts —— 语言适配器注册表（CR-094）。
 *
 * 职责：扩展名 → 适配器。symbols.ts 通过它决定「这个文件该用哪个解析器」。
 * 新增语言只需要：写一个 adapter 文件 + 在这里注册一行。
 */
import type { LanguageAdapter } from "./types";
import { typescriptAdapter } from "./typescript";
import { javaAdapter } from "./java";
import { csharpAdapter } from "./csharp";
import { pythonAdapter } from "./python";

/** 注册顺序即 UI 展示顺序。 */
const ADAPTERS: readonly LanguageAdapter[] = [typescriptAdapter, javaAdapter, csharpAdapter, pythonAdapter];

const byExt = new Map<string, LanguageAdapter>();
for (const adapter of ADAPTERS) {
  for (const ext of adapter.extensions) byExt.set(ext.toLowerCase(), adapter);
}

/** 所有被一个适配器支持的扩展名（小写，不含点）。 */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(byExt.keys());

/** 全部已注册适配器。 */
export function allAdapters(): readonly LanguageAdapter[] {
  return ADAPTERS;
}

function extensionOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** 该路径对应的适配器；不支持返回 null。 */
export function adapterFor(path: string): LanguageAdapter | null {
  return byExt.get(extensionOf(path)) ?? null;
}

/** 是否有适配器能解析该文件。 */
export function isSupportedSource(path: string): boolean {
  return byExt.has(extensionOf(path));
}

export function adapterById(id: string): LanguageAdapter | null {
  return ADAPTERS.find((a) => a.id === id) ?? null;
}

/**
 * 语言的界面展示名与精度说明（用于提示条与 tooltip）。
 * 未支持的语言返回 null，调用方据此显示「当前文件类型暂不支持跳转」。
 */
export function languageInfoFor(path: string): { id: string; name: string; precisionNote: string } | null {
  const adapter = adapterFor(path);
  if (!adapter) return null;
  return { id: adapter.id, name: displayName(adapter.id), precisionNote: adapter.precisionNote };
}

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  typescript: "TypeScript/JavaScript",
  java: "Java",
  csharp: "C#",
  python: "Python",
};

/** 语言展示名；未知 id 原样返回。 */
export function displayName(id: string): string {
  return DISPLAY_NAMES[id] ?? id;
}
