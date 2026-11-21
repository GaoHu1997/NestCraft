// IPC 冒烟 mock CLI（编译为 claude.exe / codex.exe / grok.exe）。
// 按 CLI 名输出对应协议 JSONL；--version 返回 mock 版本；读完 stdin（EOF 后继续）。
// CR-037：解析 --resume <id>（claude）/ resume <id>（codex），场景由环境变量 MOCK_RESUME 控制：
//   confirm（默认）= 回显同 id（模拟恢复确认）；silent-new = 忽略 resume 返回新 id（静默换线）；
//   stale = 打印原生报错并 exit 1；refuse = exit 0 但 result.is_error=true / 无 thread.started。
// 仅测试工具，不参与生产逻辑。
using System;
using System.IO;
using System.Text;

class MockCli
{
    static string Name()
    {
#if MOCK_CLAUDE
        return "claude";
#elif MOCK_CODEX
        return "codex";
#else
        return "grok";
#endif
    }

    static string ResumeArg(string[] args, string flag)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == flag) return args[i + 1];
        }
        return null;
    }

    static string CodexResumeArg(string[] args)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "resume" && args[i + 1] != "--json" && !args[i + 1].StartsWith("-")) return args[i + 1];
        }
        return null;
    }

    static int Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        foreach (var a in args)
        {
            if (a == "--version")
            {
                Console.Out.WriteLine("9.9.9-mock");
                return 0;
            }
        }
        var mode = (Environment.GetEnvironmentVariable("MOCK_RESUME") ?? "confirm").Trim().ToLowerInvariant();
        var name = Name();
        var stdOut = Console.Out;
        var stdErr = Console.Error;
        if (name == "grok")
        {
            // grok：单轮通道，无 resume 概念（CR-037 登记 UNSUPPORTED_CLI）。
            try
            {
                var stdin = Console.OpenStandardInput();
                var buf = new byte[4096];
                while (stdin.Read(buf, 0, buf.Length) > 0) { }
            }
            catch { }
            stdOut.WriteLine("{\"text\":\"grok 通用回退回复\"}");
            return 0;
        }
        string resumeRef = name == "claude" ? ResumeArg(args, "--resume") : CodexResumeArg(args);
        if (mode == "stale" && resumeRef != null)
        {
            // 模拟引用不存在：原生报错 + 非零退出（后端识别为 REF_STALE / REF_NOT_READY）
            if (name == "claude") stdErr.WriteLine("No conversation found with session ID: " + resumeRef);
            else stdErr.WriteLine("ERROR: no rollout found for thread id " + resumeRef);
            return 1;
        }
        // 读完 stdin 直到 EOF（模拟从管道接收提示词）
        try
        {
            var stdin = Console.OpenStandardInput();
            var buf = new byte[4096];
            while (stdin.Read(buf, 0, buf.Length) > 0) { }
        }
        catch { }
        if (name == "claude")
        {
            // 确认信号：流内 session_id 与请求 id 一致（confirm）；silent-new 返回新 id。
            var sid = resumeRef;
            if (sid == null) sid = "mock-claude-session";
            else if (mode == "silent-new") sid = "mock-claude-new-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            stdOut.WriteLine("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"" + sid + "\"}");
            stdOut.WriteLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"你好\"}}}");
            stdOut.WriteLine("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"你好\"},{\"type\":\"text\",\"text\":\"，来自 mock claude。\"},{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"fs.read\",\"input\":{\"path\":\"a.txt\"}}],\"usage\":{\"input_tokens\":11,\"output_tokens\":7,\"cache_read_input_tokens\":3}},\"session_id\":\"" + sid + "\"}");
            stdOut.WriteLine("{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tool-1\",\"content\":\"a.txt 的内容\"}]}}");
            if (mode == "refuse" && resumeRef != null)
            {
                stdOut.WriteLine("{\"type\":\"result\",\"result\":\"resume refused by mock\",\"usage\":{\"input_tokens\":11,\"output_tokens\":7,\"cache_read_input_tokens\":3},\"is_error\":true,\"session_id\":\"" + sid + "\"}");
                return 0;
            }
            stdOut.WriteLine("{\"type\":\"result\",\"result\":\"你好，来自 mock claude。\",\"usage\":{\"input_tokens\":11,\"output_tokens\":7,\"cache_read_input_tokens\":3},\"is_error\":false,\"session_id\":\"" + sid + "\"}");
            return 0;
        }
        // codex
        var threadId = resumeRef;
        if (threadId == null) threadId = "mock-codex-thread";
        else if (mode == "silent-new") threadId = "mock-codex-new-" + Guid.NewGuid().ToString("N").Substring(0, 8);
        if (mode == "refuse" && resumeRef != null)
        {
            // exit 0 但无 thread.started 且带 error 事件：emitted != requested → 不得记 resumed
            stdOut.WriteLine("{\"type\":\"error\",\"message\":\"resume refused by mock\"}");
            stdOut.WriteLine("{\"type\":\"turn.failed\"}");
            return 0;
        }
        stdOut.WriteLine("{\"type\":\"thread.started\",\"thread_id\":\"" + threadId + "\"}");
        stdOut.WriteLine("{\"type\":\"turn.started\"}");
        stdOut.WriteLine("{\"type\":\"item.completed\",\"item\":{\"type\":\"reasoning\",\"text\":\"思考摘要内容\"}}");
        stdOut.WriteLine("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"codex mock 回复\"}}");
        stdOut.WriteLine("{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":4}}");
        return 0;
    }
}
