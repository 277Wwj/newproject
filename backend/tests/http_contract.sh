#!/usr/bin/env bash
set -euo pipefail

# Count prompt bytes consistently, independent of the host's UTF-8 locale.
export LC_ALL=C

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
  actual="$(curl -sS --max-time 5 -o "$response_file" -w '%{http_code}' "$@")"
  if [[ "$actual" != "$expected" ]]; then
    echo "expected HTTP $expected, got HTTP $actual" >&2
    cat "$response_file" >&2 || true
    return 1
  fi
}

assert_post() {
  local expected="$1"
  local body="$2"
  assert_status "$expected" \
    -X POST "http://127.0.0.1:${port}/api/tasks" \
    -H 'Content-Type: application/json' \
    --data-binary "$body"
  if [[ "$expected" == "400" ]]; then
    grep -q '"error":' "$work_dir/response.json"
  fi
}

# Reject empty/blank prompts, every non-string JSON kind, and malformed JSON.
for body in \
  '{"prompt":""}' \
  '{"prompt":"   "}' \
  '{"prompt":"\t\r\n "}' \
  '{"prompt":null}' \
  '{"prompt":42}' \
  '{"prompt":false}' \
  '{"prompt":{}}' \
  '{"prompt":[]}' \
  '{}' \
  '{"prompt":'; do
  assert_post 400 "$body"
done

# The limit applies to the decoded prompt's UTF-8 bytes, not JSON body length
# or Unicode character count. The Chinese case is 1333 x 3 bytes plus "a".
printf -v ascii_4000 '%*s' 4000 ''
ascii_4000="${ascii_4000// /a}"
printf -v chinese_character '\344\270\255'
chinese_4000=""
for ((index = 0; index < 1333; index++)); do
  chinese_4000+="$chinese_character"
done
chinese_4000+='a'
[[ "${#ascii_4000}" == "4000" && "${#chinese_4000}" == "4000" ]]

for prompt in "$ascii_4000" "$chinese_4000"; do
  assert_post 201 "{\"prompt\":\"${prompt}\"}"
  assert_post 400 "{\"prompt\":\"${prompt}a\"}"
done

assert_count() {
  local expected="$1"
  local pattern="$2"
  local file="$3"
  local actual
  actual="$(grep -c -- "$pattern" "$file" || true)"
  if [[ "$actual" != "$expected" ]]; then
    echo "expected $expected matches of $pattern, got $actual in $file" >&2
    cat "$file" >&2
    return 1
  fi
}

assert_lifecycle_stream() {
  local file="$1"
  local actual
  actual="$(curl -sS --no-buffer --max-time 5 \
    -o "$file" -w '%{http_code}' \
    "http://127.0.0.1:${port}/api/tasks/${task_id}/events")"
  [[ "$actual" == "200" ]]
  assert_count 3 '^data: ' "$file"
  assert_count 3 "^data: .*\"task_id\":\"${task_id}\"" "$file"
  assert_count 1 '^data: .*"status":"queued"' "$file"
  assert_count 1 '^data: .*"status":"running"' "$file"
  assert_count 1 '^data: .*"status":"completed"' "$file"
  assert_count 1 '^event: done$' "$file"
  [[ "$(sed -n 's/^id: //p' "$file")" == $'1\n2\n3' ]]
  [[ "$(sed -n 's/^event: //p' "$file")" == $'status\nstatus\ndone' ]]
}

assert_post 201 '{"prompt":"exercise the lifecycle"}'
task_id="$(sed -n 's/.*"task_id":"\([^"]*\)".*/\1/p' "$work_dir/response.json")"
[[ "$task_id" =~ ^task-[0-9a-f]+$ ]]

assert_status 200 "http://127.0.0.1:${port}/api/tasks/${task_id}"
grep -q "\"task_id\":\"${task_id}\"" "$work_dir/response.json"
grep -q '"prompt":"exercise the lifecycle"' "$work_dir/response.json"
grep -q '"events":\[' "$work_dir/response.json"

# Both the live stream and a late subscriber must see one ordered lifecycle.
# curl must finish normally after the terminal event, before its timeout.
assert_lifecycle_stream "$work_dir/events.txt"
assert_status 200 "http://127.0.0.1:${port}/api/tasks/${task_id}"
grep -q "\"task_id\":\"${task_id}\"" "$work_dir/response.json"
grep -q '"prompt":"exercise the lifecycle"' "$work_dir/response.json"
# The compact task object places its own status after the nested event list.
[[ "$(sed -n 's/.*"status":"\([^"]*\)".*/\1/p' "$work_dir/response.json")" == "completed" ]]
assert_lifecycle_stream "$work_dir/replayed-events.txt"

assert_status 404 "http://127.0.0.1:${port}/api/tasks/task-does-not-exist"
echo "http contract checks passed: validation, UTF-8 limits, task queries, and SSE lifecycle"
