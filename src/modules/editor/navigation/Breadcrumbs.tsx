/**
 * Breadcrumbs.tsx —— 编辑器顶部面包屑（SC-090-10）：`文件名 › 符号链…`。
 *
 * - 符号链由 SymbolIndex.outline(text, path, offsetOfLine(line)) 得出（由外到内）。
 * - 每段可点击：文件名段跳到第 1 行，符号段跳到自己所在行。
 * - 无文件时返回 null；窄屏由 CSS flex-wrap 换行。
 */
import { Fragment, useMemo } from "react";
import type { SymbolIndex } from "./symbols";
import "./navigation.css";

function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 计算第 line 行（1-based）起始字符偏移。 */
function offsetOfLine(text: string, line: number): number {
  if (line <= 1) return 0;
  let index = 0;
  for (let i = 1; i < line; i++) {
    const next = text.indexOf("\n", index);
    if (next < 0) return text.length;
    index = next + 1;
  }
  return Math.min(index, text.length);
}

export function Breadcrumbs(props: {
  path: string | null;
  text: string | null;
  index: SymbolIndex | null;
  line: number;
  onNavigate: (line: number, col?: number) => void;
}): JSX.Element | null {
  const { path, text, index, line, onNavigate } = props;

  const crumbs = useMemo(() => {
    if (!path || !text || !index) return [] as { name: string; kind: string; line: number }[];
    try {
      return index.outline(text, path, offsetOfLine(text, Math.max(1, line)));
    } catch {
      return [] as { name: string; kind: string; line: number }[];
    }
  }, [path, text, index, line]);

  if (!path) return null;

  return (
    <nav className="cda-crumb-bar" aria-label="面包屑">
      <button type="button" className="cda-crumb cda-crumb-file" title={path} onClick={() => onNavigate(1)}>
        {baseName(path)}
      </button>
      {crumbs.map((crumb, index2) => (
        <Fragment key={`${crumb.line}:${crumb.name}:${index2}`}>
          <span className="cda-crumb-sep" aria-hidden="true">
            ›
          </span>
          <button type="button" className="cda-crumb" title={`第 ${crumb.line} 行`} onClick={() => onNavigate(crumb.line)}>
            {crumb.name}
          </button>
        </Fragment>
      ))}
    </nav>
  );
}
