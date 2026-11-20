// 从已选定的帆船 PNG 派生应用图标，不重绘图形或覆盖设计资源。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("./generate-brand-icons.py", import.meta.url));
const source = fileURLToPath(new URL("../docs/UI/brand-assets-v2/logo-sail.png", import.meta.url));
const favicon = fileURLToPath(new URL("../docs/UI/brand-assets-v2/favicon.png", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync("python", ["-I", script, source, favicon, root], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
