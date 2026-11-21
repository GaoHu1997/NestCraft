# LLD-FEAT-001：计算器实现方案

- 关联需求：[FEAT-001](../Plan/Feature/FEAT-001-基础四则运算.md)、[FEAT-002](../Plan/Feature/FEAT-002-键盘输入与历史记录.md)
- 关联验收：AC-STORY-001-01～10、AC-STORY-002-01～09
- 本次范围：计算器内核、界面渲染、键盘映射、历史记录与测试

## 1. 现状与复用

本仓库从零开始，无既有实现可复用。约束是纯前端、零依赖、可直接用浏览器打开：因此不使用打包器，直接使用原生 ES Module。

## 2. 总体结构

```text
index.html          按钮布局、显示区、历史区；只做 DOM 渲染
   │  import
calculator.js       createEngine() / reduce() / actionForKey() / formatNumber()
   │
tests/*.test.mjs    直接 import calculator.js，用 node --test 运行
```

内核与 DOM 完全分离：`reduce(state, action) → state` 是纯函数，界面只负责把动作交给 `press()` 并渲染最新状态。

## 3. 状态模型

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `entry` | string | 当前输入的显示文本，参与计算时转数值 |
| `display` | string | 显示区主行（错误时显示错误文案） |
| `left` | number \| null | 已累积的左操作数 |
| `op` | `+ - × ÷` \| null | 待执行运算符 |
| `waiting` | boolean | 刚按完运算符或等号，下一次数字输入开始新输入 |
| `error` | string \| null | 错误文案 |
| `expression` | string | 表达式行（上一行） |
| `lastOp` / `lastOperand` | — | 重复等号所需的上一次运算 |

## 4. 动作与流程

| 动作 | 行为 |
| --- | --- |
| `digit` | `waiting`/`error` 时重置为新数字；否则追加，前导 0 归一，上限 15 位 |
| `dot` | 已有小数点则忽略；`waiting` 时从 `0.` 开始 |
| `op` | 有待执行运算符则先计算并累积；连续按运算符只替换运算符 |
| `equals` | 有待执行运算则计算、写历史；无则固定当前值；`repeatEquals` 复用上次运算 |
| `clear`（C） | 只清当前输入 |
| `allClear`（AC） | 回到初始状态 |
| `back` | 逐位删除，最少到 `0` |
| `negate` | 切换符号 |
| `percent` | 当前输入 ÷ 100 |
| `recall` | 历史结果回填 |

求值函数 `apply(left, op, right)` 覆盖四种运算；除以 0 返回 `null`，由调用方转成错误状态，避免 `Infinity` 进入显示（AC-STORY-001-07）。

## 5. 接口契约

```ts
type Action =
  | { type: "digit"; value: string }
  | { type: "dot" | "equals" | "repeatEquals" | "clear" | "allClear" | "back" | "negate" | "percent" }
  | { type: "op"; value: "+" | "-" | "×" | "÷" }
  | { type: "recall"; value: number };

reduce(state: State, action: Action): State
actionForKey(event: KeyboardEvent): Action | null
createEngine(): { press(a: Action): void; subscribe(fn): () => void; snapshot(): { state, history }; clearHistory(): void }
```

## 6. 显示格式

- `formatNumber`：`toFixed(10)` 后转回数值去掉末尾 0；绝对值 ≥ 1e15 用 `toExponential(6)`。
- 结果 `1/3` → `0.3333333333`（AC-STORY-001-10）。

## 7. 历史记录

- 写入时机：`equals`/`repeatEquals` 计算成功，且状态带 `committed` 表达式。
- 结构：`{ expression: string, result: number }`，新的在数组头部。
- 容量：`MAX_HISTORY = 20`，用 `slice(0, MAX_HISTORY)` 截断。
- 回填：点击条目 dispatch `recall`，结果写入 `entry`，不产生新的历史条目。
- 不落盘。

## 8. 键盘

`actionForKey` 单点映射，`*`/`x` → `×`，`/` → `÷`，`Enter`/`=` → `equals`，`Escape`/`c` → `allClear`。监听挂在 `window` 上，输入焦点不在文本框内时全部生效；页面本身没有文本输入框，因此不存在与输入法冲突的场景。

## 9. 错误处理

| 情况 | 结果 |
| --- | --- |
| 除数为 0 | 状态回到初始，显示「不能除以 0」 |
| 结果非有限值 | 显示「结果超出范围」 |
| 非法字符输入 | 内核直接忽略，不改状态 |

## 10. 测试与验证

`tests/calculator.test.mjs` 使用 Node 内置 `node:test`，逐条覆盖 AC。运行 `npm test`。验证结论见 [REPORT-001](../Test/REPORT-001-验证记录.md)。

## 11. 未决项与取舍

- 不做优先级解析：见 [ADR-001](ADR-001-计算引擎选型.md)。
- 不持久化历史：需求明确刷新即清空，避免引入存储与隐私问题。
