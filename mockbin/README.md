# 冒烟测试 mock 程序

供 `TAURI_SMOKE=1` 应用内自检使用，不参与生产逻辑。

| 文件 | 用途 |
| --- | --- |
| `mock-cli.cs` | C# 源码，编译为 `claude.exe` / `codex.exe` / `grok.exe`，分别输出三种 CLI 的 JSONL 协议；`--version` 返回 `9.9.9-mock` |
| `mock-mcp.mjs` | 最小 MCP stdio 服务器，响应 `initialize` / `tools/list` |
| `claude.cmd` / `codex.cmd` / `grok.cmd` | 调用对应 `.mjs` 的批处理（备用，exe 优先） |
| `mock-gateway.mjs` | 本地供应商网关：实现 Anthropic `/v1/messages` 与 OpenAI `/responses`，可校验调用方密钥，用于验证「设置中的供应商是否真的注入进 CLI」 |

## 重新编译

```bash
CSC="C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
"$CSC" -nologo "-out:mockbin\claude.exe" -define:MOCK_CLAUDE "mockbin\mock-cli.cs"
"$CSC" -nologo "-out:mockbin\codex.exe"  -define:MOCK_CODEX  "mockbin\mock-cli.cs"
"$CSC" -nologo "-out:mockbin\grok.exe"                     "mockbin\mock-cli.cs"
```

编译产物（`*.exe` / `*.cmd`）不入库。

## 验证注入链路

```bash
MOCK_EXPECT_KEY="gw-test-key-123456" node mockbin/mock-gateway.mjs 18080 &
node scripts/verify-dispatch.mjs    # 真实 claude/codex + 本地网关，5 项断言
```
