# htmlescape 0.3.1：精确许可材料核验（分发审核未完成）

- FEAT-008／CR-055／R-LIC-01；2026-11-22；仅新修复树资料，不改旧封存，不发布。
- 已对本机原始 `.crate` 计算 SHA256，与 Cargo.lock 的 `e9025058dae765dee5070ec375f591e2ba14638c63feff74f13805a72e523163` 完全相符；未运行包内代码。完整归档文件清单、原始 Cargo.toml／README 和 Rust 文件头／SHA 见 CRATE-LICENSE-AUDIT.json。
- 该精确归档实际不含名称为 LICENSE／NOTICE／COPYING 的文件；这是此归档清单事实，不等于上游完整固定源码没有 NOTICE／版权义务。不能编造“没有 NOTICE”。
- 原始 manifest 保持 `license = "Apache-2.0 / MIT / MPL-2.0"`。这是历史 Cargo 多许可 slash 写法，不是现代严格 SPDX 表达式；通常作为多许可备选理解，可对应候选 `Apache-2.0 OR MIT OR MPL-2.0`，但本轮没有取得固定原始许可文件／明确授权文本，不能仅凭字段作法律结论或宣称已选择 MIT 无义务。
- 已有 LICENSE-APACHE-2.0 是此前保存的标准 Apache 2.0 条款，不冒充作者随包原始许可或 NOTICE。原始 manifest 与作者归属不删。若分发采用 Apache，须核验适用的版权／NOTICE 并保留；采用其它路径的义务亦须经分发审查明确，不能凭缺文件默认免除。
- 公开固定源获取实际受限：GitHub CLI 可执行权限拒绝；WebFetch 域验证失败；API 403 rate limit；git ls-remote 连接 reset；版本 raw URL 结果见审计 JSON。没有绕过身份／访问控制，也没有固定 commit 身份证据。
- 实际状态：精确归档／manifest／文件头事实已保存；原始 LICENSE／上游 NOTICE 核验阻塞；distributionReviewPassed=false。由 main／分发审核者确定补充来源和许可路径，本 writer 不给法务自评通过。
