# STORY-027：Tauri骨架与主题

- 类型：用户故事（正式实现）
- 所属 Feature：[FEAT-001 工作台框架与可操作评审](../Feature/FEAT-001-工作台框架与可操作评审.md)
- 来源与确认依据：CR-015（用户 2026-11-19 授权启动 Tauri 正式实现）
- 关联：FEAT-002（主题）；验证见 REPORT-008。
- 状态：开发完成，技术验证通过，待用户验收
- 目标：作为使用者，我希望在 Tauri 桌面应用中获得与 CR-014 仿真一致的白蓝视觉与全局导航，以便正式产品延续已确认的界面基线。
- 本次包含 / 不包含：包含应用壳（左导航+顶栏）、设计令牌（浅/深两套）、路由与模块加载、图标与窗口配置；不包含打包签名发布。
- 验收标准：
  - AC-STORY-027-01：npm run build 与 cargo check 通过，应用可经 tauri dev 启动显示项目主页。
  - AC-STORY-027-02：浅/深主题切换只改外观并持久化（set_theme），令牌与 CR-014 原型同源。
- 方案：LLD-FEAT-002 §1/§4；实现位置 src/App.tsx、src/theme/*、src-tauri/tauri.conf.json
- 验证结果：AC-01 tsc+vite build 通过（见 REPORT-008）；AC-02 令牌文件与主题切换实现完成，运行时验证待 tauri dev 冒烟。
- 验收结论及依据：待验收
