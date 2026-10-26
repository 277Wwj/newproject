#!/usr/bin/env bash
set -euo pipefail

server_binary="${1:?usage: http_contract.sh /path/to/nexus-server}"
port="${NEXUS_TEST_PORT:-18080}"
work_dir="$(mktemp -d)"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

"$server_binary" 127.0.0.1 "$port" >"$work_dir/server.log" 2>&1 &
server_pid=$!

for attempt in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:${port}/api/health" >"$work_dir/health.json"; then
    break
  fi
  sleep 0.1
done

grep -q '"status":"ok"' "$work_dir/health.json"

assert_status() {
  local expected="$1"
  shift
  local response_file="$work_dir/response.json"
  local actual
  actual="$(curl -sS -o "$response_file" -w '%{http_code}' "$@")"
  if [[ "$actual" != "$expected" ]]; then
    echo "expected HTTP $expected, got HTTP $actual" >&2
    cat "$response_file" >&2 || true
    return 1
  fi
}

# Regression check: the public HTTP API rejects whitespace-only prompts.
assert_status 400 \
  -X POST "http://127.0.0.1:${port}/api/tasks" \
  -H 'Content-Type: application/json' \
  --data '{"prompt":"   "}'

valid_response="$work_dir/valid-task.json"
valid_status="$(curl -sS -o "$valid_response" -w '%{http_code}' \
  -X POST "http://127.0.0.1:${port}/api/tasks" \
  -H 'Content-Type: application/json' \
  --data '{"prompt":"exercise the lifecycle"}')"
[[ "$valid_status" == "201" ]]
task_id="$(sed -n 's/.*"task_id":"\([^"]*\)".*/\1/p' "$valid_response")"
[[ -n "$task_id" ]]

curl -sS --no-buffer --max-time 5 \
  "http://127.0.0.1:${port}/api/tasks/${task_id}/events" >"$work_dir/events.txt"
grep -q '"status":"queued"' "$work_dir/events.txt"
grep -q '"status":"running"' "$work_dir/events.txt"
grep -q 'event: done' "$work_dir/events.txt"

assert_status 404 "http://127.0.0.1:${port}/api/tasks/task-does-not-exist"
echo "http contract checks passed after the whitespace regression check"
