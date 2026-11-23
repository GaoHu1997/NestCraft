# LLD-CR059-FEAT015：CLI 任务模型路由与 SDK 管理实现

- 关联需求：[CR-059 §1 D/E、§4.4/§4.5](../PRD/CR-059-设置中心评审调整.md)／[STORY-077](../Plan/Story/STORY-077-CLI与SDK管理评审调整.md)（FEAT-015）。
- 设计基准：[UI-CR059](../UI/文档/UI-CR059-设置中心评审调整.md) §1.3（单行折叠路由，2026-11-23 兜底置首）；资源 `docs/UI/workbench-v4/`。
- 授权：用户 2026-11-23「代码实现没，没实现需要实现」＝正式编码授权，范围限 CR-059 D/E（STORY-077 / FEAT-015）。同轮追加「cli 的兜底模型放到第一个」。
- 状态：**已实现**（2026-11-23）。软件侧组件 `src/modules/settings/CliRoute.tsx`；本次会话补做兜底置首与 × 位置照稿修正，其余部分为并行会话同期实现。
- 工作边界：本会话只实现 FEAT-015 范围内内容；不改 FEAT-014（模型配置）、FEAT-013（能力）源码。

## 1. 实现现状与本次落点

| 项 | 落地位置 | 状态 |
| --- | --- | --- |
| 单行折叠路由组件 | `src/modules/settings/CliRoute.tsx`（`CliRoute`，229 行） | 已在 |
| 路由样式 | `src/modules/settings/settings.css`（`.route-*`，第 375～406 行） | 已在 |
| 偏好读写与迁移 | `SettingsSdk.tsx`（`parsePreference` / `migrated` 落盘） | 已在 |
| 派发消费 | `src-tauri/src/commands/chat.rs`（`RouteTable`/`resolve_route`/`detect_task_types`） | 已在（后端既有） |
| **兜底标签置首** | `CliRoute.tsx` `.route-tabs` 渲染顺序 | **本次改** |
| **× 位置照稿** | `settings.css` `.route-x` 改为标签内右侧居中（`right:3px; top:50%`），可删标签预留 `padding-right:22px` | **本次改** |
| **前后端契约测试** | `chat.rs` `cr059_front_end_route_json_deserializes_into_route_table` | **本次新增** |
| Grok 标志 viewBox | `public/ui/brand-icons/grok.svg` ＝ `0.36 0.5 33.34 32` | 已同步 |

## 2. 数据契约（与后端逐字对齐）

写入 `setting_default(scope='global', key='cli.preferences.<cliId>')` 的 JSON：

```jsonc
{
  "permission": "agent",          // 五档 id：default/plan/agent/auto/full
  "route": {
    "slots": [                    // 变长 0～5；顺序即优先级
      { "model": "providerId/modelId", "effort": "high", "types": ["仓库探索"] }
    ],
    "fallback": { "model": "", "effort": "" }   // 空 model ＝ 跟随会话选择
  }
}
```

- `model` 用 `providerId/modelId`（沿用 `modelValue()`），不是显示名——后端直接把它当模型标识下发。
- `effort` 空串＝沿用会话档位（后端 `resolve_route` 已如此处理）。
- `types` 取自 13 类固定词表，与 `chat.rs::TASK_TYPES` 一致。
- 兼容旧值：读到旧结构（有 `model/effort/minDifficulty/types` 而无 `route`）时，把旧 `model/effort` 迁为一个槽或兜底？**不迁**——旧字段语义是「CLI 默认模型」，与新路由语义不同，静默转换会改变行为。做法：`route` 缺失时视为空表（全部走兜底＝跟随会话），旧 `model/effort` 保留在 JSON 中不删除，UI 不再暴露；用户显式配置后写入 `route`。
- 上限保护：读取时 `slots` 超过 5 项截断前 5 项并在保存提示；非法元素（非对象/字段类型错）丢弃该项，不让整表失效。

## 3. 交互实现（照稿，已落地）

组件内状态（`CliRoute`）：
- `open: boolean` —— 折叠态，默认 false。
- `selected: string` —— `"fallback"` 或槽索引字符串，默认 `"fallback"`（兜底置首后默认即兜底）。

渲染（`.route-card`）：
1. `.route-bar`：`.route-tabs` 内依次为 **兜底标签** → `模型1…模型N` → 未达上限时的「＋新增」（兜底置首，2026-11-23）；右侧 `N/5`（0 槽显示「仅兜底」）＋折叠箭头。
2. 展开时渲染**唯一** `.route-detail`：
   - 兜底：模型下拉（含「跟随主 agent（默认）」空值项）＋思考等级下拉；说明「任一模型槽不可用时使用；兜底不可删除」。
   - 模型槽：模型下拉（协议兼容过滤）＋思考等级＋13 类 chips＋底部「删除此模型槽」。
3. 标签样式统一（同字号/高度/内距）；模型标签悬浮或聚焦时右侧出现 ×（标签内居中，非右上角角标），兜底标签不渲染 ×。
4. 新增：push 空槽 → 选中该槽 → 保持展开；达 5 个不渲染新增按钮。
5. 删除：splice → 选中态落到原位置（越界取末位）→ 0 槽回到 `"fallback"`。

保存：沿用现有 `operation()` 与 Shell 保存流程，把 `route` 一并写入同一个 key；Shell 检测未完成时仍禁用保存（不回退既有门禁）。

## 4. 影响范围与不改边界

本次实际改动：
- `src/modules/settings/CliRoute.tsx`（兜底置首）
- `src/modules/settings/settings.css`（× 位置与预留内距）
- `src-tauri/src/commands/chat.rs`（新增契约测试，未改生产逻辑）
- `public/ui/brand-icons/grok.svg`（viewBox，与设计稿同步）

明确未改：后端路由消费逻辑（`resolve_route` 等）已就绪且未被本次触碰；`SettingsModels/Skill/Mcp/Tool.tsx` 属其他 Feature，未动。

## 5. 验证结果（2026-11-23）

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 前端类型与构建 | `npm run build`（tsc --noEmit + vite build） | 通过（182 模块，2.58s，产物 1,787 kB） |
| 后端路由测试 | `cargo test cr059` | 3 项全通过（0 failed） |
| 前后端契约 | 新增 `cr059_front_end_route_json_deserializes_into_route_table`：用前端真实 JSON 形状反序列化 `RouteTable` | 通过 |
| 兜底置首 | 浏览器（`?preview=design` 隔离预览）DOM 断言 | 通过：标签序＝`[兜底模型]`，默认 `aria-selected`＝兜底，行尾「仅兜底」 |
| 点行展开 | 同上 | 通过：`.route-detail` 出现，含「兜底模型」＋「思考等级」两个下拉；说明含「兜底模型不可删除」 |
| 兜底思考等级 | 同上 | 通过：`aria-label="兜底思考等级"`，选项＝沿用会话/off/minimal/low/medium/high/xhigh/max |
| 兜底无删除入口 | 同上 | 通过：`.route-detail-f` 不存在 |
| 新增 | 同上 | 通过：标签＋「模型1」并选中，行尾 `1/5`，详情＝模型/思考等级/执行任务类型/删除入口 |
| 悬浮 × | 同上（`cua.move` 触发 hover） | 通过：`display:none` → `grid`，16×16，位于标签内右侧（右边距 3px），标签右内距 22px |
| × 删除 | 同上 | 通过：删除后只剩「兜底模型」，行尾「仅兜底」 |
| 配置生效 | 同上 | 通过：选模型 `PRV-MAGPIE/gpt-6-astra-ar`、思考 `high`、任务类型「仓库探索」，保存后 toast「CLI 偏好已保存…」 |
| 视觉对照 | 证据 `docs/Test/evidence-cr059-software/01-software-route-collapsed.png`、`02-software-route-expanded-hover-x.png` | 与设计稿 `evidence-cr059/19-cli-route-fallback-first.png` 同结构 |

未验证（如实登记）：
1. **真实持久化**：本次在浏览器隔离预览（`?preview=design`）验证，该通道为纯内存 mock，重载后配置丢失属预期；Tauri 真实环境下的读写与 DB 落盘未实测。
2. **真实派发生效**：路由被主 agent 实际消费（模型切换、思考档位下发）未在真实会话中验证，仅验证了结构契约与后端解析。
3. 窄屏 390×844、深色主题未逐项走查（软件侧）。
4. UI-SCROLL-001 动态滚动证据：设置正文仍沿用既有 `scrollbar` 机制，本次未新增滚动区域，未单独取证。

## 6. 未决项与风险

- 旧 `model/effort/minDifficulty/types` 字段读取时按新结构落盘一次（`migrated`），旧语义不静默转换为路由槽，避免改变派发行为。
- 任务类型识别由后端关键词匹配（`detect_task_types`），命中率有限；UI 文案不承诺「一定命中」。
- 删除槽位时若该槽独占某任务类型，该类型将回落到兜底；当前不做二次确认（保持操作轻快），已在设计中登记。
- `BRAND_ASSET_VERSION` 同类机制：正式软件 `CliLogo` 走 `/ui/brand-icons/*.svg`，Grok 资源已改 viewBox，若浏览器缓存旧资源需强刷；后续再改该 SVG 需处理缓存失效。
