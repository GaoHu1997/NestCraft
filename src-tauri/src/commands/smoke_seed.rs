// 追加到 smoke.rs 的会话样例种子（仅测试数据，不改渲染逻辑）。
/// 冒烟/评审用：向指定会话写入覆盖多种消息形态的样例，用于检查渲染样式。
#[tauri::command]
pub fn smoke_seed_chat_demo(session_id: String) -> Result<serde_json::Value, String> {
    let guard = crate::db::conn()?;
    let conn = guard.as_ref().ok_or("db not initialized")?;
    let now = crate::models::now_ms();
    let mut n: i64 = 0;
    let mut insert = |role: &str, content: &str, meta: Option<serde_json::Value>| -> Result<(), String> {
        conn.execute(
            "INSERT INTO message (id, sessionId, role, content, metaJson, createdAt) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![
                crate::models::new_id("msg"),
                session_id,
                role,
                content,
                meta.map(|m| m.to_string()),
                now + n
            ],
        )
        .map_err(|e| e.to_string())?;
        n += 1;
        Ok(())
    };

    insert("user", "帮我看看这段代码，并显示运行结果图片、关联文件", None)?;
    insert(
        "system",
        "",
        Some(serde_json::json!({
            "kind": "planUpdate",
            "items": [
                { "text": "阅读截断函数", "status": "completed" },
                { "text": "定位字符边界问题", "status": "completed" },
                { "text": "核对修复和构建结果", "status": "in_progress" },
                { "text": "汇总关联文件", "status": "pending" }
            ]
        })),
    )?;

    let assistant_md = concat!(
        "先说结论：这段 Rust 代码有一个 UTF-8 边界问题。\n\n",
        "## 问题代码\n\n",
        "```rust\n",
        "fn truncate(s: &str, n: usize) -> &str {\n",
        "    &s[..n] // 中文会 panic\n",
        "}\n",
        "```\n\n",
        "## 修复\n\n",
        "```rust\n",
        "fn truncate(s: &str, n: usize) -> String {\n",
        "    s.chars().take(n).collect()\n",
        "}\n",
        "```\n\n",
        "相关文件：`src-tauri/src/commands/chat.rs:510`\n\n",
        "行内代码 `chars().take(n)` 可以安全截断。"
    );
    insert(
        "assistant",
        assistant_md,
        Some(serde_json::json!({
            "thinking": "用户给了一个 Rust 截断函数。需要考虑 UTF-8 边界与中文场景。\n检查后发现 chat.rs 第 510 行确实按字节切片，会 panic。",
            "usage": { "inputTokens": 16341, "outputTokens": 220 }
        })),
    )?;

    insert(
        "assistant",
        "运行结果如下：\n\n![构建结果](docs/Test/screenshots/chat-ui/01-home.png)",
        None,
    )?;

    let read_input = serde_json::json!({
        "file_path": "D:\\github\\AI_Delelovelop\\src-tauri\\src\\commands\\chat.rs",
        "offset": 500,
        "limit": 30
    });
    insert(
        "tool_use",
        "Read",
        Some(serde_json::json!({ "toolId": "tool-1", "input": read_input.to_string() })),
    )?;

    let read_result = concat!(
        "500\t                        let trimmed = line.trim();\n",
        "510\t                            eprintln!(\"[chat] line: {}\", &trimmed[..trimmed.len().min(120)]);\n\n",
        "（共 30 行，已省略）"
    );
    insert(
        "tool_result",
        read_result,
        Some(serde_json::json!({ "toolId": "tool-1", "isError": false })),
    )?;

    let bash_input = serde_json::json!({ "command": "cargo test --lib" });
    insert(
        "tool_use",
        "Bash",
        Some(serde_json::json!({ "toolId": "tool-2", "input": bash_input.to_string() })),
    )?;
    insert(
        "tool_result",
        "error: could not compile agent-workbench",
        Some(serde_json::json!({ "toolId": "tool-2", "isError": true })),
    )?;

    conn.execute(
        "UPDATE session SET title=?2, updatedAt=?3 WHERE id=?1",
        rusqlite::params![session_id, "会话样式验证", now],
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "messages": n }))
}
