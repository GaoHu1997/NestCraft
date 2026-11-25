/**
 * adapters/java.ts —— Java 单文件语法适配器（CR-094）。
 *
 * 只做**单文件语法解析**：显式声明的类型、`extends` / `implements`、import、方法/常量。
 * 不做类型推导，不读 jar，不跨文件解析（跨文件与反向查询由 symbols.ts 负责）。
 *
 * 位置准确性来自「等长脱敏」预处理：把注释、字符串、字符字面量整段替换为空格
 * （保留 `\n`、`\r`），脱敏文本与原文字符偏移完全一致，因此正则在脱敏文本上匹配、
 * 再用原文偏移换算 1-based line/col，行列不会漂移。
 *
 * 性能：单趟状态机 + 单趟正则扫描，泛型捕获限长（≤300 字符）避免回溯爆炸，5000 行文件线性可解。
 */

import {
  type ImportRef,
  type LanguageAdapter,
  type ParsedFile,
  type SymbolDef,
  type TypeDecl,
  type TypeRef,
  type TypeKind,
  emptyParsed,
  parseTypeList,
} from "./types";

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 声明头允许出现的关键字修饰符（`non-sealed` 含连字符，故不用 \b 收尾）。 */
const MODIFIER_SRC =
  "public|protected|private|static|final|abstract|synchronized|native|strictfp|default|sealed|non-sealed";

/**
 * 声明头：注解（可带无嵌套括号的参数）、修饰符、方法自有类型参数（`public <T> T id(...)`）
 * 的任意顺序重复，例如 `@Override public `、`@SuppressWarnings({...})\n`、`public static <T> `。
 */
const HEAD_SRC =
  "(?:(?:@[\\w$.]+(?:[ \\t]*\\([^()]*\\))?|" + MODIFIER_SRC + "|<[\\s\\S]{0,200}?>)[ \\t\\r\\n]+)*";

/** 类型表达式：限定名 + 可选泛型实参（限长防回溯）+ 可选数组后缀。 */
const TYPE_EXPR_SRC = "[A-Za-z_$][\\w$.]*(?:[ \\t]*<[\\s\\S]{0,300}?>)?(?:[ \\t]*\\[[ \\t]*\\])*";

/**
 * 成员只能出现在文件/类型体开始处：行首、`{`、`}`、`;` 之后。
 * 允许紧跟一个 `)`：注解参数里带 `{...}` 时（`@SuppressWarnings({"a"})`），
 * 最近的边界字符是注解内的 `}`，其后正是 `)`，不放行就会漏掉下一个成员。
 */
const MEMBER_START_SRC = "(?:^|[{};])(?:\\)[ \\t\\r\\n]*)?";

/** 方法（含接口/抽象方法 `void pay();`）：修饰头 + 返回类型 + 名字 + `(`。 */
const METHOD_RE = new RegExp(
  MEMBER_START_SRC +
    "[ \\t\\r\\n]*(" +
    HEAD_SRC +
    ")(" +
    TYPE_EXPR_SRC +
    ")[ \\t\\r\\n]+([A-Za-z_$][\\w$]*)[ \\t]*\\(",
  "g",
);

/** 常量：`public static final int MAX = 3;`（要求 static+final 同时出现，见下方校验）。 */
const CONST_RE = new RegExp(
  MEMBER_START_SRC +
    "[ \\t\\r\\n]*(" +
    HEAD_SRC +
    ")(" +
    TYPE_EXPR_SRC +
    ")[ \\t\\r\\n]+([A-Za-z_$][\\w$]*)[ \\t]*=",
  "g",
);

/** 类型声明关键字 + 名字。`@interface` 另行判定为 annotation。 */
const TYPE_RE = /\b(class|interface|enum|record)[ \t\r\n]+([A-Za-z_$][\w$]*)/g;

/** import（`static` 用非捕获组，全限定名整体保留在 source）。 */
const IMPORT_RE = /\bimport[ \t\r\n]+(?:static[ \t\r\n]+)?([A-Za-z_$][\w$.]*(?:\.[*])?)[ \t\r\n]*;/g;

/** 匿名类：`new X<...>(...) {`，其体内成员不算外部类型的成员。 */
const ANON_RE = /\bnew[ \t\r\n]+[A-Za-z_$][\w$.]*(?:[ \t]*<[^;{}]{0,200}>)?[ \t]*\(/g;

/**
 * 不能作为返回类型的词。
 * 两类：① 语句关键字（避免把 `return foo(`、`new Foo(`、`else if (` 当方法）；
 * ② 修饰符 —— 声明头分组是可回溯的，不回填黑名单时 `public Edge(int x)` 这种**构造器**
 *    会被回退成「返回类型 = public、方法名 = Edge」，从而误报。
 */
const RESERVED_RETURN_WORDS = new Set([
  "public",
  "protected",
  "private",
  "static",
  "final",
  "abstract",
  "synchronized",
  "native",
  "strictfp",
  "sealed",
  "non-sealed",
  "transient",
  "volatile",
  "return",
  "new",
  "throw",
  "throws",
  "else",
  "case",
  "default",
  "do",
  "assert",
  "yield",
  "break",
  "continue",
  "goto",
  "package",
  "import",
  "this",
  "super",
  "null",
  "true",
  "false",
  "record",
  "class",
  "interface",
  "enum",
  "annotation",
  "extends",
  "implements",
  "permits",
  "instanceof",
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "try",
  "finally",
  "synchronized",
]);

const TYPE_KINDS: Record<string, TypeKind> = {
  class: "class",
  interface: "interface",
  enum: "enum",
  record: "record",
};

/* ------------------------------------------------------------------ */
/* 预处理：等长脱敏                                                    */
/* ------------------------------------------------------------------ */

/**
 * 把注释、字符串、字符字面量、文本块替换为空格，**保留换行**。
 * 返回值与入参长度、换行位置完全一致，因此原文偏移可直接复用。
 */
function maskCommentsAndStrings(text: string): string {
  const out = text.split("");
  const n = text.length;

  const blank = (from: number, to: number): void => {
    const end = Math.min(to, n);
    for (let k = from; k < end; k++) {
      const ch = out[k];
      if (ch !== "\n" && ch !== "\r") out[k] = " ";
    }
  };

  let i = 0;
  while (i < n) {
    const c = text[i];

    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }

    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const j = close < 0 ? n : close + 2;
      blank(i, j);
      i = j;
      continue;
    }

    if (c === '"') {
      // Java 15+ 文本块 """ ... """
      if (text[i + 1] === '"' && text[i + 2] === '"') {
        const close = text.indexOf('"""', i + 3);
        const j = close < 0 ? n : close + 3;
        blank(i, j);
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < n) {
        const d = text[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "\n") break; // 非法未闭合字符串：到行尾为止，避免吞掉整个文件
        j++;
        if (d === '"') break;
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (c === "'") {
      // 字符字面量：只在很短距离内找到闭合引号才脱敏，防止撇号误吞全文
      let j = i + 1;
      let closed = -1;
      while (j < n && j <= i + 8) {
        const d = text[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "\n") break;
        if (d === "'") {
          closed = j;
          break;
        }
        j++;
      }
      if (closed >= 0) {
        blank(i, closed + 1);
        i = closed + 1;
        continue;
      }
    }

    i++;
  }

  return out.join("");
}

/* ------------------------------------------------------------------ */
/* 位置与括号工具                                                      */
/* ------------------------------------------------------------------ */

/** 构造偏移 → 1-based line/col 的换算器（行首表 + 二分）。 */
function makeLocator(text: string): (offset: number) => { line: number; col: number } {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return (offset: number) => {
    const off = offset < 0 ? 0 : offset > text.length ? text.length : offset;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= off) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: off - (starts[lo] as number) + 1 };
  };
}

/** 从 open 处的开括号找到匹配闭括号（同字符深度计数），失败返回 -1。 */
function matchDelimiter(text: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 成员匹配中名字的起始偏移：正则尾部是 `name[ \t]*(` 或 `name[ \t]*=`。 */
function nameOffsetInMatch(m: RegExpExecArray, name: string, tailLen: number): number {
  let end = m.index + m[0].length - tailLen;
  while (end > m.index) {
    const ch = m.input[end - 1];
    if (ch === " " || ch === "\t") end--;
    else break;
  }
  return end - name.length;
}

/** 向前找最近的成员边界（`{` `}` `;`），用于判断声明头里的修饰符。 */
function lastMemberBoundary(text: string, index: number): number {
  for (let i = index - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "{" || c === "}" || c === ";") return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* 声明头解析                                                          */
/* ------------------------------------------------------------------ */

/**
 * 取类型名之后到类型体 `{` 之间的声明头。
 * 同时跟踪 `<>` `()` `[]` 深度，遇到深度 0 的 `{` `;` `}` 即截止（限长 4000，避免跨声明）。
 */
function readHeader(text: string, from: number): string {
  const limit = Math.min(text.length, from + 4000);
  let depth = 0;
  for (let i = from; i < limit; i++) {
    const c = text[i];
    if (c === "<" || c === "(" || c === "[") {
      depth++;
      continue;
    }
    if (c === ">" || c === ")" || c === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && (c === "{" || c === ";" || c === "}")) return text.slice(from, i);
  }
  return text.slice(from, limit);
}

/** 在声明头里找顶层（括号/泛型之外）的关键字，返回起始偏移，找不到返回 -1。 */
function findTopLevelKeyword(header: string, keyword: string): number {
  let depth = 0;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (c === "<" || c === "(" || c === "[") {
      depth++;
      continue;
    }
    if (c === ">" || c === ")" || c === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || c !== keyword[0]) continue;
    if (!header.startsWith(keyword, i)) continue;
    const before = i === 0 ? " " : (header[i - 1] as string);
    const after = i + keyword.length >= header.length ? " " : (header[i + keyword.length] as string);
    if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) return i;
  }
  return -1;
}

/** `extends` → supers，`implements` → interfaces（Java 语义明确，二者必须分开）。 */
function readSupertypes(header: string, kind: TypeKind): { supers: TypeRef[]; interfaces: TypeRef[] } {
  if (kind === "annotation") return { supers: [], interfaces: [] };
  const extIdx = findTopLevelKeyword(header, "extends");
  const implIdx = findTopLevelKeyword(header, "implements");

  let supers: TypeRef[] = [];
  const interfaces: TypeRef[] = [];

  if (extIdx >= 0) {
    const end = implIdx > extIdx ? implIdx : header.length;
    supers = parseTypeList(header.slice(extIdx + "extends".length, end));
  }
  if (implIdx >= 0) {
    interfaces.push(...parseTypeList(header.slice(implIdx + "implements".length)));
  }
  return { supers, interfaces };
}

/* ------------------------------------------------------------------ */
/* 匿名类体区间（其内成员不计入外部类型）                              */
/* ------------------------------------------------------------------ */

function collectAnonymousRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  ANON_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANON_RE.exec(text)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = matchDelimiter(text, openParen, "(", ")");
    if (closeParen < 0) break;
    let i = closeParen + 1;
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") i++;
      else break;
    }
    if (text[i] !== "{") continue;
    const closeBrace = matchDelimiter(text, i, "{", "}");
    ranges.push([i, closeBrace < 0 ? text.length : closeBrace]);
    if (closeBrace < 0) break;
    ANON_RE.lastIndex = closeBrace + 1;
  }
  return ranges;
}

function inRanges(ranges: Array<[number, number]>, offset: number): boolean {
  for (const [start, end] of ranges) {
    if (offset > start && offset < end) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 主解析                                                              */
/* ------------------------------------------------------------------ */

function parseJava(text: string, path: string): ParsedFile {
  if (!text) return emptyParsed();

  const clean = maskCommentsAndStrings(text);
  const locate = makeLocator(text);

  const symbols: SymbolDef[] = [];
  const types: TypeDecl[] = [];
  const imports: ImportRef[] = [];

  /* ---- import ---- */
  const seenLocal = new Set<string>();
  IMPORT_RE.lastIndex = 0;
  let im: RegExpExecArray | null;
  while ((im = IMPORT_RE.exec(clean)) !== null) {
    const raw = (im[1] ?? "").trim();
    if (!raw) continue;

    let local: string;
    let source: string;
    let imported: string | null;
    let wildcard = false;

    if (raw.endsWith(".*")) {
      source = raw.slice(0, -2);
      local = "*";
      imported = null;
      wildcard = true;
    } else {
      const dot = raw.lastIndexOf(".");
      imported = dot >= 0 ? raw.slice(dot + 1) : raw;
      local = imported;
      source = raw;
    }

    // 同名类以先出现者为准；通配 import 可有多条，不去重
    if (local !== "*") {
      if (seenLocal.has(local)) continue;
      seenLocal.add(local);
    }
    imports.push({ local, source, imported, wildcard });
  }

  /* ---- 类型声明 ---- */
  TYPE_RE.lastIndex = 0;
  let tm: RegExpExecArray | null;
  while ((tm = TYPE_RE.exec(clean)) !== null) {
    const keyword = tm[1] ?? "";
    const name = tm[2] ?? "";
    if (!name) continue;

    const nameStart = tm.index + tm[0].length - name.length;
    const before = tm.index > 0 ? (clean[tm.index - 1] as string) : "";

    // `X.class` 不是声明
    if (before === ".") continue;

    // `@interface Foo` → annotation（TypeKind 有该值），不当作 interface
    const isAnnotation = before === "@";
    const kind: TypeKind = isAnnotation ? "annotation" : (TYPE_KINDS[keyword] ?? "class");

    const header = readHeader(clean, tm.index + tm[0].length);
    const { supers, interfaces } = readSupertypes(header, kind);

    // abstract：装饰窗口内的 abstract 关键字，或本身就是 interface
    const boundary = lastMemberBoundary(clean, tm.index);
    const prefix = clean.slice(boundary + 1, tm.index);
    const isAbstract = kind === "interface" || /\babstract\b/.test(prefix);

    const loc = locate(nameStart);
    types.push({
      name,
      kind,
      path,
      line: loc.line,
      col: loc.col,
      supers,
      interfaces,
      abstract: isAbstract,
    });
    symbols.push({ name, kind: kind === "annotation" ? "annotation" : kind, path, line: loc.line, col: loc.col });
  }

  /* ---- 成员（方法 / 常量） ---- */
  const anonRanges = collectAnonymousRanges(clean);

  METHOD_RE.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = METHOD_RE.exec(clean)) !== null) {
    const returnType = (mm[2] ?? "").trim();
    const name = mm[3] ?? "";
    if (!name || !returnType) continue;
    if (RESERVED_RETURN_WORDS.has(returnType.toLowerCase())) continue;
    // 返回类型里出现注解残留（如 `@`）不像声明
    if (returnType.indexOf("@") >= 0) continue;

    const nameStart = nameOffsetInMatch(mm, name, 1);
    if (nameStart < 0) continue;
    if (inRanges(anonRanges, nameStart)) continue;

    const loc = locate(nameStart);
    symbols.push({ name, kind: "method", path, line: loc.line, col: loc.col });
  }

  CONST_RE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = CONST_RE.exec(clean)) !== null) {
    const head = cm[1] ?? "";
    const name = cm[3] ?? "";
    if (!name) continue;
    if (!/\bstatic\b/.test(head) || !/\bfinal\b/.test(head)) continue;

    const nameStart = nameOffsetInMatch(cm, name, 1);
    if (nameStart < 0) continue;
    if (inRanges(anonRanges, nameStart)) continue;

    const loc = locate(nameStart);
    symbols.push({ name, kind: "const", path, line: loc.line, col: loc.col });
  }

  symbols.sort((a, b) => (a.line - b.line) || (a.col - b.col));
  types.sort((a, b) => (a.line - b.line) || (a.col - b.col));

  return { symbols, types, imports };
}

/* ------------------------------------------------------------------ */
/* 适配器导出                                                          */
/* ------------------------------------------------------------------ */

export const javaAdapter: LanguageAdapter = {
  id: "java",
  extensions: ["java"] as const,
  precisionNote:
    "Java：仅识别源码中显式声明的 extends / implements；匿名类、Lambda、泛型实参、外部 jar 中的实现无法识别。",
  parse(text: string, path: string): ParsedFile {
    try {
      return parseJava(typeof text === "string" ? text : "", typeof path === "string" ? path : "");
    } catch {
      return emptyParsed();
    }
  },
};
