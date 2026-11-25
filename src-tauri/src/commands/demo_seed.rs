//! CR-083：内置演示样例项目（对齐 workbench-v4 项目管理设计稿）。
//!
//! 用户希望打开项目管理页时能看到与设计稿一致的 4 个演示项目
//! （预约服务 / 运维控制台 / 市场研究资料 / 品牌与官网），含负责人、描述、
//! 标签、图标配色与需求进度。
//!
//! 约束（沿用 CR-057 示例安装精神）：
//! - 幂等：成功后记录 `demo.seed.version`，重复启动跳过。
//! - 不覆盖：同名用户项目已存在时跳过该演示项；已存在同 id 不重复插入。
//! - 不复活：用户删除演示项目后，版本标记仍在，下次启动不重建。
//! - 不伪造运行：不写入 execution_task（运行数保持真实 0，避免与执行账本冲突）。
//! - 不阻塞：失败只记日志。
//!
//! 注意：`scan_requirements` 内部会再次获取 `db::conn()` 全局锁，因此本模块
//! 必须在**释放**数据库锁之后再调用它，否则 std::sync::Mutex 重入会死锁。

use crate::db;
use rusqlite::params;
use std::path::{Path, PathBuf};

const VERSION: &str = "1";
const KEY: &str = "demo.seed.version";

struct DemoProject {
    id: &'static str,
    name: &'static str,
    kind: &'static str,
    slug: &'static str,
    owner: &'static str,
    description: &'static str,
    tags: &'static [&'static str],
    icon: &'static str,
    color: &'static str,
    story_total: usize,
    story_done: usize,
    prefix: &'static str,
    age_days: i64,
}

const DEMOS: &[DemoProject] = &[
    DemoProject {
        id: "proj-demo-booking",
        name: "预约服务",
        kind: "code",
        slug: "booking",
        owner: "林澈",
        description: "社区活动预约：时段容量、幂等下单、取消回补与交付追溯。",
        tags: &["核心", "进行中"],
        icon: "code",
        color: "blue",
        story_total: 11,
        story_done: 3,
        prefix: "DEMO-BOOK",
        age_days: 23,
    },
    DemoProject {
        id: "proj-demo-ops",
        name: "运维控制台",
        kind: "code",
        slug: "ops-console",
        owner: "周野",
        description: "多主机连接、巡检任务与受限命令执行，含高风险审批。",
        tags: &["基础设施"],
        icon: "terminal",
        color: "teal",
        story_total: 4,
        story_done: 2,
        prefix: "DEMO-OPS",
        age_days: 18,
    },
    DemoProject {
        id: "proj-demo-research",
        name: "市场研究资料",
        kind: "work",
        slug: "research",
        owner: "陈雨",
        description: "活动预约场景的竞品调研、访谈纪要与结论沉淀。",
        tags: &["研究"],
        icon: "bookOpen",
        color: "amber",
        story_total: 3,
        story_done: 1,
        prefix: "DEMO-RES",
        age_days: 14,
    },
    DemoProject {
        id: "proj-demo-brand",
        name: "品牌与官网",
        kind: "work",
        slug: "brand",
        owner: "陈雨",
        description: "命名、图形标志、官网信息架构与发布物料。",
        tags: &["品牌"],
        icon: "briefcase",
        color: "violet",
        story_total: 2,
        story_done: 2,
        prefix: "DEMO-BRAND",
        age_days: 11,
    },
];

fn read_setting(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM setting_default WHERE scope='global' AND key=?1",
        [key],
        |row| row.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
    .filter(|value| !value.trim().is_empty())
}

fn write_setting(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO setting_default (scope, key, value, updatedAt) VALUES ('global', ?1, ?2, ?3)
         ON CONFLICT(scope, key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt",
        params![key, value, crate::models::now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 启动钩子：已安装则直接返回；插入完成后在锁外重建需求索引。
pub fn ensure_seeded(_app: &tauri::AppHandle) -> Result<(), String> {
    let base: PathBuf = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        crate::commands::general::resolve_data_dir(conn)?
            .join("demo-projects")
            .join(format!("v{VERSION}"))
    };
    let inserted = {
        let guard = db::conn()?;
        let conn = guard.as_ref().ok_or("db not initialized")?;
        seed_into(&base, conn)?
    };
    // 锁已释放：scan_requirements 会自行加锁，避免重入死锁。
    for (project_id, root) in inserted {
        let _ = crate::commands::projects::scan_requirements(&root, &project_id);
    }
    Ok(())
}

/// 写入演示项目与文档；返回本次新建（或复用且应重建索引）的 (projectId, root)。
fn seed_into(base: &Path, conn: &rusqlite::Connection) -> Result<Vec<(String, PathBuf)>, String> {
    if read_setting(conn, KEY).as_deref() == Some(VERSION) {
        return Ok(Vec::new());
    }
    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let now = crate::models::now_ms();
    let mut inserted: Vec<(String, PathBuf)> = Vec::new();
    for demo in DEMOS {
        // 同名用户项目已存在则跳过该演示项（避免重复名称）。
        let same_name: i64 = conn
            .query_row("SELECT COUNT(*) FROM project WHERE name=?1", [demo.name], |r| r.get(0))
            .unwrap_or(0);
        if same_name > 0 {
            continue;
        }
        let root = base.join(demo.slug);
        write_demo_docs(&root, demo)?;
        let tags_json = serde_json::to_string(demo.tags).unwrap_or_else(|_| "[]".into());
        let created = now - demo.age_days * 86_400_000;
        let changed = conn
            .execute(
                "INSERT OR IGNORE INTO project (id, name, type, rootUri, createdAt, updatedAt, icon, iconColor, owner, description, tagsJson)
                 VALUES (?1,?2,?3,?4,?5,?5,?6,?7,?8,?9,?10)",
                params![
                    demo.id,
                    demo.name,
                    demo.kind,
                    root.to_string_lossy(),
                    created,
                    demo.icon,
                    demo.color,
                    demo.owner,
                    demo.description,
                    tags_json
                ],
            )
            .map_err(|e| e.to_string())?;
        if changed > 0 {
            inserted.push((demo.id.to_string(), root));
        }
    }
    write_setting(conn, KEY, VERSION)?;
    Ok(inserted)
}

fn write_demo_docs(root: &Path, demo: &DemoProject) -> Result<(), String> {
    let plan = root.join("docs").join("Plan");
    std::fs::create_dir_all(plan.join("Epic")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(plan.join("Story")).map_err(|e| e.to_string())?;
    let epic_id = format!("{}-EPIC-01", demo.prefix);
    write_doc(
        &plan.join("Epic").join(format!("{epic_id}-{}.md", slug(&demo.name))),
        &format!(
            "---\nid: {epic_id}\ntype: epic\ntitle: {}示例史诗\nstatus: in-progress\nowner: {}\n---\n\n# {}示例史诗\n",
            demo.name, demo.owner, demo.name
        ),
    )?;
    for i in 1..=demo.story_total {
        let status = if i <= demo.story_done {
            "completed"
        } else if i % 3 == 0 {
            "ready"
        } else {
            "in-progress"
        };
        let sid = format!("{}-STORY-{:02}", demo.prefix, i);
        write_doc(
            &plan.join("Story").join(format!("{sid}.md")),
            &format!(
                "---\nid: {sid}\ntype: story\nparent: {epic_id}\ntitle: {}示例需求 {i}\nstatus: {status}\nowner: {}\n---\n\n# {}示例需求 {i}\n\n演示夹具，用于展示项目管理卡片的需求进度。\n",
                demo.name, demo.owner, demo.name
            ),
        )?;
    }
    Ok(())
}

fn write_doc(path: &PathBuf, content: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    std::fs::write(path, content).map_err(|e| e.to_string())
}

/// 仅用于文件名：保留中文，替换路径分隔与空白。
fn slug(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_whitespace() || c == '/' || c == '\\' { '-' } else { c })
        .collect()
}
