#!/usr/bin/env bash
# tests/fm-cancel.test.sh - tests for bin/fm-cancel.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() { printf 'not ok - %s\n' "$1" >&2; cleanup_all; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

SCRATCH=""
cleanup_all() {
  [ -n "$SCRATCH" ] && rm -rf "$SCRATCH"
}
trap cleanup_all EXIT

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/fm-cancel-test.XXXXXX")
SCRATCH=$(cd "$SCRATCH" && pwd)
HOME_DIR="$SCRATCH/home"
STATE_DIR="$HOME_DIR/state"
mkdir -p "$STATE_DIR"

export FM_HOME="$HOME_DIR"
export FM_STATE_OVERRIDE="$STATE_DIR"

# 1. Missing argument exits 1
out=$("$ROOT/bin/fm-cancel.sh" 2>&1 || true)
echo "$out" | grep -q "Usage" || fail "expected usage on empty args"
pass "usage on empty args"

# 2. Non-existent task exits 1
out=$("$ROOT/bin/fm-cancel.sh" nonexistent-task 2>&1 || true)
echo "$out" | grep -q "no meta for task" || fail "expected no meta error"
pass "refusal on non-existent task"

# 3. Remote secondmate is refused
cat << 'META' > "$STATE_DIR/rem-task.meta"
id=rem-task
kind=secondmate
harness=claude
remote_host=remote.example.com
META
touch "$STATE_DIR/rem-task.status"
out=$("$ROOT/bin/fm-cancel.sh" rem-task 2>&1 || true)
echo "$out" | grep -q "runs on remote host" || fail "expected remote refusal"
pass "refusal on remote secondmate task"

# 4. Antigravity task cancellation appends failed status and formats JSON
cat << 'META' > "$STATE_DIR/agy-task.meta"
id=agy-task
kind=scout
harness=antigravity
backend=tmux
endpoint=firstmate:agy-task
window=firstmate:agy-task
META
touch "$STATE_DIR/agy-task.status"
out=$("$ROOT/bin/fm-cancel.sh" agy-task --reason "testing cancel" --json)
echo "$out" | grep -q '"status":"cancelled"' || fail "expected JSON cancelled status"
echo "$out" | grep -q '"harness":"antigravity"' || fail "expected JSON harness antigravity"
grep -q "failed: testing cancel" "$STATE_DIR/agy-task.status" || fail "status file missing cancellation reason"
pass "antigravity cancellation with json and status logging"

# 5. Teardown cannot clear an open captain hold during cancellation.
mkdir -p "$HOME_DIR/data"
printf '%s\n' '# Backlog' '' '## In flight' '' '## Queued' '' '## Done' \
  > "$HOME_DIR/data/backlog.md"
tasks-axi add held-task "captain hold cancellation fixture" --file "$HOME_DIR/data/backlog.md" >/dev/null
tasks-axi hold held-task --kind captain --reason "captain decision pending" \
  --file "$HOME_DIR/data/backlog.md" >/dev/null
cat <<'META' > "$STATE_DIR/held-task.meta"
id=held-task
kind=scout
harness=antigravity
backend=tmux
META
touch "$STATE_DIR/held-task.status"
set +e
out=$("$ROOT/bin/fm-cancel.sh" held-task --teardown 2>&1)
rc=$?
set -e
[ "$rc" -eq 1 ] || fail "open captain hold cancellation should refuse teardown (rc=$rc)"
echo "$out" | grep -q "open hold for the Captain" \
  || fail "open captain hold refusal did not explain the protected decision"
pass "cancellation refuses to clear an open captain hold"

echo "ALL TESTS PASSED"
