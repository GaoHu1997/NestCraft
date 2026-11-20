# STORY-033：Git管理正式实现

- 类型：用户故事（正式实现）
- 所属 Feature：[FEAT-007 文件草稿与分支上下文](../Feature/FEAT-007-文件草稿与分支上下文.md)
- 来源与确认依据：CR-006 + CR-015；逻辑对照 Git 面板参考（REF-002-4）
- 关联：CR-006；验证见 REPORT-008。
- 状态：开发完成，技术验证通过，待用户验收
- 目标：作为使用者，我希望在编码左栏查看未提交/分支/历史三段 Git 信息并完成暂存提交与分支切换。
- 本次包含：porcelain 状态解析、暂存/取消/放弃、diff 染色预览、提交、分支列表/切换/新建/校验、历史分页与提交文件、fetch/pull(ff-only)/push；AI 输入区分支 chip 数据源。
- 不包含：force/reset/clean/worktree 管理、凭据导入。
- 验收标准：
  - AC-STORY-033-01：三段布局与操作可用，失败 toast 显示 git stderr。
  - AC-STORY-033-02：无仓库/detached 分别显示引导与横幅，不伪造分支。
  - AC-STORY-033-03：分支名校验（空/非法字符/.lock 等）阻止提交。
- 方案：LLD-FEAT-002 §3.6；实现位置 src-tauri/src/commands/gitcmd.rs、src/modules/git
- 验证结果：编译通过；真实仓库操作待冒烟。
- 验收结论及依据：待验收
