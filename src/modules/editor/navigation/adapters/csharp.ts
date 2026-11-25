/**
 * adapters/csharp.ts —— C# 单文件语法适配器（CR-094）。
 *
 * 只做**单文件语法解析**：显式声明的类型、冒号后的父类型列表、using、方法/属性/命名空间。
 * 不做类型推导，不读 NuGet 包，不跨文件解析（跨文件与反向查询由 symbols.ts 负责）。
 *
 * 关键语义：C# 的 `class A : Base, IFoo` 在语法上**无法区分基类与接口**，
 * 因此冒号后的类型全部进 `supers`，`interfaces` 恒为空数组（与 Java 区分不？不同），
 * 界面统一显示「父类型」，不谎称是「实现接口」。
 *
 * 位置准确性来自「等长脱敏」预处理：把注释、字符串（含普通/verbatim/插值/原始字符串）
 * 与字符字面量整段替换为空格（保留 `\n`、`\r`），脱敏文本与原文字符偏移完全一致，
 * 因此正则在脱敏文本上匹配、再用原文偏移换算 1-based line/col，行列不会漂移。
 *
 * 性能：单趟状态机脱敏 + 单趟线性扫描，泛型/括号捕获均限长，避免灾难性回溯。
 */

import {
  type ImportRef,
  type LanguageAdapter,
  type ParsedFile,
  type SymbolDef,
  type TypeDecl,
  type TypeKind,
  type TypeRef,
  emptyParsed,
  parseTypeList,
} from "./types";

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const TYPE_KINDS: Record<string, TypeKind> = {
  class: "class",
  interface: "interface",
  struct: "struct",
  record: "record",
  enum: "enum",
};

/** 声明头里可剥掉的修饰符（用于「名字前必须存在返回类型」的判定）。 */
const MODIFIER_TOKENS = new Set([
  "public",
  "private",
  "protected",
  "internal",
  "static",
  "async",
  "virtual",
  "override",
  "abstract",
  "sealed",
  "extern",
  "unsafe",
  "new",
  "readonly",
  "partial",
  "volatile",
  "const",
  "event",
  "required",
  "file",
  "implicit",
  "explicit",
  "scoped",
]);

/**
 * 不能充当返回类型 / 声明名前缀的保留词。
 * 用于挡掉 `return Foo(`、`new Foo(`、`if (`、`operator (`、`var x = new Foo(` 之类的语句。
 */
const RESERVED_WORDS = new Set([
  "return",
  "new",
  "throw",
  "else",
  "case",
  "default",
  "do",
  "while",
  "for",
  "foreach",
  "if",
  "switch",
  "catch",
  "try",
  "finally",
  "using",
  "lock",
  "await",
  "yield",
  "typeof",
  "sizeof",
  "nameof",
  "checked",
  "unchecked",
  "fixed",
  "in",
  "is",
  "as",
  "ref",
  "out",
  "params",
  "this",
  "base",
  "null",
  "true",
  "false",
  "class",
  "struct",
  "interface",
  "enum",
  "record",
  "where",
  "delegate",
  "operator",
  "when",
  "and",
  "or",
  "not",
  "goto",
  "break",
  "continue",
  "var",
]);

/* ------------------------------------------------------------------ */
/* 预处理：等长脱敏                                                    */
/* ------------------------------------------------------------------ */

/** 字符字面量：`'a'`、`'\n'`；找不到闭合（如撇号）返回 -1，避免误吞全文。 */
function charLiteralEnd(text: string, start: number): number {
  const n = text.length;
  let j = start + 1;
  while (j < n && j <= start + 10) {
    const d = text[j];
    if (d === "\\") {
      j += 2;
      continue;
    }
    if (d === "\n" || d === "\r") return -1;
    if (d === "'") return j + 1;
    j++;
  }
  return -1;
}

/**
 * 插值字符串 `{ ... }` 内的代码表达式：按花括号深度跳过，内部字符串/字符字面量同样处理。
 * `open` 指向 `{`，返回匹配 `}` 之后的位置；失败返回 -1。
 */
function skipInterpolation(text: string, open: number): number {
  const n = text.length;
  let depth = 0;
  let j = open;
  while (j < n) {
    const c = text[j];
    if (c === "{") {
      depth++;
      j++;
      continue;
    }
    if (c === "}") {
      depth--;
      j++;
      if (depth <= 0) return j;
      continue;
    }
    if (c === '"' || c === "@" || c === "$") {
      const e = stringLiteralEnd(text, j);
      if (e > j) {
        j = e;
        continue;
      }
    }
    if (c === "'") {
      const e = charLiteralEnd(text, j);
      if (e > j) {
        j = e;
        continue;
      }
    }
    j++;
  }
  return -1;
}

/**
 * 判断 `start` 处是否为 C# 字符串字面量，返回其结束位置（不含）。
 * 支持：`"..."`、`@"..."`、`$"..."`、`$@"..."`、`@$"..."`、`"""..."""`（原始字符串）。
 * 不是字符串返回 -1。
 */
function stringLiteralEnd(text: string, start: number): number {
  const n = text.length;
  let p = start;
  let dollars = 0;
  while (p < n && text[p] === "$") {
    dollars++;
    p++;
  }
  let verbatim = false;
  if (p < n && text[p] === "@") {
    verbatim = true;
    p++;
    while (p < n && text[p] === "$") {
      dollars++;
      p++;
    }
  }
  if (p >= n || text[p] !== '"') return -1;

  // 原始字符串 """..."""：找同长度的引号串收尾
  if (!verbatim) {
    let q = 0;
    while (p + q < n && text[p + q] === '"') q++;
    if (q >= 3) {
      const close = text.indexOf('"'.repeat(q), p + q);
      return close < 0 ? n : close + q;
    }
  }

  let j = p + 1;
  while (j < n) {
    const d = text[j];
    if (dollars > 0 && d === "{") {
      if (text[j + 1] === "{") {
        j += 2;
        continue;
      }
      const e = skipInterpolation(text, j);
      if (e < 0) return n;
      j = e;
      continue;
    }
    if (verbatim) {
      if (d === '"') {
        if (text[j + 1] === '"') {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
      continue;
    }
    if (d === "\\") {
      j += 2;
      continue;
    }
    if (d === "\n" || d === "\r") return j; // 非法未闭合字符串：到行尾为止
    if (d === '"') return j + 1;
    j++;
  }
  return n;
}

/**
 * 把注释、字符串、字符字面量替换为空格，**保留换行**。
 * 返回值与入参长度、换行位置完全一致，原文偏移可直接复用。
 */
function maskCommentsAndStrings(text: string): string {
  const n = text.length;
  const out = text.split("");

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

    if (c === '"' || c === "@" || c === "$") {
      const e = stringLiteralEnd(text, i);
      if (e > i) {
        blank(i, e);
        i = e;
        continue;
      }
    }

    if (c === "'") {
      const e = charLiteralEnd(text, i);
      if (e > i) {
        blank(i, e);
        i = e;
        continue;
      }
    }

    i++;
  }

  return out.join("");
}

/* ------------------------------------------------------------------ */
/* 位置与扫描工具                                                      */
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
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: off - starts[lo] + 1 };
  };
}

function skipWs(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v") i++;
    else break;
  }
  return i;
}

/** `index` 处是否为完整单词（两侧非标识符字符）。 */
function isWordAt(text: string, index: number, word: string): boolean {
  if (!text.startsWith(word, index)) return false;
  const before = index > 0 ? text[index - 1] : " ";
  const after = index + word.length < text.length ? text[index + word.length] : " ";
  return !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after);
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

/** 读取 from 之后的下一个标识符（先跳过空白）。 */
function readIdentAfter(
  text: string,
  from: number,
): { name: string; index: number; end: number } | null {
  const i = skipWs(text, from);
  if (i >= text.length) return null;
  const first = text[i];
  if (!/[A-Za-z_]/.test(first)) return null;
  let j = i + 1;
  while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
  return { name: text.slice(i, j), index: i, end: j };
}

/** 向前找最近的成员边界（`{` `}` `;`），限长防止跨文件扫描。 */
function lastMemberBoundary(text: string, index: number, limit = 400): number {
  const start = Math.max(0, index - limit);
  for (let i = index - 1; i >= start; i--) {
    const c = text[i];
    if (c === "{" || c === "}" || c === ";") return i;
  }
  return start - 1;
}

/* ------------------------------------------------------------------ */
/* 类型声明                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从冒号开始读取父类型列表原文。
 * 在 `<>` `()` `[]` 深度 0 处遇到 `{` `;` `}` 或 `where` 截止
 * —— `where T : class` 这类泛型约束因此不会被当成父类型。
 */
function readSupers(text: string, colon: number): { raw: string; ok: boolean } {
  const limit = Math.min(text.length, colon + 4000);
  let depth = 0;
  for (let i = colon + 1; i < limit; i++) {
    const c = text[i];
    if (c === "<" || c === "(" || c === "[") {
      depth++;
      continue;
    }
    if (c === ">" || c === ")" || c === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    if (c === "{" || c === ";" || c === "}") {
      return { raw: text.slice(colon + 1, i), ok: true };
    }
    if (c === "w" && isWordAt(text, i, "where")) {
      return { raw: text.slice(colon + 1, i), ok: true };
    }
  }
  return { raw: "", ok: false };
}

/** 声明关键字之前（同一声明头内）是否含 `abstract`。 */
function hasAbstractModifier(text: string, kwIndex: number): boolean {
  const boundary = lastMemberBoundary(text, kwIndex);
  return /\babstract\b/.test(text.slice(boundary + 1, kwIndex));
}

/* ------------------------------------------------------------------ */
/* 成员（方法 / 属性）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 声明名前缀是否像「修饰符 + 返回类型」。
 * 排除 `var a = new Foo(`、`return Foo(`、`Task.Run(`、`operator Foo(`、构造器 `public Foo(` 等。
 */
function looksLikeDeclHead(prefix: string): boolean {
  const trimmed = prefix.trim();
  if (!trimmed) return false;
  const last = trimmed[trimmed.length - 1];
  if (last === "." || last === "(" || last === "," || last === "=" || last === ":" || last === "~") {
    return false;
  }
  const tokens = trimmed.split(/\s+/);
  for (const t of tokens) {
    if (t === "delegate" || t === "=>") return false;
  }
  let idx = tokens.length - 1;
  while (idx >= 0 && MODIFIER_TOKENS.has(tokens[idx])) idx--;
  if (idx < 0) return false;
  const t = tokens[idx];
  if (!/^[A-Za-z_][\w.]*(?:<[^;{}()=]*>)?(?:\[\s*,*\s*\])*\??$/.test(t)) return false;
  return !RESERVED_WORDS.has(t.toLowerCase());
}

/* ------------------------------------------------------------------ */
/* using 与 namespace                                                  */
/* ------------------------------------------------------------------ */

/** 去掉 `global::` 限定前缀。 */
function stripGlobalPrefix(s: string): string {
  return s.startsWith("global::") ? s.slice("global::".length) : s;
}

/** 取命名空间/类型全名的末段：`A.B.C<T>` → `C`。 */
function lastSegment(name: string): string {
  let s = name.trim();
  const lt = s.indexOf("<");
  if (lt >= 0) s = s.slice(0, lt);
  const dot = s.lastIndexOf(".");
  if (dot >= 0) s = s.slice(dot + 1);
  return s.replace(/[\s?*[\]]+$/g, "").trim();
}

/** `using`：普通导入 local=末段、imported=null；别名导入 local=别名、imported=来源末段。 */
function collectImports(clean: string, out: ImportRef[]): void {
  const re = /^[ \t\uFEFF]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?([^;\r\n{}()]+);[ \t]*\r?$/gm;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const body = (m[1] ?? "").trim();
    if (!body) continue;

    let local: string;
    let source: string;
    let imported: string | null;

    const eq = body.indexOf("=");
    if (eq >= 0) {
      local = body.slice(0, eq).trim();
      source = stripGlobalPrefix(body.slice(eq + 1).trim());
      imported = lastSegment(source) || null;
      if (!local || !source) continue;
      if (!/^[A-Za-z_]\w*$/.test(local)) continue;
      if (imported !== null && !/^[A-Za-z_]\w*$/.test(imported)) imported = null;
    } else {
      source = stripGlobalPrefix(body);
      local = lastSegment(source);
      imported = null;
      if (!local) continue;
    }

    const key = local + "|" + source;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ local, source, imported, wildcard: false });
  }
}

/** `namespace A.B.C {` / 文件作用域 `namespace A.B.C;`。 */
function collectNamespaces(clean: string, path: string, symbols: SymbolDef[], locate: (o: number) => { line: number; col: number }): void {
  const re = /\bnamespace\s+([A-Za-z_][\w.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const before = m.index > 0 ? clean[m.index - 1] : "";
    if (before === "." || before === "@") continue;
    const name = m[1] ?? "";
    if (!name) continue;
    const nameStart = m.index + m[0].length - name.length;
    const loc = locate(nameStart);
    symbols.push({ name, kind: "namespace", path, line: loc.line, col: loc.col });
  }
}

/* ------------------------------------------------------------------ */
/* 主解析                                                              */
/* ------------------------------------------------------------------ */

function parseCSharp(text: string, path: string): ParsedFile {
  if (!text) return emptyParsed();

  const clean = maskCommentsAndStrings(text);
  const locate = makeLocator(text);

  const symbols: SymbolDef[] = [];
  const types: TypeDecl[] = [];
  const imports: ImportRef[] = [];

  /* ---- using ---- */
  collectImports(clean, imports);

  /* ---- namespace ---- */
  collectNamespaces(clean, path, symbols, locate);

  /* ---- 类型声明 ---- */
  const seenTypes = new Set<string>();
  const typeRe = /\b(class|interface|struct|record|enum)\b/g;
  let tm: RegExpExecArray | null;
  while ((tm = typeRe.exec(clean)) !== null) {
    const keyword = tm[1] ?? "";
    const kwIndex = tm.index;
    const before = kwIndex > 0 ? clean[kwIndex - 1] : "";
    // `x.class`、`@class` 作为标识符时不是声明
    if (before === "." || before === "@") continue;

    const first = readIdentAfter(clean, kwIndex + keyword.length);
    if (!first) continue;
    let name = first.name;
    let nameIndex = first.index;
    let nameEnd = first.end;

    // `record class RC` / `record struct RS`：真正的名字在 class/struct 之后
    if (keyword === "record" && (name === "class" || name === "struct")) {
      const second = readIdentAfter(clean, nameEnd);
      if (!second) continue;
      name = second.name;
      nameIndex = second.index;
      nameEnd = second.end;
    }

    // `where T : class` 之类误捕（名字是关键字）直接丢弃
    if (RESERVED_WORDS.has(name.toLowerCase())) continue;

    // 泛型参数表
    let p = skipWs(clean, nameEnd);
    if (clean[p] === "<") {
      const q = matchDelimiter(clean, p, "<", ">");
      if (q < 0) continue;
      p = skipWs(clean, q + 1);
    }
    // 主构造器参数表（record / struct / class 的 C# 12 语法）
    if (clean[p] === "(") {
      const q = matchDelimiter(clean, p, "(", ")");
      if (q < 0) continue;
      p = skipWs(clean, q + 1);
    }

    // 冒号后是父类型；`{` / `;` / `where` 表示没有父类型；其它说明不是类型声明
    let supersRaw = "";
    if (clean[p] === ":") {
      const scanned = readSupers(clean, p);
      if (!scanned.ok) continue;
      supersRaw = scanned.raw;
    } else if (clean[p] === "{" || clean[p] === ";") {
      supersRaw = "";
    } else if (isWordAt(clean, p, "where")) {
      supersRaw = "";
    } else {
      continue;
    }

    const kind: TypeKind = TYPE_KINDS[keyword] ?? "class";
    // enum 的冒号后是底层类型（byte / int / long …），不是父类型
    const supers: TypeRef[] = kind === "enum" ? [] : parseTypeList(supersRaw);
    const isAbstract = kind === "interface" || hasAbstractModifier(clean, kwIndex);

    const loc = locate(nameIndex);
    const key = name + "@" + loc.line + ":" + loc.col;
    if (seenTypes.has(key)) continue;
    seenTypes.add(key);

    types.push({
      name,
      kind,
      path,
      line: loc.line,
      col: loc.col,
      supers,
      interfaces: [], // C# 无法区分基类与接口：全部放 supers
      abstract: isAbstract,
    });
    symbols.push({ name, kind, path, line: loc.line, col: loc.col });
  }

  /* ---- 方法 ---- */
  const seenMembers = new Set<string>();
  const callRe = /([A-Za-z_]\w*)\s*(?:<[^<>{};()]{0,200}>)?\s*\(/g;
  let cm: RegExpExecArray | null;
  while ((cm = callRe.exec(clean)) !== null) {
    const name = cm[1] ?? "";
    const nameStart = cm.index;
    if (!name) continue;
    if (RESERVED_WORDS.has(name.toLowerCase())) continue;
    const prev = nameStart > 0 ? clean[nameStart - 1] : "";
    if (prev === "." || prev === "@" || prev === "~") continue;

    const boundary = lastMemberBoundary(clean, nameStart);
    const prefix = clean.slice(boundary + 1, nameStart);
    if (!looksLikeDeclHead(prefix)) continue;

    const open = cm.index + cm[0].length - 1;
    const close = matchDelimiter(clean, open, "(", ")");
    if (close < 0) continue;

    let pos = skipWs(clean, close + 1);
    if (isWordAt(clean, pos, "where")) {
      const limit = Math.min(clean.length, pos + 600);
      let j = pos;
      while (j < limit) {
        const c = clean[j];
        if (c === "{" || c === ";" || (c === "=" && clean[j + 1] === ">")) break;
        j++;
      }
      pos = j;
    }

    const isBody =
      clean[pos] === "{" ||
      clean[pos] === ";" ||
      (clean[pos] === "=" && clean[pos + 1] === ">");
    if (!isBody) continue;

    const loc = locate(nameStart);
    const key = "method|" + name + "@" + loc.line + ":" + loc.col;
    if (seenMembers.has(key)) continue;
    seenMembers.add(key);
    symbols.push({ name, kind: "method", path, line: loc.line, col: loc.col });
  }

  /* ---- 属性 ---- */
  const propRe = /([A-Za-z_]\w*)\s*\{\s*(?:get|set|init)\b/g;
  let pm: RegExpExecArray | null;
  while ((pm = propRe.exec(clean)) !== null) {
    const name = pm[1] ?? "";
    const nameStart = pm.index;
    if (!name) continue;
    if (RESERVED_WORDS.has(name.toLowerCase())) continue;
    const prev = nameStart > 0 ? clean[nameStart - 1] : "";
    if (prev === "." || prev === "@") continue;

    const boundary = lastMemberBoundary(clean, nameStart);
    const prefix = clean.slice(boundary + 1, nameStart);
    if (!looksLikeDeclHead(prefix)) continue;

    const loc = locate(nameStart);
    const key = "property|" + name + "@" + loc.line + ":" + loc.col;
    if (seenMembers.has(key)) continue;
    seenMembers.add(key);
    symbols.push({ name, kind: "property", path, line: loc.line, col: loc.col });
  }

  /* ---- 表达式体属性 `public string Name => ...` ---- */
  const exprPropRe = /([A-Za-z_]\w*)\s*=>/g;
  let em: RegExpExecArray | null;
  while ((em = exprPropRe.exec(clean)) !== null) {
    const name = em[1] ?? "";
    const nameStart = em.index;
    if (!name) continue;
    if (RESERVED_WORDS.has(name.toLowerCase())) continue;
    const prev = nameStart > 0 ? clean[nameStart - 1] : "";
    if (prev === "." || prev === "@") continue;

    const boundary = lastMemberBoundary(clean, nameStart);
    const prefix = clean.slice(boundary + 1, nameStart);
    if (!looksLikeDeclHead(prefix)) continue;

    const loc = locate(nameStart);
    const key = "property|" + name + "@" + loc.line + ":" + loc.col;
    if (seenMembers.has(key)) continue;
    seenMembers.add(key);
    symbols.push({ name, kind: "property", path, line: loc.line, col: loc.col });
  }

  symbols.sort((a, b) => a.line - b.line || a.col - b.col);
  types.sort((a, b) => a.line - b.line || a.col - b.col);

  return { symbols, types, imports };
}

/* ------------------------------------------------------------------ */
/* 适配器导出                                                          */
/* ------------------------------------------------------------------ */

export const csharpAdapter: LanguageAdapter = {
  id: "csharp",
  extensions: ["cs"] as const,
  precisionNote:
    "C#：仅识别源码中的类型声明与冒号后父类型列表；语法上无法区分基类与接口（统一按父类型呈现），partial 分散、显式接口实现、外部 NuGet 类型无法识别。",
  parse(text: string, path: string): ParsedFile {
    try {
      return parseCSharp(typeof text === "string" ? text : "", typeof path === "string" ? path : "");
    } catch {
      return emptyParsed();
    }
  },
};