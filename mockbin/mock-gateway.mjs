// 本地 mock 供应商网关：实现 Anthropic /v1/messages 与 OpenAI /v1/chat/completions，
// 并校验调用方送来的 key。用于验证「设置中的供应商是否真的注入到 CLI 子进程」。
// 用法：node mockbin/mock-gateway.mjs [port]
// 环境：MOCK_EXPECT_KEY 指定的 key 必须出现在请求头中，否则返回 401（可据此判断注入是否生效）。
import http from "node:http";

const port = Number(process.argv[2] ?? 18080);
const expectKey = process.env.MOCK_EXPECT_KEY ?? "";
const record = [];

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

function gotKey(req) {
  const auth = req.headers["authorization"] ?? "";
  const xkey = req.headers["x-api-key"] ?? "";
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return xkey || auth;
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "";
  const body = await readBody(req);
  const key = gotKey(req);
  record.push({ at: Date.now(), path: url, keyOk: !expectKey || key === expectKey, model: (() => { try { return JSON.parse(body).model; } catch { return null; } })() });

  // 供测试查询注入证据（免鉴权；记录在鉴权判断前已写入，401 请求同样留痕）
  if (url === "/__record") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ calls: record }));
    return;
  }

  if (expectKey && key !== expectKey) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "authentication_error", message: "invalid api key (mock gateway)" } }));
    return;
  }

  // 真实 claude CLI 请求带 query 串（/v1/messages?beta=true），须先剥掉再匹配。
  const route = url.split("?")[0];
  if (route.endsWith("/v1/messages")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: (() => { try { return JSON.parse(body).model; } catch { return "mock"; } })(),
        content: [{ type: "text", text: "MOCK-GATEWAY-OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 5 },
      })
    );
    return;
  }

  if (route.endsWith("/v1/chat/completions")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: (() => { try { return JSON.parse(body).model; } catch { return "mock"; } })(),
        choices: [{ index: 0, message: { role: "assistant", content: "MOCK-GATEWAY-OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      })
    );
    return;
  }

  if (route.endsWith("/responses")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_mock", object: "response", model: (()=>{try{return JSON.parse(body).model}catch{return "mock"}})(), output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "MOCK-GATEWAY-OK" }] }], usage: { input_tokens: 12, output_tokens: 5 } }));
    return;
  }

  if (route.endsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-model-anthropic" }, { id: "mock-model-openai" }] }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock gateway on http://127.0.0.1:${port} expectKey=${expectKey ? "set" : "none"}`);
});
