/**
 * symbols.ts —— 轻量符号索引（语法级，不做类型推导）。
 *
 * 纯逻辑模块：只使用 @/api 的 invoke 读取后端文件树/文件，不触达 DOM。
 *
 * 读取策略与上限（避免把整个项目读爆内存）：
 * - 首选 invoke("fs_list_tree", { rootUri, maxDepth: 12 })，字段兼容 isDir / is_dir；
 *   命令缺失或返回非数组时，回退到递归 invoke("fs_list_dir")（深度 ≤ 12）。
 * - 只收 .ts .tsx .js .jsx .mjs .cjs .py；跳过 node_modules/.git/dist/build/target/.next/out/coverage。
 * - 单文件 ≤ 2MB（后端 fs_read_file 自身 >1MB 会拒绝，按失败跳过）；总文件 ≤ 5000，超出只索引前 5000。
 * - 文件读取并发 ≤ 8，失败跳过；每个文件仅保留提取出的符号、import 映射与极短预览行，不保留全文。
 *
 * resolve 三级顺序：① 同文件声明（偏移最近）② import 本地名 → 源文件 imported 定义 ③ 全项目同名。
 */
import { invoke } from "@/api";
import { adapterFor, isSupportedSource, SUPPORTED_EXTENSIONS } from "./adapters/registry";
import type { ImportRef, TypeDecl, TypeRef } from "./adapters/types";

export type { SymbolDef, SymbolKind } from "./adapters/types";
import type { SymbolDef } from "./adapters/types";

/** 一条继承关系查询结果（CR-094）：目标定义 + 关系种类。 */
export interface TypeTarget extends SymbolDef {
  /** direct = 直接实现/直接继承；indirect = 经中间类间接得到；super = 父类型。 */
  relation: "direct" | "indirect" | "super";
  /** 中间类型名（indirect 时有值），用于界面展示「经 Xxxxx 间接实现」。 */
  via?: string;
  /** 目标声明行的源码预览。 */
  preview?: string;
}

export interface SymbolIndex {
  /** 解析 offset 处的标识符，返回 0/1/N 个定义目标；不支持的语言由 supports() 判定。 */
  resolve(text: string, path: string, offset: number): SymbolDef[];
  /** 面包屑：当前 offset 所在的符号链（由外到内）。 */
  outline(text: string, path: string, offset: number): { name: string; kind: string; line: number }[];
  /** 该文件是否在支持范围内。 */
  supports(path: string): boolean;
  /** 文件保存后失效该文件缓存。 */
  invalidate(path: string): void;
  /** CR-094：某接口/类/基类的实现或子类（含间接继承，`relation` 标注）。 */
  implementationsOf(name: string, fromPath?: string): TypeTarget[];
  /** CR-094：某类型的父类型（Java/Scala 的 extends+implements，C#/Python 的冒号或基类列表）。 */
  supertypesOf(name: string, fromPath?: string): TypeTarget[];
  /** CR-094：该名字在索引中第一次出现时的语言精度说明（用于界面提示条）。 */
  precisionFor(path: string): string | null;
  /** CR-094：该文件里的类型声明（gutter 标记用）。 */
  typesInFile(path: string): TypeDecl[];
}

/* ---------------- 常量与工具 ---------------- */

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".next", "out", "coverage", "bin", "obj", "venv", ".venv", "__pycache__", ".idea", ".vscode"]);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TARGETS = 20;
const READ_CONCURRENCY = 8;
const MAX_DEPTH = 12;
const PREVIEW_LEN = 200;

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
const pathKey = (p: string): string => norm(p).toLowerCase();
const extOf = (p: string): string => {
  const base = norm(p).split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
};
const baseName = (p: string): string => norm(p).split("/").pop() ?? p;
const baseNameNoExt = (p: string): string => {
  const b = baseName(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
};
const dirname = (p: string): string => {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i < 0 ? "" : n.slice(0, i);
};

/** 以 posix 方式拼接并归一化 . / ..；保留 unix 前导 '/' 与 Windows 盘符。 */
function joinPosix(base: string, rel: string): string {
  const abs = base.startsWith("/");
  const parts = base.split("/").concat(rel.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
    } else {
      out.push(part);
    }
  }
  return (abs ? "/" : "") + out.join("/");
}

/** 路径是否位于被跳过目录下（按 root 之后的相对段判断）。 */
function underSkipDir(path: string, rootUri: string): boolean {
  const p = norm(path);
  const r = norm(rootUri).replace(/\/$/, "").toLowerCase();
  const rel = p.toLowerCase().startsWith(r) ? p.slice(r.length) : p;
  const segs = rel.split("/").filter(Boolean);
  // 最后一段是文件名，其余为目录段
  for (let i = 0; i < segs.length - 1; i++) {
    if (SKIP_DIRS.has(segs[i].toLowerCase())) return true;
  }
  return false;
}

function countLines(text: string): number {
  const m = text.match(/\n/g);
  return (m ? m.length : 0) + 1;
}

function lineColOfOffset(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let start = 0;
  const limit = Math.max(0, Math.min(offset, text.length));
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      start = i + 1;
    }
  }
  return { line, col: limit - start + 1 };
}

function offsetOfLineCol(text: string, line: number, col: number): number {
  if (line <= 1) return Math.max(0, col - 1);
  let idx = 0;
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf("\n", idx);
    if (nl < 0) return text.length;
    idx = nl + 1;
  }
  return Math.min(text.length, idx + Math.max(0, col - 1));
}

function indentOf(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === " ") n++;
    else if (c === "\t") n++;
    else break;
  }
  return n;
}

/* ---------------- CR-094：适配器输出 → 索引内部结构 ---------------- */

/** 把适配器返回的 SymbolDef 补成 IndexedSymbol（preview / indent / endLine）。 */
function enrichSymbols(defs: SymbolDef[], text: string): IndexedSymbol[] {
  const lines = text.split(/\r?\n/);
  const out: IndexedSymbol[] = [];
  for (const d of defs) {
    const lineText = lines[d.line - 1] ?? "";
    out.push({
      ...d,
      preview: lineText.trim().slice(0, PREVIEW_LEN),
      indent: indentOf(lineText),
      endLine: d.line,
    });
  }
  out.sort((a, b) => a.line - b.line || a.col - b.col);
  // 块结束行：到下一个缩进 <= 自己的符号前一行；没有则为文件末行。
  for (let i = 0; i < out.length; i++) {
    const cur = out[i]!;
    let end = lines.length;
    for (let j = i + 1; j < out.length; j++) {
      const next = out[j]!;
      if (next.indent <= cur.indent) {
        end = next.line - 1;
        break;
      }
    }
    cur.endLine = Math.max(cur.line, end);
  }
  return out;
}

const escapedForRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 在 import / using / from / require 行里定位 local 名的 0-based 偏移；找不到返回 -1。 */
function findImportOffset(text: string, local: string): number {
  if (!local || local === "*") return -1;
  const lines = text.split(/\r?\n/);
  let base = 0;
  const re = new RegExp(`\\b${escapedForRegExp(local)}\\b`);
  for (const line of lines) {
    if (/\b(import|using|from|require)\b/.test(line)) {
      const m = re.exec(line);
      if (m) return base + m.index;
    }
    base += line.length + 1;
  }
  return -1;
}

/** 适配器的 ImportRef → 索引内部的 ImportBinding（补 offset / 目标解析基准）。 */
function toImportBindings(refs: ImportRef[], text: string, path: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const ref of refs) {
    if (!ref || !ref.local) continue;
    out.push({
      local: ref.local,
      // 内部约定：wildcard → "*"，无具名且非通配 → "default"（整模块/默认导入）。
      imported: ref.wildcard ? "*" : (ref.imported ?? "default"),
      spec: ref.source ?? "",
      target: null,
      offset: findImportOffset(text, ref.local),
      offsetPath: path,
    });
  }
  return out;
}

/* ---------------- 提取 ---------------- */

interface IndexedSymbol extends SymbolDef {
  /** 声明行去除首尾空白后的短预览（≤200 字符），供多目标选择器显示。 */
  preview: string;
  indent: number;
  /** 由缩进推导的块结束行（1-based，含）；无后随同级符号时为文件末行。 */
  endLine: number;
}

interface ImportBinding {
  local: string;
  imported: string; // "default" / "*" / 具名
  spec: string;
  target: string | null; // 解析到的绝对路径（未命中为 null，回退到全项目同名）
  offset: number; // local 在全文中的 0-based 偏移
  /** 声明该 import 的文件路径（相对路径解析基准）。 */
  offsetPath?: string;
}

interface FileEntry {
  path: string;
  symbols: IndexedSymbol[];
  imports: ImportBinding[];
  /** CR-094：该文件的类型声明与继承关系。 */
  types: TypeDecl[];
}

const METHOD_BLACKLIST = new Set([
  "if", "for", "while", "switch", "catch", "return", "else", "do", "try", "with",
  "function", "constructor", "super", "new", "typeof", "await", "yield", "delete",
  "void", "in", "of", "class", "get", "set",
]);

// 逐行匹配（不使用 g 标志，单行 exec）
const RE_FUNCTION = /^[ \t]*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
const RE_CLASS = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const RE_VAR = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;
const RE_INTERFACE = /^[ \t]*export\s+interface\s+([A-Za-z_$][\w$]*)/;
const RE_TYPE = /^[ \t]*export\s+type\s+([A-Za-z_$][\w$]*)/;
const RE_ENUM = /^[ \t]*export\s+enum\s+([A-Za-z_$][\w$]*)/;
const RE_METHOD = /^[ \t]+(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/;
const RE_PY = /^[ \t]*(?:async\s+)?(class|def)\s+([A-Za-z_][\w]*)/;

function pushMatch(
  out: IndexedSymbol[],
  path: string,
  lineText: string,
  lineNo: number,
  m: RegExpExecArray,
  name: string,
  kind: IndexedSymbol["kind"]
): void {
  const nameIdx = m[0].indexOf(name);
  if (nameIdx < 0) return;
  out.push({
    name,
    kind,
    path,
    line: lineNo,
    col: nameIdx + 1,
    preview: lineText.trim().slice(0, PREVIEW_LEN),
    indent: indentOf(lineText),
    endLine: lineNo,
  });
}

function extractSymbols(text: string, path: string): IndexedSymbol[] {
  const out: IndexedSymbol[] = [];
  const lines = text.split(/\r?\n/);
  const isPy = extOf(path) === "py";
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const lineNo = i + 1;
    if (isPy) {
      const m = RE_PY.exec(lineText);
      if (m) pushMatch(out, path, lineText, lineNo, m, m[2], m[1] === "class" ? "class" : "function");
      continue;
    }
    let matched = false;
    let m: RegExpExecArray | null;
    if ((m = RE_FUNCTION.exec(lineText))) {
      pushMatch(out, path, lineText, lineNo, m, m[1], "function");
      matched = true;
    }
    if ((m = RE_CLASS.exec(lineText))) {
      pushMatch(out, path, lineText, lineNo, m, m[1], "class");
      matched = true;
    }
    if ((m = RE_INTERFACE.exec(lineText))) {
      pushMatch(out, path, lineText, lineNo, m, m[1], "interface");
      matched = true;
    }
    if ((m = RE_TYPE.exec(lineText))) {
      pushMatch(out, path, lineText, lineNo, m, m[1], "type");
      matched = true;
    }
    if ((m = RE_ENUM.exec(lineText))) {
      pushMatch(out, path, lineText, lineNo, m, m[1], "enum");
      matched = true;
    }
    if ((m = RE_VAR.exec(lineText))) {
      pushMatch(out, path, lineText, lineNo, m, m[1], "const");
      matched = true;
    }
    if (!matched) {
      const mm = RE_METHOD.exec(lineText);
      if (mm && !METHOD_BLACKLIST.has(mm[1])) pushMatch(out, path, lineText, lineNo, mm, mm[1], "method");
    }
  }
  // 去重（同名同位置）
  const seen = new Set<string>();
  const dedup = out.filter((s) => {
    const k = `${s.name}@${s.line}:${s.col}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  dedup.sort((a, b) => (a.line - b.line) || (a.col - b.col));
  // 由缩进推导每个符号的块结束行，用于面包屑「由外到内」链条。
  for (let i = 0; i < dedup.length; i++) {
    let end = lines.length;
    for (let j = i + 1; j < dedup.length; j++) {
      if (dedup[j].indent <= dedup[i].indent) {
        end = dedup[j].line - 1;
        break;
      }
    }
    dedup[i].endLine = Math.max(dedup[i].line, end);
  }
  return dedup;
}

function extractImports(text: string, path: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  const seen = new Set<string>();
  const add = (local: string, imported: string, spec: string, offset: number) => {
    if (!local || !spec) return;
    const k = `${local}@${offset}`;
    if (seen.has(k)) return;
    seen.add(k);
    bindings.push({ local, imported, spec, target: null, offset });
  };
  const splitNamed = (raw: string): { local: string; imported: string }[] => {
    const out: { local: string; imported: string }[] = [];
    for (const piece of raw.split(",")) {
      let item = piece.trim();
      if (!item) continue;
      item = item.replace(/^type\s+/, "");
      const asMatch = /\s+as\s+/.exec(item);
      if (asMatch) {
        const imported = item.slice(0, asMatch.index).trim();
        const local = item.slice(asMatch.index + asMatch[0].length).trim();
        if (imported && local) out.push({ local, imported });
      } else {
        out.push({ local: item, imported: item });
      }
    }
    return out;
  };

  if (extOf(path) === "py") {
    const lines = text.split(/\r?\n/);
    let cursor = 0;
    for (const line of lines) {
      const lineStart = cursor;
      cursor += line.length + 1;
      const fromM = /^\s*from\s+([.\w]+)\s+import\s+(.+?)\s*(?:#.*)?$/.exec(line);
      if (fromM) {
        const mod = fromM[1];
        const names = fromM[2].replace(/[()]/g, "");
        for (const piece of names.split(",")) {
          const item = piece.trim();
          if (!item || item === "*") continue;
          const asM = /\s+as\s+/.exec(item);
          const imported = asM ? item.slice(0, asM.index).trim() : item;
          const local = asM ? item.slice(asM.index + asM[0].length).trim() : item;
          if (!local) continue;
          const localOffset = lineStart + Math.max(0, line.indexOf(item) + (asM ? asM.index + asM[0].length : 0));
          add(local, imported, `__py__:${mod}`, localOffset);
        }
        continue;
      }
      const impM = /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*(?:#.*)?$/.exec(line);
      if (impM) {
        const mod = impM[1];
        const local = impM[2] || mod.split(".").pop() || mod;
        const localOffset = lineStart + Math.max(0, line.indexOf(local));
        add(local, "*", `__py__:${mod}`, localOffset);
      }
    }
  } else {
    // import * as ns from "…"
    const reNs = /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = reNs.exec(text))) {
      add(m[1], "*", m[2], m.index + m[0].indexOf(m[1]));
    }
    // import { a as b, c } from "…"（含 import type）
    const reNamed = /\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
    while ((m = reNamed.exec(text))) {
      for (const item of splitNamed(m[1])) {
        add(item.local, item.imported, m[2], m.index + Math.max(0, m[0].indexOf(item.local)));
      }
    }
    // import X, { a } from "…" / import X from "…"
    const reDefault = /\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;
    while ((m = reDefault.exec(text))) {
      add(m[1], "default", m[3], m.index + m[0].indexOf(m[1]));
      if (m[2]) {
        for (const item of splitNamed(m[2])) {
          add(item.local, item.imported, m[3], m.index + Math.max(0, m[0].indexOf(item.local)));
        }
      }
    }
    // export { a } from "…"（re-export 视为对外部定义的引用）
    const reReexport = /\bexport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
    while ((m = reReexport.exec(text))) {
      for (const item of splitNamed(m[1])) {
        add(item.local, item.imported, m[2], m.index + Math.max(0, m[0].indexOf(item.local)));
      }
    }
  }
  return bindings;
}

/* ---------------- 路径解析与读取 ---------------- */

type RawNode = {
  name?: string;
  path?: string;
  isDir?: boolean;
  is_dir?: boolean;
  size?: number | null;
};
type SourceFile = { path: string; size: number | null };

async function listViaTree(rootUri: string): Promise<SourceFile[]> {
  const raw = await invoke<RawNode[]>("fs_list_tree", { rootUri, maxDepth: MAX_DEPTH });
  if (!Array.isArray(raw)) throw new Error("fs_list_tree 返回非数组");
  const out: SourceFile[] = [];
  for (const node of raw) {
    const p = node?.path;
    if (!p) continue;
    const isDir = node.isDir ?? node.is_dir ?? false;
    if (isDir) continue;
    if (!SUPPORTED_EXTENSIONS.has(extOf(p))) continue;
    if (underSkipDir(p, rootUri)) continue;
    const size = typeof node.size === "number" ? node.size : null;
    if (size != null && size > MAX_FILE_BYTES) continue;
    out.push({ path: p, size });
  }
  return out;
}

async function listViaWalk(rootUri: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: "", depth: 0 }];
  let visited = 0;
  while (queue.length && out.length < MAX_FILES && visited < MAX_FILES * 4) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    visited++;
    let nodes: RawNode[];
    try {
      nodes = await invoke<RawNode[]>("fs_list_dir", { rootUri, relPath: dir });
    } catch {
      continue;
    }
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      const p = node?.path;
      if (!p) continue;
      if (underSkipDir(p, rootUri)) continue;
      const isDir = node.isDir ?? node.is_dir ?? false;
      if (isDir) {
        if (depth + 1 <= MAX_DEPTH) queue.push({ dir: p, depth: depth + 1 });
        continue;
      }
      if (!SUPPORTED_EXTENSIONS.has(extOf(p))) continue;
      const size = typeof node.size === "number" ? node.size : null;
      if (size != null && size > MAX_FILE_BYTES) continue;
      out.push({ path: p, size });
    }
  }
  return out;
}

async function listSourceFiles(rootUri: string): Promise<SourceFile[]> {
  let files: SourceFile[];
  try {
    files = await listViaTree(rootUri);
  } catch {
    files = await listViaWalk(rootUri);
  }
  // 去重 & 上限 5000
  const seen = new Set<string>();
  const unique: SourceFile[] = [];
  for (const f of files) {
    const k = pathKey(f.path);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(f);
    if (unique.length >= MAX_FILES) break;
  }
  return unique;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        results[i] = undefined;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/* ---------------- 索引实现 ---------------- */

interface ResolveArray extends Array<SymbolDef> {
  tooMany?: boolean;
}

class IndexImpl implements SymbolIndex {
  private byPath = new Map<string, FileEntry>();
  private byName = new Map<string, IndexedSymbol[]>();
  private pathKeys = new Set<string>();
  /** CR-094：类型名 → 声明。 */
  private byTypeName = new Map<string, TypeDecl[]>();
  /** CR-094：父类型 plain 名 → 直接继承/实现它的类型声明（反向索引）。 */
  private bySuper = new Map<string, TypeDecl[]>();

  constructor(entries: FileEntry[]) {
    for (const entry of entries) {
      this.addEntry(entry);
    }
  }

  private addEntry(entry: FileEntry): void {
    const k = pathKey(entry.path);
    this.byPath.set(k, entry);
    this.pathKeys.add(k);
    for (const sym of entry.symbols) {
      const list = this.byName.get(sym.name);
      if (list) list.push(sym);
      else this.byName.set(sym.name, [sym]);
    }
    const types = entry.types ?? [];
    for (const t of types) {
      const same = this.byTypeName.get(t.name);
      if (same) same.push(t);
      else this.byTypeName.set(t.name, [t]);
      for (const ref of [...t.supers, ...t.interfaces]) {
        const children = this.bySuper.get(ref.plain);
        if (children) children.push(t);
        else this.bySuper.set(ref.plain, [t]);
      }
    }
  }

  supports(path: string): boolean {
    return isSupportedSource(path);
  }

  invalidate(path: string): void {
    const k = pathKey(path);
    const entry = this.byPath.get(k);
    if (!entry) return;
    for (const sym of entry.symbols) {
      const list = this.byName.get(sym.name);
      if (!list) continue;
      const idx = list.indexOf(sym);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) this.byName.delete(sym.name);
    }
    // CR-094：同步清掉类型与反向继承索引，避免改名/删类后残留。
    for (const t of entry.types ?? []) {
      const same = this.byTypeName.get(t.name);
      if (same) {
        const i = same.indexOf(t);
        if (i >= 0) same.splice(i, 1);
        if (!same.length) this.byTypeName.delete(t.name);
      }
      for (const ref of [...t.supers, ...t.interfaces]) {
        const children = this.bySuper.get(ref.plain);
        if (!children) continue;
        const i = children.indexOf(t);
        if (i >= 0) children.splice(i, 1);
        if (!children.length) this.bySuper.delete(ref.plain);
      }
    }
    this.byPath.delete(k);
    this.pathKeys.delete(k);
  }

  /* ---------------- CR-094：继承关系查询 ---------------- */

  implementationsOf(name: string, fromPath?: string): TypeTarget[] {
    try {
      const plain = name?.trim();
      if (!plain) return [];
      const out: TypeTarget[] = [];
      const seen = new Set<string>();
      const keyOf = (t: TypeDecl) => `${pathKey(t.path)}#${t.line}:${t.col}`;
      // 不允许把「自己」当自己的实现：从查询来源文件里排除同名声明。
      const selfKeys = new Set<string>();
      if (fromPath) {
        for (const t of this.byTypeName.get(plain) ?? []) {
          if (pathKey(t.path) === pathKey(fromPath)) selfKeys.add(keyOf(t));
        }
      }

      const direct = this.bySuper.get(plain) ?? [];
      for (const t of direct) {
        const k = keyOf(t);
        if (seen.has(k) || selfKeys.has(k)) continue;
        seen.add(k);
        out.push({ ...typeToSymbol(t), relation: "direct" });
      }

      // 间接：B implements I，A extends B → A 是 I 的间接实现。最多 3 层，防环。
      let frontier = direct.map((t) => t.name);
      for (let depth = 0; depth < 3 && frontier.length; depth++) {
        const next: string[] = [];
        for (const superName of frontier) {
          for (const t of this.bySuper.get(superName) ?? []) {
            const k = keyOf(t);
            if (seen.has(k) || selfKeys.has(k)) continue;
            seen.add(k);
            out.push({ ...typeToSymbol(t), relation: "indirect", via: superName });
            next.push(t.name);
          }
        }
        frontier = next;
      }
      // 直接实现优先展示，其次按路径与行号稳定排序。
      out.sort((a, b) => (a.relation === b.relation ? 0 : a.relation === "direct" ? -1 : 1));
      return out.slice(0, MAX_TARGETS);
    } catch {
      return [];
    }
  }

  supertypesOf(name: string, fromPath?: string): TypeTarget[] {
    try {
      const plain = name?.trim();
      if (!plain) return [];
      const decls = this.byTypeName.get(plain) ?? [];
      // 多个声明时优先同文件/同目录的那一个（近似处理同名跨包）。
      const ordered = fromPath
        ? [...decls].sort((a, b) => score(a, fromPath) - score(b, fromPath))
        : decls;
      const out: TypeTarget[] = [];
      const seen = new Set<string>();
      for (const t of ordered) {
        for (const ref of [...t.supers, ...t.interfaces]) {
          for (const target of this.byTypeName.get(ref.plain) ?? []) {
            const k = `${pathKey(target.path)}#${target.line}:${target.col}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ ...typeToSymbol(target), relation: "super" });
          }
        }
      }
      return out.slice(0, MAX_TARGETS);
    } catch {
      return [];
    }
  }

  precisionFor(path: string): string | null {
    return adapterFor(path)?.precisionNote ?? null;
  }

  typesInFile(path: string): TypeDecl[] {
    try {
      return this.byPath.get(pathKey(path))?.types ?? [];
    } catch {
      return [];
    }
  }

  resolve(text: string, path: string, offset: number): SymbolDef[] {
    try {
      if (!this.supports(path)) return [];
      const word = wordAt(text, offset);
      if (!word) return [];
      const fileKey = pathKey(path);
      const entry = this.byPath.get(fileKey);

      // ① 同文件声明（偏移最近的同名）
      if (entry) {
        const sameFile = entry.symbols.filter((s) => s.name === word.word);
        if (sameFile.length) {
          const cursor = lineColOfOffset(text, offset);
          let best = sameFile[0];
          let bestScore = Number.POSITIVE_INFINITY;
          for (const s of sameFile) {
            const score = Math.abs(s.line - cursor.line) * 1000 + Math.abs(s.col - cursor.col);
            if (score < bestScore) {
              bestScore = score;
              best = s;
            }
          }
          return [toPublic(best)];
        }
        // ② offset 落在 import 的本地名上 → 源文件里的 imported 定义
        for (const imp of entry.imports) {
          if (imp.local !== word.word) continue;
          const near = Math.abs(imp.offset - word.start) <= 1 || (offset >= imp.offset && offset <= imp.offset + imp.local.length + 1);
          if (!near) continue;
          const resolved = this.resolveImport(imp);
          if (resolved.length) return resolved;
        }
      }

      // ③ 全项目同名（去重后 ≤20 返回全部，>20 返回空并标记 tooMany）
      const all = this.byName.get(word.word);
      if (!all || !all.length) return [];
      const dedup: IndexedSymbol[] = [];
      const seen = new Set<string>();
      for (const s of all) {
        const k = `${pathKey(s.path)}#${s.line}:${s.col}`;
        if (seen.has(k)) continue;
        seen.add(k);
        dedup.push(s);
      }
      if (dedup.length > MAX_TARGETS) {
        const arr: ResolveArray = [];
        arr.tooMany = true;
        return arr;
      }
      return dedup.map(toPublic);
    } catch {
      return [];
    }
  }

  private resolveImport(imp: ImportBinding): SymbolDef[] {
    const targetPath = this.resolveTarget(imp);
    if (!targetPath) return [];
    const entry = this.byPath.get(pathKey(targetPath));
    if (!entry) return [];
    if (imp.imported === "default" || imp.imported === "*") {
      const base = baseNameNoExt(targetPath);
      const guess =
        entry.symbols.find((s) => s.name === base) ||
        entry.symbols.find((s) => s.kind === "class" || s.kind === "function") ||
        entry.symbols[0];
      return guess ? [toPublic(guess)] : [];
    }
    const hits = entry.symbols.filter((s) => s.name === imp.imported);
    if (!hits.length) return [];
    if (hits.length > MAX_TARGETS) {
      const arr: ResolveArray = [];
      arr.tooMany = true;
      return arr;
    }
    return hits.map(toPublic);
  }

  private resolveTarget(imp: ImportBinding): string | null {
    if (imp.target !== null) return imp.target;
    let resolved: string | null = null;
    if (imp.spec.startsWith("__py__:")) {
      const mod = imp.spec.slice("__py__:".length);
      const dots = /^\.+/.exec(mod)?.[0].length ?? 0;
      const modulePath = mod.replace(/^\.+/, "").replace(/\./g, "/");
      if (dots > 0) {
        let rel = dots === 1 ? "./" : "../".repeat(dots - 1);
        rel += modulePath || "";
        resolved = this.matchSpecifier(imp, rel);
      } else {
        resolved = null; // 绝对导入（第三方/包）不解析
      }
    } else if (imp.spec.startsWith(".")) {
      resolved = this.matchSpecifier(imp, imp.spec);
    }
    imp.target = resolved;
    return resolved;
  }

  private matchSpecifier(imp: ImportBinding, spec: string): string | null {
    const target = joinPosix(dirname(imp.offsetPath ?? ""), spec);
    const exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".d.ts"];
    const candidates: string[] = [];
    for (const e of exts) candidates.push(target + e);
    for (const e of exts) candidates.push(target.replace(/\/$/, "") + "/index" + e);
    for (const e of exts) candidates.push(target.replace(/\/$/, "") + "/__init__" + e);
    for (const c of candidates) {
      const k = pathKey(c);
      if (this.pathKeys.has(k)) {
        const entry = this.byPath.get(k);
        if (entry) return entry.path;
      }
    }
    return null;
  }

  outline(text: string, path: string, offset: number): { name: string; kind: string; line: number }[] {
    try {
      if (!this.supports(path)) return [];
      const entry = this.byPath.get(pathKey(path));
      if (!entry) return [];
      const cursor = lineColOfOffset(text, offset);
      const targetIndent = indentAt(text, cursor.line);
      const chains: IndexedSymbol[] = [];
      for (const s of entry.symbols) {
        const isSameLine = s.line === cursor.line;
        const contains = s.line <= cursor.line && cursor.line <= s.endLine;
        if (!contains) continue;
        // 必须是光标所在行的外层（缩进更小）或同行声明本身
        if (isSameLine || targetIndent > s.indent) chains.push(s);
      }
      chains.sort((a, b) => (a.indent - b.indent) || (a.line - b.line));
      // 同一缩进层保留最靠近光标的那一个
      const out: { name: string; kind: string; line: number }[] = [];
      let lastIndent = -1;
      for (const s of chains) {
        if (s.indent === lastIndent) {
          out[out.length - 1] = { name: s.name, kind: s.kind, line: s.line };
        } else {
          out.push({ name: s.name, kind: s.kind, line: s.line });
          lastIndent = s.indent;
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}

function indentAt(text: string, line: number): number {
  const lines = text.split(/\r?\n/);
  const lineText = lines[line - 1] ?? "";
  return indentOf(lineText);
}

function toPublic(s: IndexedSymbol): SymbolDef {
  // 保留 preview 等附加字段（运行时供多目标选择器使用），接口只需声明的字段。
  return s as SymbolDef;
}

/** CR-094：TypeDecl → 可跳转的符号位置。 */
const typeToSymbol = (t: TypeDecl): SymbolDef & { preview?: string } => ({
  name: t.name,
  kind: t.kind,
  path: t.path,
  line: t.line,
  col: t.col,
  ...(t.preview ? { preview: t.preview } : {}),
});

/** CR-094：同名类型的偏好打分（同文件 0 < 同目录 1 < 其它 2）。 */
function score(t: TypeDecl, fromPath: string): number {
  if (pathKey(t.path) === pathKey(fromPath)) return 0;
  return dirname(pathKey(t.path)) === dirname(pathKey(fromPath)) ? 1 : 2;
}

function wordAt(text: string, offset: number): { word: string; start: number; end: number } | null {
  const isId = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
  if (offset < 0 || offset > text.length) return null;
  let start = offset;
  if (start > 0 && isId(text[start - 1])) start--;
  else if (!(start < text.length && isId(text[start]))) return null;
  let end = start;
  while (start > 0 && isId(text[start - 1])) start--;
  while (end < text.length && isId(text[end])) end++;
  if (end <= start) return null;
  return { word: text.slice(start, end), start, end };
}

/* ---------------- 公共构建入口 ---------------- */

/**
 * 从内存文本构建索引（不读磁盘）。
 * 用途：自动化验证；也为将来「未保存缓冲区参与跳转」留出入口。
 */
export function buildIndexFromTexts(files: ReadonlyArray<{ path: string; text: string }>): SymbolIndex {
  const entries: FileEntry[] = [];
  for (const file of files) {
    const adapter = adapterFor(file.path);
    if (!adapter) continue;
    try {
      const parsed = adapter.parse(file.text, file.path);
      const lines = file.text.split(/\r?\n/);
      entries.push({
        path: file.path,
        symbols: enrichSymbols(parsed.symbols, file.text),
        imports: toImportBindings(parsed.imports, file.text, file.path),
        types: parsed.types.map((t) => ({
          ...t,
          preview: (lines[t.line - 1] ?? "").trim().slice(0, PREVIEW_LEN),
        })),
      });
    } catch {
      // 单文件解析失败只跳过该文件
    }
  }
  return new IndexImpl(entries);
}

export async function buildIndex(rootUri: string): Promise<SymbolIndex> {
  const files = await listSourceFiles(rootUri);
  const loaded = await pool(files, READ_CONCURRENCY, async (file) => {
    try {
      if (!adapterFor(file.path)) return null;
      const text = await invoke<string>("fs_read_file", { rootUri, path: file.path });
      return typeof text === "string" ? { path: file.path, text } : null;
    } catch {
      return null;
    }
  });
  const texts = loaded.filter((f): f is { path: string; text: string } => !!f);
  return buildIndexFromTexts(texts);
}

/* ---------------- 共享索引缓存（扩展与面包屑复用同一份） ---------------- */

const sharedCache = new Map<string, Promise<SymbolIndex>>();

/** 以 root 为键共享 buildIndex 结果，失败时清理缓存以便重试。 */
export function sharedIndex(rootUri: string): Promise<SymbolIndex> {
  const k = rootUri || "";
  const hit = sharedCache.get(k);
  if (hit) return hit;
  const p = buildIndex(rootUri).catch((err) => {
    sharedCache.delete(k);
    throw err;
  });
  sharedCache.set(k, p);
  return p;
}

/** 清空共享缓存（切换项目时调用）；不传参数清空全部。 */
export function resetSharedIndex(rootUri?: string): void {
  if (rootUri === undefined) sharedCache.clear();
  else sharedCache.delete(rootUri || "");
}
