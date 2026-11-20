// IPC 冒烟 mock CLI（编译为 claude.exe / codex.exe / grok.exe）。
// 按 CLI 名输出对应协议 JSONL；--version 返回 mock 版本；读完 stdin（EOF 后继续）。
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

    static void Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        foreach (var a in args)
        {
            if (a == "--version")
            {
                Console.Out.WriteLine("9.9.9-mock");
                return;
            }
        }
        // 读完 stdin 直到 EOF（模拟从管道接收提示词）
        try
        {
            var stdin = Console.OpenStandardInput();
            var buf = new byte[4096];
            while (stdin.Read(buf, 0, buf.Length) > 0) { }
        }
        catch { }

        var name = Name();
        var stdOut = Console.Out;
        Action Flush = () => { try { stdOut.Flush(); } catch { } };
        if (name == "claude")
        {
            stdOut.WriteLine("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"mock-claude-session\"}");
            stdOut.WriteLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"你好\"}}}");
            stdOut.WriteLine("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"你好\"},{\"type\":\"text\",\"text\":\"，来自 mock claude。\"},{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"fs.read\",\"input\":{\"path\":\"a.txt\"}}],\"usage\":{\"input_tokens\":11,\"output_tokens\":7,\"cache_read_input_tokens\":3}},\"session_id\":\"mock-claude-session\"}");
            stdOut.WriteLine("{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tool-1\",\"content\":\"a.txt 的内容\"}]}}");
            stdOut.WriteLine("{\"type\":\"result\",\"result\":\"你好，来自 mock claude。\",\"usage\":{\"input_tokens\":11,\"output_tokens\":7,\"cache_read_input_tokens\":3},\"session_id\":\"mock-claude-session\"}");
        }
        else if (name == "codex")
        {
            stdOut.WriteLine("{\"type\":\"thread.started\",\"thread_id\":\"mock-codex-thread\"}");
            stdOut.WriteLine("{\"type\":\"turn.started\"}");
            stdOut.WriteLine("{\"type\":\"item.completed\",\"item\":{\"type\":\"reasoning\",\"text\":\"思考摘要内容\"}}");
            stdOut.WriteLine("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"codex mock 回复\"}}");
            stdOut.WriteLine("{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":4}}");
        }
        else
        {
            stdOut.WriteLine("{\"text\":\"grok 通用回退回复\"}");
        }
    }
}
