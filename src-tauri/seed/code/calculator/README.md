# 计算器 · 从需求到代码

一个可直接运行、可被测试覆盖的桌面计算器示例项目，用来演示「需求 → 设计 → 方案 → 代码 → 验证」的完整闭环。

## 这是什么

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 需求树 | `docs/Plan/` | 愿景、Epic、Feature、Story，带 `id/type/parent/status/owner` front matter，工作台「需求」页签直接读取 |
| 需求规格 | `docs/PRD/PRD-001-计算器需求规格.md` | 范围、规则、边界与验收标准 |
| 设计稿 | `docs/UI/仿真原型UI.html` | 单文件可操作原型，双击即可在浏览器打开 |
| 交互说明 | `docs/UI/文档/UI-FEAT-001-交互设计.md` | 键盘映射、状态与错误提示 |
| 技术方案 | `docs/LLD/` | 状态机、接口契约、关键取舍 |
| 代码 | `src/` | 原生 HTML/CSS/JS，零依赖，直接打开即用 |
| 测试 | `tests/` | Node 内置测试运行器（`node --test`） |

## 运行

```bash
# 直接打开界面
start src/index.html      # Windows
open  src/index.html      # macOS

# 运行测试（需要 Node 18+）
npm test
```

## 功能

- 四则运算、连续运算（`2 + 3 × 4` 顺序计算，不做运算符优先级）
- 小数点、正负号、百分比、退格、全部清除（`C` / `AC`）
- 键盘输入完整映射：数字、`+ - * /`、`Enter`、`Backspace`、`Escape`、`%`
- 最近 20 条计算历史，点击历史条目可回填结果
- 除零、溢出等错误显式提示，不产生 `NaN` 静默结果

## 设计边界

- 不做科学计算（三角函数、幂、对数）与括号表达式解析
- 不做多行表达式编辑器；一次只保留一个「当前值 + 待执行运算符」
- 不使用 `eval`，求值走显式状态机

## 目录结构

```text
calculator/
├── docs/
│   ├── Plan/{Vision,Epic,Feature,Story}/
│   ├── PRD/
│   ├── LLD/
│   ├── UI/仿真原型UI.html
│   └── Test/
├── src/
│   ├── index.html
│   ├── calculator.css
│   └── calculator.js
├── tests/calculator.test.mjs
├── package.json
└── README.md
```
