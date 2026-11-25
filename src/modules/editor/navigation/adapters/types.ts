/**
 * adapters/types.ts —— 语言适配层契约（CR-094）。
 *
 * 设计目标：把「符号索引」从 TS/JS 专用逻辑，扩展为可插拔的语言适配器。
 * 每个语言适配器只负责**单文件语法解析**（声明、import、类型继承关系），
 * 不做类型推导、不跨文件解析——跨文件与反向查询由 symbols.ts 统一负责。
 *
 * 精度原则（用户 2026-11-26 决定：路线 A，允许精度损失，但必须界面可见）：
 * - 只识别**源码里显式写出来的**关系（Java `implements`、C# `:`、Python 基类列表）；
 * - 匿名类、Lambda、泛型实参、跨 jar/nuget 依赖、动态绑定一律识别不到；
 * - 每个适配器的 `precisionNote` 会展示在界面上，不允许静默给出"看起来精确"的结果。
 */

/** 符号种类：前 7 个是 CR-090 既有值，其余为 CR-094 多语言新增。 */
export type SymbolKind =
  | "class"
  | "function"
  | "method"
  | "const"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "record"
  | "object"
  | "protocol"
  | "property"
  | "namespace"
  | "annotation";

export interface SymbolDef {
  name: string;
  kind: SymbolKind;
  /** 相对项目根的路径（`/` 分隔，与现有索引一致）。 */
  path: string;
  /** 1-based 行号。 */
  line: number;
  /** 1-based 列号（声明名在行内的起始位置）。 */
  col: number;
}

export type TypeKind =
  | "class"
  | "interface"
  | "enum"
  | "struct"
  | "record"
  | "object"
  | "protocol"
  | "annotation";

/**
 * 父类型引用。
 * `plain` 是去掉包名/命名空间/泛型后的末段名，用于跨文件按名匹配；
 * `raw` 保留源码原样（如 `java.util.List<PayService>`），用于展示与调试。
 */
export interface TypeRef {
  plain: string;
  raw: string;
}

/**
 * 类型声明及其继承关系。
 *
 * 语言差异（重要，界面按此呈现）：
 * - Java：`supers` 放 `extends`，`interfaces` 放 `implements`，二者语义明确可分；
 * - C#：`class A : Base, IFoo` 语法上**无法区分**基类与接口，统一放 `supers`，
 *   `interfaces` 恒为空；界面统一叫「父类型」，不谎称是接口；
 * - Python：基类列表统一放 `supers`，`interfaces` 恒为空。
 */
export interface TypeDecl {
  name: string;
  kind: TypeKind;
  path: string;
  line: number;
  col: number;
  /** 父类 / 基类列表。 */
  supers: TypeRef[];
  /** 仅 Java 可区分时填充 `implements` 列表；其它语言为空数组。 */
  interfaces: TypeRef[];
  /** 抽象类 / 抽象方法所属类型（Java `abstract`、C# `abstract`、Python `ABCMeta`）。 */
  abstract: boolean;
  /** 声明行源码预览（索引构建时填充，供多目标选择器展示；适配器可不填）。 */
  preview?: string;
}

export interface ImportRef {
  /** 本文件内可用的名字（`import {a as b}` 的 b、`using X = Y.Z` 的 X、`import m as n` 的 n）。 */
  local: string;
  /** 来源：Java 全限定名、C# using 命名空间、Python 模块路径（可为相对 `.models`）。 */
  source: string;
  /** 从来源引入的具体名字；整模块/通配导入为 null。 */
  imported: string | null;
  /** `import a.b.*` / `import *` 这类通配。 */
  wildcard: boolean;
}

export interface ParsedFile {
  symbols: SymbolDef[];
  types: TypeDecl[];
  imports: ImportRef[];
}

/** 语言适配器：只做单文件语法解析，必须纯函数、不得抛异常。 */
export interface LanguageAdapter {
  /** 稳定标识，如 `"java"`、`"csharp"`。 */
  readonly id: string;
  /** 小写扩展名，如 `["java"]`。 */
  readonly extensions: readonly string[];
  /** 界面上可见的一句话精度说明（写入提示条与 tooltip）。 */
  readonly precisionNote: string;
  /**
   * 解析单个文件。
   * @param text 文件全文
   * @param path 相对项目根的路径（`/` 分隔），用于填充 `SymbolDef.path`
   * 实现必须捕获自身异常并返回空结构，绝不能向外抛。
   */
  parse(text: string, path: string): ParsedFile;
}

/* ------------------------------------------------------------------ */
/* 共用工具：三语言解析器都用它拆「泛型感知」的逗号列表                  */
/* ------------------------------------------------------------------ */

const OPEN: Record<string, string> = { "<": ">", "(": ")", "[": "]" };

/**
 * 按顶层分隔符拆分，忽略 `<>` `()` `[]` 内部的逗号。
 * 例：`"Base<T, U>, IFoo, Map<K, V>"` → `["Base<T, U>", "IFoo", "Map<K, V>"]`
 */
export function splitTopLevel(text: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (OPEN[c]) depth++;
    else if (c === ">" || c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 去掉泛型参数与包名/命名空间的末段名：`java.util.List<Foo>` → `List`，`a.b.C` → `C`。 */
export function plainTypeName(raw: string): string {
  let s = raw.trim();
  // 去掉行内注释与可能的注解残留
  s = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").trim();
  // 去掉泛型：从第一个 '<' 起截断（用深度确认它确实在开头部分）
  const lt = s.indexOf("<");
  if (lt > 0) s = s.slice(0, lt);
  // 去掉包名/命名空间前缀
  const dot = s.lastIndexOf(".");
  if (dot >= 0) s = s.slice(dot + 1);
  // 去掉指针/引用/数组/可空等修饰符（C/C#/Java 少见但防御）
  s = s.replace(/[?*&\s[\]]+$/g, "").trim();
  return s;
}

/** 构造 TypeRef（raw 保留原样，plain 用于匹配）。 */
export function typeRef(raw: string): TypeRef {
  return { plain: plainTypeName(raw), raw: raw.trim() };
}

/** 过滤明显不是类型名的项（空、关键字、字面量、keyword 参数）。 */
export function isLikelyTypeName(name: string): boolean {
  if (!name) return false;
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false;
  const lower = name.toLowerCase();
  return !["class", "interface", "enum", "extends", "implements", "where", "new", "null", "true", "false", "undefined"].includes(lower);
}

/** 把 `a, b, c` 形式的原始列表解析为 TypeRef[]（自动过滤非法项）。 */
export function parseTypeList(raw: string | undefined | null): TypeRef[] {
  if (!raw) return [];
  const out: TypeRef[] = [];
  for (const item of splitTopLevel(raw)) {
    const ref = typeRef(item);
    if (isLikelyTypeName(ref.plain)) out.push(ref);
  }
  return out;
}

/** 空解析结果（适配器异常时返回它，保证调用方永远拿得到结构）。 */
export function emptyParsed(): ParsedFile {
  return { symbols: [], types: [], imports: [] };
}
