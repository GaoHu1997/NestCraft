/** CR-087 验证辅助：以本地静态服务器托管 `npm run build` 产物（src-tauri/dist）。
 * 用途：vite dev server 在本机出现依赖优化卡死（IPv4 拒绝、IPv6 挂起）时，改用构建产物取证。
 * 用法：node scripts/cr087-serve-dist.mjs   （默认 http://127.0.0.1:8127/）
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, normalize } from "node:path";

const ROOT = resolve("src-tauri/dist");
const PORT = Number(process.env.CR087_PORT || 8127);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    // 只允许 ROOT 内的文件，杜绝路径穿越
    const target = normalize(join(ROOT, pathname));
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let file = target;
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, "index.html");
    } catch {
      // SPA 回退：未知路径交给 index.html
      file = join(ROOT, "index.html");
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[file.slice(file.lastIndexOf(".")).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e && e.message || e));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`serving ${ROOT} at http://127.0.0.1:${PORT}/`);
});
