//! 命令模块汇总与注册。

pub mod ai_tools;
pub mod capabilities;
pub mod dispatch;
pub mod examples_seed;
pub mod execution;
pub mod chat;
pub mod chat_binding;
pub mod fs;
pub mod general;
pub mod gitcmd;
pub mod gitconfig;
pub mod kb_index;
pub mod knowledge;
pub mod model_probe;
pub mod platform_agent;
pub(crate) mod platform_context;
pub mod projects;
pub(crate) mod model_route;
pub mod image_gen;
pub mod providers;
// CR-059：内置思考等级知识库（由 scripts/gen-think-kb.mjs 生成）
pub mod think_kb;
pub mod sdk;
pub mod servers;
pub mod shell;
pub mod smoke;
pub mod smoke_seed;
pub mod sync;
pub mod updater;
pub mod window;
