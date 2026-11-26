// CR-102 临时验证挂载：真实 MessageList + 真实 CSS，浅/深由 html[data-theme] 控制。
// 仅 npm run dev 下通过 /cr102-harness.html 访问；不被任何入口导入，不进生产构建。
import React from "react";
import { createRoot } from "react-dom/client";
import { MessageList, mkMsg } from "@/modules/chat/MessageList";
import "@/theme/tokens.css";
import "@/theme/base.css";
import "@/modules/chat/chat.css";
import "@/modules/chat/message-zcode.css";
import { installScrollbarReveal } from "@/components/scrollbar";

installScrollbarReveal();

const RAW = "Reconnecting... 1/5 (unexpected status 502 Bad Gateway: Upstream service temporarily unavailable, url: https://api.primerelay.online/v1/responses, request id: 28411477-1c9d-42cd-8d6f-86d449084565)";
const LONGRAW = RAW + `\n\n上游返回原始帧：\n{"error":{"message":"Upstream service temporarily unavailable","type":"upstream_error","code":502,"request_id":"28411477-1c9d-42cd-8d6f-86d449084565","upstream":"responses/v1","retry_hint":"backoff 2s","trace":["edge-1","relay-7","pool-3"],"ts":"2026-11-26T14:20:20.853Z"}\n说明：内核将按退避计划自动进行下一次重试；历史帧保持原位，不打断正文输出。\n（此区域内容超高时自身滚动，滚动条按 UI-SCROLL-001 按需显示。）`;

const msgs = [
  mkMsg({ id: "u1", role: "user", content: "开三个子代理 codex / claude / grok 分别给出 1-10 的随机数，统计给我", createdAt: Date.now() }),
  mkMsg({ id: "a1", role: "assistant", content: "好的，我依次调用三个 CLI 子代理……", streaming: true, createdAt: Date.now() }),
  mkMsg({ id: "r1", role: "system", kind: "retrying", content: "上游暂时不可用（502）", retryAttempt: 1, retryMax: 5, retryDetail: LONGRAW, createdAt: Date.now() }),
  mkMsg({ id: "r2", role: "system", kind: "recovered", content: "上游暂时不可用（502）", retryAttempt: 2, retryMax: 5, retryDetail: LONGRAW, createdAt: Date.now() }),
  mkMsg({ id: "a2", role: "assistant", content: "统计结果如下：codex=7，claude=3，grok=9。", createdAt: Date.now() }),
];

const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
const width = Number(new URLSearchParams(location.search).get("w") ?? 720);

function App() {
  return (
    <div style={{ background: "var(--paper)", color: "var(--ink)", minHeight: "100vh", boxSizing: "border-box" }}>
      <div style={{ width, margin: "0 auto", padding: "18px 16px", border: "1px solid var(--line)", borderRadius: 10, background: "var(--paper)" }}>
        <MessageList msgs={msgs} visible onRetryTurn={() => {}} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
