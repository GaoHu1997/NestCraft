// mock MCP stdio 服务器：响应 initialize / tools/list，验证最小 JSON-RPC 客户端链路。
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-mcp", version: "0.0.1" },
        },
      }) + "\n"
    );
  } else if (msg.method === "notifications/initialized") {
    // 通知，无响应
  } else if (msg.method === "tools/list") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            { name: "mock.echo", description: "回显输入", inputSchema: { type: "object" } },
            { name: "mock.ping", description: "存活检查", inputSchema: { type: "object" } },
          ],
        },
      }) + "\n"
    );
  }
});
