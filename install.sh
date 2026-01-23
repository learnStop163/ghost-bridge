#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${MCP_NAME:-ghost-bridge}"
NODE_BIN="${NODE_BIN:-node}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "[ghost-bridge] 未找到 node，请先安装 Node.js"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[ghost-bridge] 未找到 npm，请先安装 Node.js"
  exit 1
fi

if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  echo "[ghost-bridge] 未找到 claude CLI，请先安装 Claude CLI"
  exit 1
fi

echo "[ghost-bridge] root: $ROOT_DIR"
echo "[ghost-bridge] installing dependencies..."
cd "$ROOT_DIR"
npm install

SERVER_PATH="$ROOT_DIR/server.js"
echo "[ghost-bridge] registering MCP: $NAME"

if "$CLAUDE_BIN" mcp list 2>/dev/null | grep -q "$NAME"; then
  "$CLAUDE_BIN" mcp update "$NAME" -- "$NODE_BIN" "$SERVER_PATH"
else
  "$CLAUDE_BIN" mcp add "$NAME" -- "$NODE_BIN" "$SERVER_PATH"
fi

echo "[ghost-bridge] done."
echo "Next:"
echo "1) chrome://extensions -> load unpacked -> $ROOT_DIR/extension"
echo "2) click the extension icon to ON"
echo "3) run: claude"
