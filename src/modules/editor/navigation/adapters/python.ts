/**
 * adapters/python.ts —— Python 语言适配器（CR-094）。
 *
 * 能力边界（与 types.ts 契约一致）：
 * - 只识别源码里**显式写出**的基类列表；Python 没有接口概念，基类统一放 `supers`，
 *   `interfaces` 恒为空数组（界面叫「父类型」，不谎称是接口）；
 * - `abstract` = 基类列表含 `ABC` / `ABCMeta`（含 `metaclass=ABCMeta`），
 *   或类体内出现 `@abstractmethod` 装饰的方法；
 * - `class WithMeta(IFoo, metaclass=ABCMeta)` 里的 `metaclass=ABCMeta`、`foo=bar`
 *   是 keyword 参数而**不是基类**，必须按 `=` 过滤掉。
 *
 * 实现要点：
 * 1. 先把注释与字符串字面量替换成**等长空白**（保留换行、引号与正文一起抹平），
 *    这样行号、列号和原文严格一致（1-based），后续正则不会被
 *    `# class Fake(Base):`、`"""class Fake(Base):"""`、`s = "class Fake(Base):"` 误导；
 * 2. 之后只做**一次线性扫描**：类声明的基类列表用跨行括号配对取 `(...)` 内部文本，
 *    `from X import (` 的多行 import 也一次配对跳过，避免对每个类重复扫全文；
 * 3. 类体归属用「按缩进维护的类栈」判定，不用为每个类回头再扫一遍正文。
 *
 * 纯函数，绝不抛异常：任何内部错误都退化为 `emptyParsed()`。
 */
import {
  type ImportRef,
  type LanguageAdapter,
  type ParsedFile,
  type TypeDecl,
  type TypeRef,
  emptyParsed,
  parseTypeList,
} from "./types";

/** 类声明（允许任意缩进，嵌套类也要能识别）。第 1 组是「名字之前的全部前缀」，用于算列号。 */
const CLASS_RE = /^(\s*class\s+)([A-Za-z_]\w*)/;
/** 函数 / 方法声明（`async def` 同规则）；第 1 组同样只含名字前缀。 */
const DEF_RE = /^(\s*(?:async\s+)?def\s+)([A-Za-z_]\w*)\s*\(/;
/** 模块级常量：`MAX_SIZE = 10` / `API_URL: str = "..."`（`==` 不算）。 */
const CONST_RE = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]*)?=(?!=)/;
/** `import os` / `import numpy as np` / `import a.b.c`。 */
const IMPORT_RE = /^\s*import\s+(.+)$/;
/** `from .models import PayService` / `from . import sibling` / `from x import *`。 */
const FROM_RE = /^\s*from\s+([A-Za-z_.][\w.]*)\s+import\s+(.*)$/;
/** `@abstractmethod` 或 `@abc.abstractmethod`。 */
const ABSTRACT_DECO_RE = /^\s*@\s*(?:[A-Za-z_]\w*\s*\.\s*)*abstractmethod\b/;
/** keyword 参数（`metaclass=ABCMeta`、`foo=bar`）：不是基类。 */
const KEYWORD_ARG_RE = /^[A-Za-z_]\w*\s*=/;

/**
 * 把注释与字符串字面量抹成等长空白（换行原样保留）。
 *
 * 处理：`#` 行注释、`"""..."""`、`'''...'''`（可跨行）、`"..."`、`'...'`。
 * 抹平后长度不变 → 行/列偏移不需要任何重算。
 */
function maskPythonLiterals(src: string): string {
  const buf = src.split("");
  const n = src.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (buf[k] !== "\n") buf[k] = " ";
    }
  };

  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === "#") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c + c + c, i);
      let j = i + (triple ? 3 : 1);
      while (j < n) {
        const d = src[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        // 单行字符串不跨行：遇到换行即视作未闭合，只抹到行尾。
        if (!triple && d === "\n") break;
        if (triple) {
          if (src.startsWith(c + c + c, j)) {
            j += 3;
            break;
          }
        } else if (d === c) {
          j += 1;
          break;
        }
        j++;
      }
      if (j > n) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    i++;
  }
  return buf.join("");
}

/** 从 `open` 处的 `(` 找配对的 `)`，找不到返回 -1（已抹掉字符串/注释，括号不会被误算）。 */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按顶层逗号切分（忽略 `()` `[]` `{}` 内部的逗号）。 */
function splitTopComma(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 去掉 Python 泛型下标（`Base[T]`、`Base[T, U]`、`typing.Callable[[int], str]` → 外层名）。
 * 共用工具 `plainTypeName` 只截断 `<>`，不认 `[...]`，所以这里先剥掉再来。
 */
function stripSubscripts(raw: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "[") depth++;
    else if (c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out.trim();
}

/** 绝对偏移 → 行号（0-based），`starts` 为每行行首绝对偏移。 */
function lineAt(starts: readonly number[], abs: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= abs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 去掉限定名 / 泛型后的末段名：`abc.ABCMeta` → `ABCMeta`。 */
function lastSegment(raw: string): string {
  const s = raw.trim();
  const dot = s.lastIndexOf(".");
  return dot >= 0 ? s.slice(dot + 1) : s;
}

/** 真正解析（异常由对外 `parse` 兜底）。 */
function parsePython(text: string, path: string): ParsedFile {
  const result: ParsedFile = emptyParsed();
  if (!text) return result;

  // 统一换行，保证 split("\n") 的行数与偏移计算一致（\r 只出现在行尾，不影响列号）。
  const src = text.replace(/\r\n?/g, "\n");
  const masked = maskPythonLiterals(src);

  const lines = masked.split("\n");
  const starts: number[] = new Array(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = offset;
    offset += lines[i]!.length + 1;
  }

  /** 按缩进维护的类栈：用于把 `@abstractmethod` 归到最近的类，无需回头扫正文。 */
  const classStack: { indent: number; decl: TypeDecl }[] = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (!line.trim()) continue;

    const indent = line.length - line.trimStart().length;
    // 缩进回退说明已离开这些类的类体。
    while (classStack.length > 0 && classStack[classStack.length - 1]!.indent >= indent) {
      classStack.pop();
    }

    /* ---------- 类声明与基类列表 ---------- */
    const cm = CLASS_RE.exec(line);
    if (cm) {
      const name = cm[2]!;
      // cm[1] 恰好是 `class Name` 中名字之前的内容，长度即名字的 0-based 起点。
      const nameIdx = cm[1]!.length;
      const col = nameIdx + 1;

      // 基类列表的 `(` 必须在类声明同一行上（Python 语法如此），可跨行配对。
      const openRel = line.indexOf("(", nameIdx + name.length);
      let inner = "";
      if (openRel >= 0) {
        const openAbs = starts[li]! + openRel;
        const closeAbs = matchParen(masked, openAbs);
        if (closeAbs >= 0) {
          inner = masked.slice(openAbs + 1, closeAbs);
        } else {
          // 括号未闭合（语法残缺）：只取本行剩余，避免吞掉整个文件。
          const eol = masked.indexOf("\n", openAbs);
          inner = masked.slice(openAbs + 1, eol < 0 ? masked.length : eol);
        }
      }

      // keyword 参数（`metaclass=ABCMeta`、`foo=bar`）不是基类。
      const argItems = splitTopComma(inner).filter((it) => !KEYWORD_ARG_RE.test(it));
      // 逐项走共用解析（丢弃 `<`/`>`/`[]` 等非法项），`raw` 保留源码原样（含 `[T]`）。
      const supers: TypeRef[] = [];
      for (const item of argItems) {
        const refs = parseTypeList(stripSubscripts(item));
        if (refs.length === 1) supers.push({ plain: refs[0]!.plain, raw: item.trim() });
      }

      const metaMatch = /(?:^|,)\s*metaclass\s*=\s*([A-Za-z_][\w.]*)/.exec(inner);
      const metaName = metaMatch ? lastSegment(metaMatch[1]!) : "";
      const abstract =
        metaName === "ABCMeta" ||
        supers.some((s) => s.plain === "ABC" || s.plain === "ABCMeta");

      const decl: TypeDecl = {
        name,
        kind: "class",
        path,
        line: li + 1,
        col,
        supers,
        interfaces: [],
        abstract,
      };
      result.types.push(decl);
      result.symbols.push({ name, kind: "class", path, line: li + 1, col });
      classStack.push({ indent, decl });
      continue;
    }

    /* ---------- `@abstractmethod` 所属类 ---------- */
    if (ABSTRACT_DECO_RE.test(line)) {
      const top = classStack[classStack.length - 1];
      if (top) top.decl.abstract = true;
      continue;
    }

    /* ---------- 函数 / 方法 ---------- */
    const dm = DEF_RE.exec(line);
    if (dm) {
      const name = dm[2]!;
      const col = dm[1]!.length + 1;
      result.symbols.push({
        name,
        kind: indent > 0 ? "method" : "function",
        path,
        line: li + 1,
        col,
      });
      continue;
    }

    /* ---------- import 模块 ---------- */
    const im = IMPORT_RE.exec(line);
    if (im) {
      for (const item of splitTopComma(im[1]!)) {
        const am = /^([A-Za-z_.][\w.]*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(item);
        if (!am) continue;
        const source = am[1]!;
        const alias = am[2];
        const ref: ImportRef = {
          local: alias ?? lastSegment(source),
          source,
          imported: null,
          wildcard: false,
        };
        result.imports.push(ref);
      }
      continue;
    }

    /* ---------- from ... import ...（可跨行括号） ---------- */
    const fm = FROM_RE.exec(line);
    if (fm) {
      const source = fm[1]!;
      const rest = fm[2]!;
      const openRel = rest.indexOf("(");
      let namesText = rest;

      if (openRel >= 0) {
        // 收集到配对的 `)`，然后把这些行整体跳过。
        const restStart = starts[li]! + (line.length - rest.length);
        const openAbs = restStart + openRel;
        const closeAbs = matchParen(masked, openAbs);
        if (closeAbs >= 0) {
          namesText = masked.slice(openAbs + 1, closeAbs);
          const closeLine = lineAt(starts, closeAbs);
          if (closeLine > li) li = closeLine;
        } else {
          namesText = masked.slice(openAbs + 1);
        }
      }

      for (const item of splitTopComma(namesText)) {
        if (item === "*") {
          result.imports.push({ local: "*", source, imported: null, wildcard: true });
          continue;
        }
        const am = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(item);
        if (!am) continue;
        const imported = am[1]!;
        result.imports.push({
          local: am[2] ?? imported,
          source,
          imported,
          wildcard: false,
        });
      }
      continue;
    }

    /* ---------- 模块级常量 ---------- */
    const km = CONST_RE.exec(line);
    if (km) {
      const name = km[1]!;
      // CONST_RE 从行首锚定（模块级、无缩进），名字必然在第 1 列。
      result.symbols.push({
        name,
        kind: "const",
        path,
        line: li + 1,
        col: 1,
      });
    }
  }

  return result;
}

export const pythonAdapter: LanguageAdapter = {
  id: "python",
  extensions: ["py"] as const,
  precisionNote:
    "Python：仅识别源码中显式写出的基类列表；鸭子类型、IFoo.register() 虚拟子类、__subclasshook__、动态类型注入无法识别。",
  parse(text: string, path: string): ParsedFile {
    try {
      return parsePython(text ?? "", path);
    } catch {
      return emptyParsed();
    }
  },
};