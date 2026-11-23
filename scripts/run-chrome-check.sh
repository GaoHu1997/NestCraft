#!/usr/bin/env bash
# 启动 headless Chrome 并执行给定验证脚本；等待调试端口就绪后再运行。
# 用法：bash scripts/run-chrome-check.sh <script.mjs> [port]
set -u
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
SCRIPT="${1:?需要验证脚本路径}"
PORT="${2:-9334}"
PROFILE="/tmp/cr-check-$$-$(date +%s)"

taskkill //F //IM chrome.exe >/dev/null 2>&1 || true
sleep 2
nohup "$CHROME" --headless=new --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" about:blank >/dev/null 2>&1 &

for _ in $(seq 1 30); do
  sleep 1
  if curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then break; fi
done
if ! curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "chrome 调试端口 $PORT 未就绪"; exit 1
fi

node "$SCRIPT"
exit $?
