#!/usr/bin/env bash
# Behavior tests for the antigravity (agy) hard-cancel helper
# (bin/fm-agy-hard-cancel.sh). Uses a REAL small process tree (a script
# literally named "agy" so `ps -o comm=` reports it exactly like the real
# binary does) plus a fake `tmux` that only answers the one
# `display-message -p '#{pane_pid}'` call the script makes, so the actual
# process-tree walk, kill, and verification logic run for real rather than
# being mocked away.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CANCEL="$ROOT/bin/fm-agy-hard-cancel.sh"
TMP_ROOT=$(fm_test_tmproot fm-agy-hard-cancel)
BASE_PATH=${FM_TEST_BASE_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}
LIVE_ROOT_PID=

cleanup_agy_hard_cancel() {
  if [ -n "$LIVE_ROOT_PID" ] && kill -0 "$LIVE_ROOT_PID" 2>/dev/null; then
    kill -KILL "$LIVE_ROOT_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup_agy_hard_cancel EXIT

# make_live_tree: starts a REAL 3-level process tree - a plain "sh root.sh"
# shell, its real child executable literally named "agy" (so comm=agy,
# matching the real installed binary), and agy's own real child "sleep 100".
# Sets the globals TREE_ROOT_PID / TREE_AGY_PID / TREE_SLEEP_PID rather than
# printing and being captured via $(...): a background job started inside a
# command-substitution subshell was live-observed to not reliably survive
# that subshell returning, which looked like the spawned sleep dying before
# the test ever reached it. Called as a plain statement (not $(...)) so its
# background jobs stay in the real test process, which is what the trap
# below cleans up.
make_live_tree() {
  local dir=$1 agy_bin root_sh deadline
  agy_bin="$dir/agy"
  cat > "$agy_bin" <<'SH'
#!/bin/sh
# Deliberately does NOT `wait` on its own spawned child, and deliberately
# loops instead of tail-calling a single final command: the real agy TUI
# stays alive regardless of a background tool subprocess's fate, and some
# `sh` implementations exec-replace a script's own process image for a
# single trailing simple command (which would silently turn this fixture's
# "agy" process into a plain "sleep" process, breaking the comm=agy
# assumption the test relies on). A `while` loop is never exec-optimized.
sleep 100 &
while true; do sleep 1; done
SH
  chmod +x "$agy_bin"
  root_sh="$dir/root.sh"
  cat > "$root_sh" <<SH
#!/bin/sh
"$agy_bin" &
wait
SH
  chmod +x "$root_sh"

  sh "$root_sh" &
  TREE_ROOT_PID=$!
  disown "$TREE_ROOT_PID" 2>/dev/null || true
  LIVE_ROOT_PID=$TREE_ROOT_PID

  deadline=$((SECONDS + 5))
  TREE_AGY_PID=
  while [ "$SECONDS" -lt "$deadline" ]; do
    TREE_AGY_PID=$(ps -eo pid=,ppid=,comm= | awk -v p="$TREE_ROOT_PID" '$2==p && $3=="agy"{print $1}')
    [ -n "$TREE_AGY_PID" ] && break
    sleep 0.1
  done
  [ -n "$TREE_AGY_PID" ] || fail "test setup: real agy child never appeared under root pid $TREE_ROOT_PID"

  # Matches specifically "sleep 100": the fixture's own idle loop ("while
  # true; do sleep 1; done") also parents transient sleep children with the
  # same comm, so a comm-only match is ambiguous and intermittently grabbed
  # one of those instead of the long-lived target.
  deadline=$((SECONDS + 5))
  TREE_SLEEP_PID=
  while [ "$SECONDS" -lt "$deadline" ]; do
    TREE_SLEEP_PID=$(ps -eo pid=,ppid=,args= | awk -v p="$TREE_AGY_PID" '$2==p && $3=="sleep" && $4=="100"{print $1}')
    [ -n "$TREE_SLEEP_PID" ] && break
    sleep 0.1
  done
  [ -n "$TREE_SLEEP_PID" ] || fail "test setup: real sleep child never appeared under agy pid $TREE_AGY_PID"
}

make_fake_tmux_pane_pid() {
  local dir=$1 root_pid=$2 fakebin
  fakebin=$(fm_fakebin "$dir")
  cat > "$fakebin/tmux" <<SH
#!/usr/bin/env bash
case "\$*" in
  *'#{pane_pid}'*) printf '%s\n' "$root_pid" ;;
esac
exit 0
SH
  chmod +x "$fakebin/tmux"
  printf '%s\n' "$fakebin"
}

make_task_meta() {
  local home=$1 id=$2 backend=$3
  mkdir -p "$home/state"
  printf 'window=fake:0\nharness=antigravity\nbackend=%s\n' "$backend" > "$home/state/$id.meta"
}

test_agy_hard_cancel_kills_subprocess_but_spares_agy() {
  local dir home id root_pid agy_pid sleep_pid fakebin out rc
  id="agy-cancel-live-$$"
  dir="$TMP_ROOT/kill-$id"
  home="$dir/home"
  mkdir -p "$dir" "$home"
  make_live_tree "$dir"
  root_pid=$TREE_ROOT_PID
  agy_pid=$TREE_AGY_PID
  sleep_pid=$TREE_SLEEP_PID
  make_task_meta "$home" "$id" tmux
  fakebin=$(make_fake_tmux_pane_pid "$dir/fake" "$root_pid")

  kill -0 "$sleep_pid" 2>/dev/null || fail "test setup: sleep pid $sleep_pid is not alive before cancel"
  kill -0 "$agy_pid" 2>/dev/null || fail "test setup: agy pid $agy_pid is not alive before cancel"

  out=$(FM_HOME="$home" PATH="$fakebin:$BASE_PATH" "$CANCEL" "$id" 2>&1)
  rc=$?
  expect_code 0 "$rc" "hard-cancel should succeed against a real killable tree"
  assert_contains "$out" "agy pid $agy_pid left running" "hard-cancel output did not name the spared agy pid"

  if kill -0 "$sleep_pid" 2>/dev/null; then
    fail "hard-cancel left the background sleep subprocess alive"
  fi
  kill -0 "$agy_pid" 2>/dev/null || fail "hard-cancel killed the agy process itself, not just its subprocess"
  pass "fm-agy-hard-cancel: kills a real background subprocess while sparing the real agy process"
}

test_agy_hard_cancel_refuses_non_antigravity_task() {
  local id home dir out rc
  id="agy-cancel-wrong-harness-$$"
  dir="$TMP_ROOT/wrong-harness-$id"
  home="$dir/home"
  mkdir -p "$home/state"
  printf 'window=fake:0\nharness=kimi\nbackend=tmux\n' > "$home/state/$id.meta"
  rc=0
  out=$(FM_HOME="$home" PATH="$BASE_PATH" "$CANCEL" "$id" 2>&1) || rc=$?
  [ "$rc" -ne 0 ] || fail "hard-cancel should refuse a non-antigravity task"
  assert_contains "$out" "not antigravity" "wrong-harness refusal lacked the expected diagnostic"
  pass "fm-agy-hard-cancel: refuses a task not recorded as harness=antigravity"
}

test_agy_hard_cancel_refuses_non_tmux_backend() {
  local id home dir out rc
  id="agy-cancel-herdr-$$"
  dir="$TMP_ROOT/herdr-$id"
  home="$dir/home"
  make_task_meta "$home" "$id" herdr
  rc=0
  out=$(FM_HOME="$home" PATH="$BASE_PATH" "$CANCEL" "$id" 2>&1) || rc=$?
  [ "$rc" -ne 0 ] || fail "hard-cancel should refuse an unsupported backend rather than guess"
  assert_contains "$out" "only supports the tmux backend" "non-tmux refusal lacked the expected diagnostic"
  pass "fm-agy-hard-cancel: refuses a non-tmux backend instead of guessing at an unverified path"
}

test_agy_hard_cancel_refuses_missing_task() {
  local home dir out rc
  dir="$TMP_ROOT/missing-task"
  home="$dir/home"
  mkdir -p "$home/state"
  rc=0
  out=$(FM_HOME="$home" PATH="$BASE_PATH" "$CANCEL" "no-such-task-$$" 2>&1) || rc=$?
  [ "$rc" -ne 0 ] || fail "hard-cancel should refuse a task with no recorded meta"
  assert_contains "$out" "no meta for task" "missing-task refusal lacked the expected diagnostic"
  pass "fm-agy-hard-cancel: refuses a task with no recorded metadata"
}

test_agy_hard_cancel_refuses_non_numeric_pane_pid() {
  local id home dir fakebin out rc
  id="agy-cancel-badpid-$$"
  dir="$TMP_ROOT/badpid-$id"
  home="$dir/home"
  mkdir -p "$home"
  make_task_meta "$home" "$id" tmux
  fakebin=$(fm_fakebin "$dir/fake")
  cat > "$fakebin/tmux" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *'#{pane_pid}'*) printf 'not-a-pid\n' ;;
esac
exit 0
SH
  chmod +x "$fakebin/tmux"
  rc=0
  out=$(FM_HOME="$home" PATH="$fakebin:$BASE_PATH" "$CANCEL" "$id" 2>&1) || rc=$?
  [ "$rc" -ne 0 ] || fail "hard-cancel should refuse a non-numeric pane_pid rather than guess a kill target"
  assert_contains "$out" "numeric pane_pid" "non-numeric pane_pid refusal lacked the expected diagnostic"
  pass "fm-agy-hard-cancel: refuses rather than guesses when pane_pid is not a plain number"
}

test_agy_hard_cancel_kills_subprocess_but_spares_agy
test_agy_hard_cancel_refuses_non_antigravity_task
test_agy_hard_cancel_refuses_non_tmux_backend
test_agy_hard_cancel_refuses_missing_task
test_agy_hard_cancel_refuses_non_numeric_pane_pid
