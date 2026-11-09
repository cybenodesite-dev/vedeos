#!/usr/bin/env bash
# اختبار MCP عبر curl — initialize → initialized → tools/list → tools/call
set -e
BASE="http://localhost:3000/mcp"
ACCEPT='application/json, text/event-stream'
SESSION_FILE="${SESSION_FILE:-/tmp/mcp_session.txt}"

get_sid() {
  if [ -f "$SESSION_FILE" ] && [ -s "$SESSION_FILE" ]; then cat "$SESSION_FILE"; fi
}

init() {
  echo "== initialize =="
  local headers
  headers=$(mktemp)
  curl -s -D "$headers" -X POST "$BASE" \
    -H 'Content-Type: application/json' -H "Accept: $ACCEPT" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}' \
    | rg '^data: ' | head -1 | cut -c7- | head -c 300
  echo
  local sid
  sid=$(rg -i '^mcp-session-id:' "$headers" | tr -d '\r' | awk '{print $2}')
  echo "$sid" > "$SESSION_FILE"
  echo "== initialized notification (sid=$sid) =="
  curl -s -X POST "$BASE" -H 'Content-Type: application/json' -H "Accept: $ACCEPT" -H "mcp-session-id: $sid" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null
  echo "ok"
}

call() {
  local body="$1"
  local sid
  sid=$(get_sid)
  curl -s -X POST "$BASE" -H 'Content-Type: application/json' -H "Accept: $ACCEPT" -H "mcp-session-id: $sid" -d "$body"
}

extract() {
  rg '^data: ' | head -1 | cut -c7- | python3 -m json.tool --no-ensure-ascii 2>/dev/null || rg '^data: ' | head -1 | cut -c7-
}

case "${1:-}" in
  init) init ;;
  tools) call '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | extract ;;
  calltool)
    call "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}" | extract
    ;;
  raw) call "$2" | extract ;;
  *) echo "usage: $0 init|tools|calltool <name> <args>|raw <json>" ;;
esac
