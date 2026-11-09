#!/usr/bin/env bash
# متابعة مهمة بـ get_task كل ~10 ثوانٍ حتى الاكتمال أو الفشل (كما يفعل عميل MCP)
# الاستخدام: bash scripts/poll-task.sh <task_id> [max_seconds]
set -e
TASK_ID="${1:?task_id مطلوب}"
MAX="${2:-600}"
START=$(date +%s)
N=1
while true; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START))
  if [ "$ELAPSED" -gt "$MAX" ]; then echo "TIMEOUT after ${ELAPSED}s"; exit 2; fi
  OUT=$(bash "$(dirname "$0")/mcp-test.sh" calltool get_task "{\"task_id\":\"$TASK_ID\"}")
  TEXT=$(echo "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['content'][0]['text'][:160].replace(chr(10),' | '))" 2>/dev/null || echo "$OUT" | head -c 160)
  echo "[$N] ${ELAPSED}s → $TEXT"
  if echo "$TEXT" | rg -q "✅"; then echo "COMPLETED"; exit 0; fi
  if echo "$TEXT" | rg -q "❌"; then echo "FAILED"; exit 1; fi
  N=$((N+1))
  sleep 10
done
