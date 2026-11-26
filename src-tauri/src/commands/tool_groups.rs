//! CR-095：工具分组与按项目类型的默认暴露集。
//!
//! 目标：平台 system 只列"该类型默认可用"的工具组与工具名，平台每轮 tools 也
//! 只为默认组注入完整 schema，减少无关工具的 token 与注意力噪声。
//! 动态按需加载（enable_tool_group）为后续增量，本模块先提供静态分组与默认集。

pub struct ToolGroup {
    pub id: &'static str,
    pub label: &'static str,
    pub tools: &'static [&'static str],
}

pub const TOOL_GROUPS: &[ToolGroup] = &[
    ToolGroup { id: "core", label: "基础", tools: &["get_context", "read_skill"] },
    ToolGroup {
        id: "knowledge",
        label: "知识库",
        tools: &[
            "knowledge_list", "knowledge_search", "knowledge_read",
            "knowledge_read_many", "knowledge_links", "knowledge_graph",
        ],
    },
    ToolGroup { id: "files", label: "文件", tools: &["fs_read", "fs_grep", "fs_glob"] },
    ToolGroup {
        id: "project",
        label: "项目与需求",
        tools: &[
            "list_projects", "create_project", "update_project", "get_requirements",
            "read_requirement_doc", "write_requirement_doc", "list_kbs", "create_kb",
            "set_kb_grant", "dispatch_work",
        ],
    },
    ToolGroup {
        id: "memory",
        label: "记忆",
        tools: &["memory_search", "memory_save", "memory_list", "memory_forget", "profile_get"],
    },
    ToolGroup { id: "search", label: "联网搜索", tools: &["web_search", "web_fetch"] },
    ToolGroup { id: "server", label: "服务器", tools: &["list_servers", "save_server", "ssh_connect", "ssh_disconnect", "ssh_exec", "ssh_exec_status"] },
    ToolGroup { id: "media", label: "生图", tools: &["generate_image"] },
    ToolGroup { id: "panel", label: "预览面板", tools: &["open_panel"] },
];

/// 项目类型（code/work/未绑定）对应的默认工具组。
pub fn default_group_ids(kind: &str) -> &'static [&'static str] {
    match kind {
        "code" => &["core", "knowledge", "files", "project", "memory", "search", "server"],
        "work" => &["core", "knowledge", "files", "project", "memory", "search", "panel", "media"],
        _ => &["core", "knowledge", "memory", "search"],
    }
}

/// 按默认组过滤后的工具组（用于 system 能力目录）。
pub fn groups_for(kind: &str) -> impl Iterator<Item = &'static ToolGroup> {
    let ids = default_group_ids(kind);
    TOOL_GROUPS.iter().filter(move |g| ids.contains(&g.id))
}

/// 默认组内全部工具名（用于 platform tools 过滤）。
pub fn allowed_tool_names(kind: &str) -> std::collections::HashSet<&'static str> {
    let ids = default_group_ids(kind);
    let mut set = std::collections::HashSet::new();
    for group in TOOL_GROUPS {
        if ids.contains(&group.id) {
            set.extend(group.tools.iter().copied());
        }
    }
    set
}
