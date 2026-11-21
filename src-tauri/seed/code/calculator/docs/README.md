# 计算器项目文档导航

本目录是示例项目的完整研发文档，结构与工作台读取方式一致。

| 目录 | 内容 | 现行入口 |
| --- | --- | --- |
| `Plan/Vision` | 产品愿景、目标用户、成功指标 | [VISION-001](Plan/VISION-001-产品愿景.md) |
| `Plan/Epic` | 业务目标拆分 | [EPIC-001](Plan/Epic/EPIC-001-四则运算计算器.md) |
| `Plan/Feature` | 可独立交付的能力 | [FEAT-001](Plan/Feature/FEAT-001-基础四则运算.md)、[FEAT-002](Plan/Feature/FEAT-002-键盘输入与历史记录.md) |
| `Plan/Story` | 可验收的用户故事 | [STORY-001](Plan/Story/STORY-001-四则运算与连续计算.md)、[STORY-002](Plan/Story/STORY-002-键盘输入与历史记录.md) |
| `PRD` | 需求规格与验收基线 | [PRD-001](PRD/PRD-001-计算器需求规格.md) |
| `LLD` | 技术方案与关键决策 | [LLD-FEAT-001](LLD/LLD-FEAT-001-实现方案.md)、[ADR-001](LLD/ADR-001-计算引擎选型.md) |
| `UI` | 可操作原型与交互说明 | [仿真原型](UI/仿真原型UI.html)、[交互说明](UI/文档/UI-FEAT-001-交互设计.md) |
| `Test` | 测试方案与实际结果 | [TEST-FEAT-001](Test/TEST-FEAT-001-测试方案.md)、[REPORT-001](Test/REPORT-001-验证记录.md) |

## 阅读顺序

1. 先看 [VISION-001](Plan/VISION-001-产品愿景.md) 了解为什么做。
2. 再看 [PRD-001](PRD/PRD-001-计算器需求规格.md) 确认做什么、不做什么。
3. 打开 [仿真原型](UI/仿真原型UI.html) 看交互长相。
4. 读 [LLD-FEAT-001](LLD/LLD-FEAT-001-实现方案.md) 理解怎么实现。
5. 最后对照 `src/` 代码与 `tests/` 用例，运行验证。

## 文档约定

- 需求编号稳定：`VISION/EPIC/FEAT/STORY` 前缀 + 三位序号，编号不因改名而变化。
- 每个 Story 自己的「验收标准」是唯一可执行标准，PRD 只引用不重复。
- 技术结论以 LLD 为准，界面结论以 UI 原型与交互说明为准。
