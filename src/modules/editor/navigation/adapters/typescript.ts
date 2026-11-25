/**
 * adapters/typescript.ts —— TypeScript / JavaScript 语言适配器（CR-094）。
 *
 * 纯函数：不读文件、不碰 DOM、不依赖 @/api；只把「一个文件的全文」解析成
 * `ParsedFile`（symbols / types / imports）。跨文件解析与反向查询由 symbols.ts 负责。
 *
 * 一、symbols —— 与原 `symbols.ts` 的 `extractSymbols` **逐字等价**（仅去掉 Python 分支）
 *   - 同一批逐行正则（RE_FUNCTION / RE_CLASS / RE_INTERFACE / RE_TYPE / RE_ENUM / RE_VAR / RE_METHOD）；
 *   - 同样的 `METHOD_BLACKLIST` 过滤（`if`/`for`/`constructor`/`get`… 不算方法）；
 *   - 同样的 `line`（1-based）、`col`（声明名在行内的 1-based 位置 = `m[0].indexOf(name) + 1`）；
 *   - 同样的「同名同位置去重 + 按 line/col 排序」；
 *   - 原实现附加的 `preview` / `indent` / `endLine` 不属于 `SymbolDef` 契约，由 symbols.ts 的
 *     `enrichSymbols()` 按行重新推导，不在本适配器输出。
 *   - Python 的 `class` / `def`（RE_PY）由 python.ts 负责，本文件不处理。
 *
 * 二、imports —— 与原 `extractImports` 的 TS/JS 分支等价，映射到 `ImportRef`：
 *   - `import * as ns from "y"`  → `{ local: "ns", source: "y", imported: null, wildcard: true }`
 *     （原内部用 `imported: "*"` 表示通配，这里改为 `wildcard: true` + `imported: null`）；
 *   - `import X from "y"`        → `{ local: "X", source: "y", imported: "default", wildcard: false }`
 *     （**约定**：默认导入的 `imported` 固定为字面量 `"default"`，与 symbols.ts 内部
 *     `ref.imported ?? "default"` 的归一保持一致）；
 *   - `import { a as b } from "y"` → `{ local: "b", source: "y", imported: "a", wildcard: false }`
 *     （`local` = 本文件可用名/别名，`imported` = 来源里的原名；`import type` 前缀被剥掉）；
 *   - `import X, { a } from "y"` → 拆成两条：default 的 X + 具名的 a（与原实现一致）；
 *   - `export { a as b } from "y"`（re-export）→ 与原实现一致按具名处理：
 *     `{ local: "b", source: "y", imported: "a", wildcard: false }`；
 *   - 去重键与原实现一致（`local@声明偏移`），偏移只用于去重，不进入 `ImportRef`。
 *   - 不支持 `export * from "y"` / 动态 `import()` / `require()`（原实现亦不支持，保持等价）。
 *
 * 三、types —— CR-094 新增的继承关系（原实现没有，故无等价性要求）：
 *   - `class D extends Base implements IFoo, IBar {}` → kind "class"，`supers=[Base]`，
 *     `interfaces=[IFoo, IBar]`，`abstract` = 声明含 `abstract class`；
 *   - `interface A extends B, C {}` → kind "interface"，`supers=[B, C]`（TS 接口的 extends 是
 *     多继承，统一放 supers），`interfaces=[]`；
 *   - `enum F {…}` → kind "enum"，无父类型（放进来是为了「枚举」也能作为父类型目标被反查）；
 *   - 列表统一用 `parseTypeList` 拆（泛型感知，`class X<T extends Y> extends Z` 里的
 *     `T extends Y` 不会被误当成父类型；`implements Map<K, V>` 的逗号不会被误拆）。
 *   - `type E = …` 没有对应的 `TypeKind`，不进入 types（它在 symbols 里仍有 `kind: "type"`）。
 *   - 只收录与本适配器 symbols 同一批声明（沿用原正则，因此 `interface A` 不写 `export`、
 *     `declare class` 这类写法两边都不认），避免出现「能跳父类型但跳不到定义」的错位。
 *   - 多行头（`class Foo\n  extends Bar\n  implements Baz\n{`）会向下续读最多 5 行到 `{` 为止。
 */
import {
  type ImportRef,
  type LanguageAdapter,
  type ParsedFile,
  type SymbolDef,
  type SymbolKind,
  type TypeDecl,
  emptyParsed,
  parseTypeList,
} from "./types";

/* ---------------- 常量：与 CR-090 原实现保持逐字一致 ---------------- */

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

const RE_ABSTRACT_CLASS = /^[ \t]*(?:export\s+)?(?:default\s+)?abstract\s+class\s+/;

/** 多行声明头最多向下续读的行数（防止把方法体当成声明头）。 */
const HEADER_LOOKAHEAD = 5;

/* ---------------- symbols ---------------- */

/** 与旧 `pushMatch` 等价：col 取声明名在匹配串内的位置 +1（匹配串从行首开始）。 */
function pushMatch(
  out: SymbolDef[],
  path: string,
  lineNo: number,
  m: RegExpExecArray,
  name: string,
  kind: SymbolKind
): void {
  const nameIdx = m[0].indexOf(name);
  if (nameIdx < 0) return;
  out.push({ name, kind, path, line: lineNo, col: nameIdx + 1 });
}

/* ---------------- types：声明头解析 ---------------- */

const WORD_CHAR = /[\w$]/;

/**
 * 在「顶层」查找关键字边界匹配，忽略 `<…>`（泛型）、`(…)`、`[…]`、`{…}` 内部，
 * 找不到返回 -1。用于区分 `class X<T extends Y> extends Z` 里的两个 extends。
 */
function findTopLevelKeyword(text: string, keyword: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "<" || c === "(" || c === "[" || c === "{") {
      depth++;
      continue;
    }
    if (c === ">" || c === ")" || c === "]" || c === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || c !== keyword[0]) continue;
    if (!text.startsWith(keyword, i)) continue;
    const before = i > 0 ? text[i - 1]! : "";
    const after = text[i + keyword.length] ?? "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return i;
  }
  return -1;
}

/**
 * 取声明名之后的「声明头」：先接上首行剩余，再向下续读至出现 `{`（最多 HEADER_LOOKAHEAD 行），
 * 然后去掉注释、在第一个 `{` 处截断（类型体开始）。
 */
function collectHeader(lines: string[], lineIndex: number, firstRest: string): string {
  let header = firstRest;
  const limit = Math.min(lines.length - 1, lineIndex + HEADER_LOOKAHEAD);
  for (let i = lineIndex + 1; i <= limit; i++) {
    if (header.includes("{")) break;
    header += " " + (lines[i] ?? "");
  }
  header = header.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const brace = header.indexOf("{");
  return brace >= 0 ? header.slice(0, brace) : header;
}

/** 由声明头 + 声明种类构造 TypeDecl（class 才区分 implements，interface 的 extends 全进 supers）。 */
function buildTypeDecl(
  path: string,
  kind: "class" | "interface" | "enum",
  name: string,
  line: number,
  col: number,
  header: string,
  abstract: boolean
): TypeDecl {
  const extendsIdx = findTopLevelKeyword(header, "extends");
  const implementsIdx = findTopLevelKeyword(header, "implements");

  let extendsRaw = "";
  let implementsRaw = "";
  if (kind === "class") {
    if (extendsIdx >= 0) {
      const end = implementsIdx > extendsIdx ? implementsIdx : header.length;
      extendsRaw = header.slice(extendsIdx + "extends".length, end);
    }
    if (implementsIdx >= 0) implementsRaw = header.slice(implementsIdx + "implements".length);
  } else if (kind === "interface") {
    if (extendsIdx >= 0) extendsRaw = header.slice(extendsIdx + "extends".length);
  }

  return {
    name,
    kind,
    path,
    line,
    col,
    supers: parseTypeList(extendsRaw),
    interfaces: kind === "class" ? parseTypeList(implementsRaw) : [],
    abstract,
  };
}

/* ---------------- 单遍扫描：symbols + types ---------------- */

/**
 * 一遍扫描同时产出 symbols 与 types：types 的 class/interface/enum 与 symbols 是**同一批匹配**，
 * 保证「index 里能查到父类型的名字，就能在 symbols 里查到同名定义」。
 */
function scanDeclarations(text: string, path: string): { symbols: SymbolDef[]; types: TypeDecl[] } {
  const symbols: SymbolDef[] = [];
  const types: TypeDecl[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!;
    const lineNo = i + 1;
    let matched = false;
    let m: RegExpExecArray | null;

    if ((m = RE_FUNCTION.exec(lineText))) {
      pushMatch(symbols, path, lineNo, m, m[1]!, "function");
      matched = true;
    }
    if ((m = RE_CLASS.exec(lineText))) {
      const name = m[1]!;
      pushMatch(symbols, path, lineNo, m, name, "class");
      const nameIdx = m[0].indexOf(name);
      if (nameIdx >= 0) {
        const header = collectHeader(lines, i, lineText.slice(m[0].length));
        types.push(
          buildTypeDecl(path, "class", name, lineNo, nameIdx + 1, header, RE_ABSTRACT_CLASS.test(lineText))
        );
      }
      matched = true;
    }
    if ((m = RE_INTERFACE.exec(lineText))) {
      const name = m[1]!;
      pushMatch(symbols, path, lineNo, m, name, "interface");
      const nameIdx = m[0].indexOf(name);
      if (nameIdx >= 0) {
        const header = collectHeader(lines, i, lineText.slice(m[0].length));
        types.push(buildTypeDecl(path, "interface", name, lineNo, nameIdx + 1, header, false));
      }
      matched = true;
    }
    if ((m = RE_TYPE.exec(lineText))) {
      pushMatch(symbols, path, lineNo, m, m[1]!, "type");
      matched = true;
    }
    if ((m = RE_ENUM.exec(lineText))) {
      const name = m[1]!;
      pushMatch(symbols, path, lineNo, m, name, "enum");
      const nameIdx = m[0].indexOf(name);
      if (nameIdx >= 0) {
        types.push(buildTypeDecl(path, "enum", name, lineNo, nameIdx + 1, "", false));
      }
      matched = true;
    }
    if ((m = RE_VAR.exec(lineText))) {
      pushMatch(symbols, path, lineNo, m, m[1]!, "const");
      matched = true;
    }
    if (!matched) {
      const mm = RE_METHOD.exec(lineText);
      if (mm && !METHOD_BLACKLIST.has(mm[1]!)) pushMatch(symbols, path, lineNo, mm, mm[1]!, "method");
    }
  }

  // 去重（同名同位置）→ 按 line/col 排序：与原 extractSymbols 完全一致。
  const seen = new Set<string>();
  const dedup = symbols.filter((s) => {
    const k = `${s.name}@${s.line}:${s.col}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  dedup.sort((a, b) => (a.line - b.line) || (a.col - b.col));
  return { symbols: dedup, types };
}

/* ---------------- imports ---------------- */

function extractImports(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const seen = new Set<string>();
  const add = (local: string, imported: string | null, source: string, wildcard: boolean, offset: number): void => {
    if (!local || !source) return;
    const k = `${local}@${offset}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ local, source, imported, wildcard });
  };
  const splitNamed = (raw: string): { local: string; imported: string }[] => {
    const items: { local: string; imported: string }[] = [];
    for (const piece of raw.split(",")) {
      let item = piece.trim();
      if (!item) continue;
      item = item.replace(/^type\s+/, "");
      const asMatch = /\s+as\s+/.exec(item);
      if (asMatch) {
        const imported = item.slice(0, asMatch.index).trim();
        const local = item.slice(asMatch.index + asMatch[0].length).trim();
        if (imported && local) items.push({ local, imported });
      } else {
        items.push({ local: item, imported: item });
      }
    }
    return items;
  };

  let m: RegExpExecArray | null;
  // import * as ns from "…"
  const reNs = /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g;
  while ((m = reNs.exec(text))) {
    add(m[1]!, null, m[2]!, true, m.index + m[0].indexOf(m[1]!));
  }
  // import { a as b, c } from "…"（含 import type）
  const reNamed = /\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = reNamed.exec(text))) {
    for (const item of splitNamed(m[1]!)) {
      add(item.local, item.imported, m[2]!, false, m.index + Math.max(0, m[0].indexOf(item.local)));
    }
  }
  // import X, { a } from "…" / import X from "…"
  const reDefault = /\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = reDefault.exec(text))) {
    add(m[1]!, "default", m[3]!, false, m.index + m[0].indexOf(m[1]!));
    if (m[2]) {
      for (const item of splitNamed(m[2])) {
        add(item.local, item.imported, m[3]!, false, m.index + Math.max(0, m[0].indexOf(item.local)));
      }
    }
  }
  // export { a } from "…"（re-export 视为对外部定义的引用）
  const reReexport = /\bexport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = reReexport.exec(text))) {
    for (const item of splitNamed(m[1]!)) {
      add(item.local, item.imported, m[2]!, false, m.index + Math.max(0, m[0].indexOf(item.local)));
    }
  }

  return out;
}

/* ---------------- 适配器 ---------------- */

export const typescriptAdapter: LanguageAdapter = {
  id: "typescript",
  extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"] as const,
  precisionNote: "TypeScript/JavaScript：基于语法索引；类型推导、动态导入、node_modules 内定义不参与。",
  parse(text: string, path: string): ParsedFile {
    try {
      const { symbols, types } = scanDeclarations(text, path);
      return { symbols, types, imports: extractImports(text) };
    } catch {
      // 约定：适配器绝不向外抛异常；单文件解析失败只让该文件退化为空结构。
      return emptyParsed();
    }
  },
};
