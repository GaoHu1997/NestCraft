# LLD-CR094：多语言代码阅读导航（Java / C# / Python）实现方案

- 关联需求：[CR-094](../PRD/CR-094-多语言代码阅读导航.md)；Story：[STORY-110](../Plan/Story/STORY-110-多语言符号索引适配层.md)（适配层）、[STORY-111](../Plan/Story/STORY-111-接口实现与父类型跳转.md)（双向跳转）、[STORY-112](../Plan/Story/STORY-112-继承gutter标记与语言标识.md)（gutter 与语言标识）；归属 FEAT-007。
- 设计基准：[UI-CR094-v1](../UI/文档/UI-CR094-多语言代码阅读导航.md)；落地位置 `src/modules/editor/navigation/`。
- 日期：2026-11-26；负责人：lead；授权依据：用户 2026-11-26「先支持 java/C#/python 然后尽量 ide 精确，不行就精度损失吧……按这个来做，我授权你设计完成后进入开发，过程中有需要我决策的，都按照推荐来即可」。
- 前序：[CR-090](LLD-CR090-编码区文件操作与代码导航.md)（第一版定义跳转 + 面包屑）；本方案是**增量**，不推翻 CR-090。

## 1. 问题与取舍

CR-090 的符号索引只有 TS/JS 的声明与 import，**没有继承关系**，所以「接口 → 实现类」无从查询；Java/C# 甚至不在支持范围。

真实 IDE 用 LSP 的 `textDocument/implementation`（openidea 同样如此，且**没有语法兜底**，见 [RESEARCH-007 §7.4](../调研/RESEARCH-007-openidea编码区与代码导航.md)）。本项目的取舍是**用语法索引换可用性**：

| 方案 | 精度 | 成本 | 本轮选择 |
| --- | --- | --- | --- |
| LSP（jdtls / OmniSharp / pyright） | IDE 级，含匿名类、泛型、跨模块 | 需分发 server、进程管理、Java/Go 工具链，工程量大 | 否 |
| **语法索引（本方案）** | 只认源码里显式写出的继承 | 小，零外部依赖，离线可用 | **是** |
| 不做 | — | — | 否 |

**用户已确认接受精度损失，但要求「不行就精度损失」可接受，前提是损失可见**。因此本方案把「精度说明」做成产品能力：界面提示、选择器标注、gutter tooltip 都必须带上「基于语法索引，可能不全」，不允许静默给出看似精确的结果。

## 2. 架构：语言适配层

```text
navigation/
├── adapters/
│   ├── types.ts       契约：LanguageAdapter / ParsedFile / TypeDecl / ImportRef + 共用工具
│   ├── registry.ts    扩展名 → 适配器；语言展示名与 precisionNote
│   ├── typescript.ts  既有 TS/JS 逻辑搬迁（行为等价）
│   ├── java.ts        Java
│   ├── csharp.ts      C#
│   └── python.ts      Python
├── symbols.ts         调度 + 索引（byName / byTypeName / 反向 bySuper）+ 三个查询
├── goto.ts            跳转编排：定义 / 实现 / 父类型 + 选择器通道 + 编辑器扩展
├── history.ts         导航历史（既有）
├── GotoPopup.tsx      多目标选择器（新增 note 标注）
├── Breadcrumbs.tsx    面包屑（既有，多语言复用）
├── InheritanceGutter.tsx  ↓/↑ 继承标记（新增）
└── navigation.css
```

**分层原则**：适配器只做**单文件语法解析**，绝不跨文件、不读磁盘、不推导类型；跨文件匹配与反向查询集中在 `IndexImpl`。这样新增语言只需一个文件 + registry 一行。

### 2.1 契约（`adapters/types.ts`）

```ts
interface LanguageAdapter {
  id: string;                          // "java" / "csharp" / "python" / "typescript"
  extensions: readonly string[];
  precisionNote: string;              // 界面可见的一句话精度说明
  parse(text, path): ParsedFile;      // 纯函数，绝不抛异常
}
interface ParsedFile { symbols: SymbolDef[]; types: TypeDecl[]; imports: ImportRef[] }
interface TypeDecl {
  name; kind; path; line; col;
  supers: TypeRef[];        // 父类/基类（C#/Python 无法区分时全放这里）
  interfaces: TypeRef[];    // 仅 Java 区分 implements
  abstract: boolean;
  preview?: string;         // 索引构建时补
}
interface ImportRef { local; source; imported: string|null; wildcard: boolean }
```

共用工具：`splitTopLevel`（泛型感知的逗号拆分）、`plainTypeName`（去包名/泛型取末段）、`parseTypeList`、`emptyParsed`。

### 2.2 索引与查询（`symbols.ts`）

新增两张表：

- `byTypeName: Map<string, TypeDecl[]>` —— 类型名 → 声明；
- `bySuper: Map<string, TypeDecl[]>` —— 父类型 plain 名 → 直接继承/实现它的声明（**反向索引**，实现类查询靠它）。

三个查询（`SymbolIndex` 新接口）：

```ts
implementationsOf(name, fromPath?): TypeTarget[]   // 直接 + 最多 3 层间接（via 标注），去重、≤50
supertypesOf(name, fromPath?): TypeTarget[]        // 取 supers + interfaces，解析到定义位置
typesInFile(path): TypeDecl[]                      // gutter 用
precisionFor(path): string | null                  // 界面提示用
```

`implementationsOf` 的算法：
1. `bySuper.get(name)` 得**直接**实现；
2. 对每个直接实现的类型名再查 `bySuper`，得**间接**（`relation:"indirect"`，`via` 记中间类），最多 3 层、`seen` 去重防环；
3. 排除「来源文件里同名声明自身」；
4. 直接实现排在前面。

**边界**：同名类型跨包时，解析按「同文件 → 同目录 → 其它」打分；找不到定义（如 JDK/NuGet 内置类型）不返回，界面提示「来自外部依赖，无法跳转」。

### 2.3 各语言解析规则与精度边界

| 语言 | 识别 | 识别不到（界面必须可见） |
| --- | --- | --- |
| **Java** | `class/interface/enum/record` + `extends`/`implements`；注解行跳过；多行与泛型列表；`import`（含 `static`、通配） | 匿名类 `new IFoo(){}`、Lambda、泛型实参、外部 jar 中的实现 |
| **C#** | `class/interface/struct/record/enum` + 冒号后列表；`using`（含 alias、global）；`namespace` | 基类与接口**语法不可分**（统一 `supers`，界面叫「父类型」）；partial 分散、显式接口实现、NuGet 类型；`enum : byte` 的底层类型与 `where T : class` 约束必须排除 |
| **Python** | `class X(Base, ...)`；过滤 `metaclass=`/`key=value`；`from/import`（含多行括号、相对导入） | 鸭子类型、`IFoo.register()` 虚拟子类、`__subclasshook__`、动态注入 |
| TS/JS | 既有行为等价搬迁 + 新增 `extends`/`implements` | 类型推导、`import()` 动态导入、`node_modules` |

实现要点（三种语言共同）：**先把注释与字符串替换为等长空白再做正则**，保证 line/col 与原文一致，同时避免注释/字符串里的 `class Foo` 误报。

## 3. 界面行为

| 入口 | 行为 |
| --- | --- |
| `Ctrl+Alt+B` | 光标处类型的实现/子类：0 → 提示（附精度说明）；1 → 直接跳；N → 选择器 |
| `Ctrl+U` | 光标处类型的父类型，同上 |
| `Ctrl+Alt+左键` | 沿用 CR-090 的鼠标手势（跳定义）；实现跳转走键盘/菜单 |
| 编辑器右键菜单 | 「跳转到实现」「跳转到父类型」 |
| gutter `↓ / ↑ / ↓↑` | 类型声明行显示；tooltip 写实现数量与父类型名 + 「基于语法索引，可能不全」；点击跳第一个目标 |
| 多目标选择器 | 条目新增 `note`：`直接实现` / `间接 · 经 Xxxxx` / `父类型` |
| 不支持语言 | `.go`/`.vue` 等提示「当前文件类型暂不支持跳转」，不静默 |

## 4. 性能与降级

- 索引仍是「按需构建 + 页面生命周期缓存」；构建时跳过 `node_modules/.git/target/dist/bin/obj/venv/__pycache__` 等。
- 单文件 ≤1MB（后端 `fs_read_file` 限制），总数 ≤5000，并发 ≤8；单文件解析异常只跳过该文件。
- gutter 重算 400ms 防抖，只处理本文件类型声明（通常几十个），不随每次按键重算。
- 索引不可用时 gutter 静默不显示、跳转提示「未找到」，不打断编辑。

## 5. 并行开发边界（本轮实际分工）

| 工作包 | 文件 | 说明 |
| --- | --- | --- |
| 契约 | `adapters/types.ts`、`adapters/registry.ts` | 主代理先定，避免各适配器接口漂移 |
| Java / C# / Python 适配器 | `adapters/{java,csharp,python}.ts` | 三个子代理并行，各自独立文件 |
| TS 搬迁 | `adapters/typescript.ts` | 独立子代理，要求与原 `extractSymbols`/`extractImports` 等价 |
| 调度与查询 | `symbols.ts` | 主代理（依赖契约） |
| 跳转与 gutter | `goto.ts`、`InheritanceGutter.tsx`、`GotoPopup.tsx`、`navigation.css` | 主代理 |
| 编辑器集成 | `index.tsx` | 主代理独占，避免并发冲突 |
| 设计 | `docs/UI/editor-inherit/index.html` 等 | 设计子代理 |
| 需求 | CR-094 + 三个 Story | 需求子代理 |

## 6. 验证计划

| 项 | 方式 | 结果 |
| --- | --- | --- |
| 类型与构建 | `npx tsc --noEmit`、`npm run build` | 见 [REPORT-CR094](../Test/REPORT-CR094-多语言代码阅读导航验证.md) |
| 适配器正确性 | 每个适配器自测（正例/反例，含注释/字符串/泛型/多行） | 子代理执行，见报告 |
| 索引等价性 | TS 适配器与原 `extractSymbols`/`extractImports` 逐项比对 | 子代理执行，见报告 |
| 跳转行为 | 三语言各自：接口→实现（直接/间接/多目标）、实现→父类型、无实现、不支持语言 | 待真机验证 |
| 视觉 | 与 UI-CR094-v1 同视口同主题逐场景对照 | 待验证 |

## 7. 未决项与风险

1. **精度**：语法索引无法覆盖匿名类/Lambda/泛型实参/外部依赖，用户已接受；界面必须持续标注。
2. **同名类型**：跨包同名时按目录就近选择，可能选错；选择器会列出全部候选，用户可人工判断。
3. **C# 语义**：基类与接口不可分，界面统一称「父类型」，不谎称接口。
4. **后续**：C/C++/Go/Vue 未做；查找引用（全项目）未做；LSP 升级路径保留（届时适配器可整体替换，跳转与 UI 层不变）。
