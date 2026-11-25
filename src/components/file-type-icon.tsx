import type { CSSProperties, ReactNode } from "react";
import "@/theme/cr080-file-icons.css";

/**
 * UI-CR080-v1：知识库 / 办公项目文件类型彩色图标（B · 淡底描边变体）。
 * 唯一图形来源：docs/UI/file-type-icons/index.html（14 类，含目录）。
 * 上色：容器 span 带 k-<kind> 绑定 --ftc / --ftc-bg，.fti-soft 派生 --ft-fill 等；
 * 图元用内联 style 的 var() 取值——不依赖外部后代选择器，深色主题由 CSS 变量覆盖。
 * 与 icon-tiles 的 FILE_TYPE_GLYPHS（线稿单色）并存；本组件只用于文件树/文档头展示。
 */

export type FileKind =
  | "folder" | "md" | "html" | "text" | "json" | "csv" | "image"
  | "pdf" | "word" | "excel" | "ppt" | "drawio" | "zip" | "unknown";

/** 扩展名 → 类型。代码类归入“纯文本”（知识库/办公不解析语法，仅按文本登记阅读）。 */
const EXT_TO_KIND: Record<string, FileKind> = {
  md: "md", markdown: "md", mdx: "md",
  html: "html", htm: "html",
  txt: "text", log: "text", text: "text", ini: "text", conf: "text", rtf: "text",
  ts: "text", tsx: "text", js: "text", jsx: "text", mjs: "text", cjs: "text",
  py: "text", yaml: "text", yml: "text", toml: "text", css: "text", scss: "text",
  sh: "text", bash: "text", rs: "text", go: "text", java: "text", c: "text", h: "text", cpp: "text",
  json: "json",
  csv: "csv", tsv: "csv",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  svg: "image", bmp: "image", ico: "image", tif: "image", tiff: "image",
  pdf: "pdf",
  doc: "word", docx: "word", dot: "word", dotx: "word", odt: "word",
  xls: "excel", xlsx: "excel", ods: "excel",
  ppt: "ppt", pptx: "ppt", pps: "ppt", pot: "ppt", odp: "ppt",
  drawio: "drawio",
  zip: "zip", "7z": "zip", rar: "zip", tar: "zip", gz: "zip",
};

/** 名字或扩展名 → 类型；无法识别回退 unknown（不阻止上传/阅读元信息）。 */
export function fileKindOf(nameOrExt: string): FileKind {
  const raw = String(nameOrExt ?? "").trim();
  if (!raw) return "unknown";
  const lower = raw.toLowerCase();
  const base = lower.split(/[\\/]/).pop() || lower;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1) : base;
  return EXT_TO_KIND[ext] ?? "unknown";
}

const S_BODY: CSSProperties = { fill: "var(--ft-fill)", stroke: "var(--ft-stroke)", strokeWidth: "var(--ft-sw)", strokeLinejoin: "round" };
const S_FOLD: CSSProperties = { fill: "var(--ftc)", opacity: "var(--ft-fold-op)" };
const S_DEEP: CSSProperties = { fill: "var(--ftc)", opacity: "var(--ft-deep-op)" };
const S_G: CSSProperties = { fill: "none", stroke: "var(--ft-glyph)", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" };
const S_GH: CSSProperties = { fill: "none", stroke: "var(--ft-glyph)", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" };
const S_GF: CSSProperties = { fill: "var(--ft-glyph)" };

/** 统一纸张轮廓：16×18、圆角 2、右上 7×7 折角。 */
const PAGE = "M6 3h7l7 7v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z";
const FOLD = "M13 3v3.2A2 2 0 0 0 15 8.2h5z";

const SHAPES: Record<FileKind, ReactNode> = {
  folder: (
    <>
      <path style={S_DEEP} d="M3.2 7.1a2 2 0 0 1 2-2h4.1l2.1 2.3h7.4a2 2 0 0 1 2 2v1.2H3.2z" />
      <path style={S_BODY} d="M3.2 8.6h17.6v9.5a2 2 0 0 1-2 2H5.2a2 2 0 0 1-2-2z" />
    </>
  ),
  md: (
    <>
      <path style={S_BODY} d={PAGE} />
      <path style={S_FOLD} d={FOLD} />
      <path style={S_G} d="M6.6 17.2v-4.1l2.6 3 2.6-3v4.1M14.4 13.1v4.1M13.1 16l1.3 1.4 1.3-1.4" />
    </>
  ),
  html: (
    <>
      <path style={S_BODY} d={PAGE} />
      <path style={S_FOLD} d={FOLD} />
      <path style={S_GH} d="m9.4 12.6-2.7 2.5 2.7 2.5m5.2-5 2.7 2.5-2.7 2.5m-1.9-5.9-1.5 6.8" />
    </>
  ),
  text: (
    <>
      <path style={S_BODY} d={PAGE} />
      <path style={S_FOLD} d={FOLD} />
      <path style={S_G} d="M7.2 12.8h9.6M7.2 15.4h9.6M7.2 18h5.6" />
    </>
  ),
  json: (
    <>
      <path style={S_BODY} d={PAGE} />
      <path style={S_FOLD} d={FOLD} />
      <path style={S_GH} d="M10.7 12.5c-1.9 0-1.9 4.9 0 4.9M13.3 12.5c1.9 0 1.9 4.9 0 4.9" />
      <circle style={S_GF} cx="12" cy="14.95" r="1.05" />
    </>
  ),
  csv: (
    <>
      <path style={S_BODY} d={PAGE} />
      <path style={S_FOLD} d={FOLD} />
      <rect style={S_GH} x="6.9" y="12.4" width="10.2" height="5.2" rx="1" />
      <path style={S_GH} d="M6.9 14.5h10.2M12 12.4v5.2" />
    </>
  ),
  image: (
    <>
      <path style={S_BODY} d={PAGE} />
      <path style={S_FOLD} d={FOLD} />
      <circle style={S_GF} cx="14.7" cy="13" r="1.25" />
      <path style={S_GF} d="M6.9 17.8l3.5-4.5 2.2 2.7 1.6-2 3 3.8z" />
    </>
  ),
  pdf: (
    <>
      <path style={S_BODY} d={PAGE} />
      <path style={S_FOLD} d={FOLD} />
      <path style={S_GF} d="M9.3 12.1v6.6l2.7-2.2 2.7 2.2v-6.6z" />
    </>
  ),
  word: (
    <>
      <path style={S_BODY} d={PAGE} />
      <path style={S_FOLD} d={FOLD} />
      <rect style={S_GF} x="7" y="12.2" width="10" height="2.4" rx=".8" />
      <path style={S_G} d="M7 17.1h6.6" />
    </>
  ),
  excel: (
    <>
      <path style={S_BODY} d={PAGE} />
      <path style={S_FOLD} d={FOLD} />
      <rect style={S_GF} x="12" y="14.5" width="5.1" height="3.1" rx=".5" />
      <rect style={S_GH} x="6.9" y="12.1" width="10.2" height="5.6" rx="1" />
      <path style={S_GH} d="M6.9 14.4h10.2M12 11.6v6.6" />
    </>
  ),
  ppt: (
    <>
      <path style={S_BODY} d={PAGE} />
      <path style={S_FOLD} d={FOLD} />
      <rect style={S_GH} x="6.7" y="11.9" width="10.6" height="6.3" rx="1.1" />
      <rect style={S_GF} x="8.8" y="14.6" width="1.7" height="2.3" rx=".4" />
      <rect style={S_GF} x="11.8" y="13.5" width="1.7" height="3.4" rx=".4" />
    </>
  ),
  drawio: (
    <>
      <path style={S_BODY} d={PAGE} />
      <path style={S_FOLD} d={FOLD} />
      <path style={S_GH} d="M9.4 13.7l1.5 1.2M13.1 14.9l1.5-1.2" />
      <circle style={S_GF} cx="8.2" cy="12.9" r="1.35" />
      <circle style={S_GF} cx="12" cy="15.5" r="1.35" />
      <circle style={S_GF} cx="15.8" cy="12.9" r="1.35" />
    </>
  ),
  zip: (
    <>
      <path style={S_BODY} d={PAGE} />
      <path style={S_FOLD} d={FOLD} />
      <path style={S_G} d="M10.6 12.2h2.8M10.6 14.2h2.8M10.6 16.2h2.8" />
      <rect style={S_GF} x="10.5" y="17.1" width="3" height="2.2" rx=".6" />
    </>
  ),
  unknown: (
    <>
      <path style={S_BODY} d={PAGE} />
      <path style={S_FOLD} d={FOLD} />
      <path style={S_G} d="M9.9 13.4a2.15 2.15 0 1 1 3 2c-.7.35-.9.8-.9 1.5" />
      <circle style={S_GF} cx="12" cy="18.5" r=".95" />
    </>
  ),
};

/** 文件类型彩色图标（B 淡底描边）。kind 由 fileKindOf 或直接指定（目录用 "folder"）。 */
export function FileTypeIcon({ kind, size = 16, className, title }: {
  kind: FileKind;
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={`fti fti-soft k-${kind}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size } as CSSProperties}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <svg viewBox="0 0 24 24" focusable="false">{SHAPES[kind]}</svg>
    </span>
  );
}
