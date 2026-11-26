//! 命令模块汇总与注册。

pub mod ai_tools;
pub mod capabilities;
pub mod dispatch;
pub mod examples_seed;
pub mod demo_seed;
pub mod execution;
pub mod chat;
pub mod chat_binding;
// CR-099：模拟客户端身份（仅客户端身份头，不触碰凭证）
pub mod client_identity;
pub mod fs;
pub mod general;
pub mod gitcmd;
pub mod gitconfig;
pub mod kb_index;
// CR-097：本机受管 Office 转换组件（检测／首次使用下载／行政解包）
pub mod kb_office;
pub mod knowledge;
// CR-092：个人记忆层（数据访问 / 业务 / 工具与命令）
pub mod memory;
pub mod memory_store;
pub mod memory_tools;
// CR-095：工具分组与按项目类型的默认暴露集
pub mod tool_groups;
pub mod model_probe;
pub mod platform_agent;
pub(crate) mod platform_context;
pub mod projects;
pub(crate) mod model_route;
pub mod image_gen;
pub mod providers;
// CR-078：概览页日程与待办
pub mod schedule;
// CR-078：概览页全平台 token 用量聚合
pub mod usage_stats;
// CR-078：概览页当前位置天气
pub mod weather;
// CR-059：内置思考等级知识库（由 scripts/gen-think-kb.mjs 生成）
pub mod think_kb;
pub mod sdk;
// CR-093：AI 本地与联网搜索工具（fs_grep/fs_glob/web_search/web_fetch）
pub mod search_tools;
pub mod servers;
pub mod shell;
pub mod smoke;
pub mod smoke_seed;
pub mod sync;
pub mod updater;
pub mod window;
