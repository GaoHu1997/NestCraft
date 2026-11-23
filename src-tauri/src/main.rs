// Prevents additional console window on Windows in release, do not remove!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // CR-059：内置 AI 工具集以 MCP stdio 服务器模式启动（不启动 GUI）。
    // 由派发层把本应用自身作为 `workbench` MCP 服务器交给 CLI 子进程；
    // stdin EOF 正常退出，启动失败以非零码退出并把原因写到 stderr。
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--app-mcp-stdio") {
        match agent_workbench_lib::commands::ai_tools::run_stdio_server(&args) {
            Ok(()) => return,
            Err(error) => {
                eprintln!("ai-tools stdio server failed: {error}");
                std::process::exit(1);
            }
        }
    }
    agent_workbench_lib::run()
}
