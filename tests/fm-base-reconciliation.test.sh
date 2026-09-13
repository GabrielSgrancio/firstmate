#!/usr/bin/env bash
# Regression tests for stale task-base detection at local delivery time.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=bin/fm-base-reconciliation-lib.sh
. "$ROOT/bin/fm-base-reconciliation-lib.sh"
fm_git_identity fmtest fmtest@example.invalid

TMP_ROOT=$(fm_test_tmproot fm-base-reconciliation)

make_repo() {
  local repo=$TMP_ROOT/repo base current branch
  mkdir -p "$repo"
  git init -q -b main "$repo"
  printf 'original\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -qm initial
  base=$(git -C "$repo" rev-parse HEAD)

  for i in $(seq 1 200); do
    printf 'target-only line %03d\n' "$i"
  done > "$repo/target-only.txt"
  git -C "$repo" add target-only.txt
  git -C "$repo" commit -qm 'advance target'
  current=$(git -C "$repo" rev-parse HEAD)

  git -C "$repo" checkout -q -b fm/stale "$base"
  printf 'task change\n' > "$repo/task.txt"
  git -C "$repo" add task.txt
  git -C "$repo" commit -qm 'task change'
  branch=$(git -C "$repo" rev-parse HEAD)
  printf '%s|%s|%s|%s\n' "$repo" "$base" "$current" "$branch"
}

test_stale_base_reports_destructive_diff_anomaly() {
  local record repo base current branch rc
  record=$(make_repo)
  IFS='|' read -r repo base current branch <<EOF
$record
EOF

  rc=0
  fm_base_reconciliation_check "$repo" "fm/stale" "$base" main || rc=$?
  [ "$rc" -eq 1 ] || fail "stale base should return anomaly, got $rc"
  [ "$FM_BASE_RECONCILIATION_RESULT" = needs-reconciliation ] \
    || fail "stale base did not enter needs-reconciliation: $FM_BASE_RECONCILIATION_RESULT"
  [ "$FM_BASE_CURRENT_TARGET_HEAD" = "$current" ] \
    || fail "current target head was not computed from main"
  [ "$FM_BASE_MERGE_BASE" = "$base" ] \
    || fail "merge base did not identify the recorded base"
  [ "$FM_BASE_DRIFT" -eq 1 ] || fail "base drift should be one commit, got $FM_BASE_DRIFT"
  [ "$FM_BASE_BRANCH_INSERTIONS" -eq 1 ] \
    || fail "task-owned insertions should be one line, got $FM_BASE_BRANCH_INSERTIONS"
  [ "$FM_BASE_TARGET_DELETIONS" -eq 200 ] \
    || fail "current-target diff should expose 200 target-only deletions, got $FM_BASE_TARGET_DELETIONS"
  [ "$FM_BASE_DESTRUCTIVE_DIFF_ANOMALY" = 1 ] \
    || fail "destructive diff anomaly was not raised"
  pass "a stale base with disproportionate target-only deletions is refused"
}

test_current_base_is_not_anomaly() {
  local repo=$TMP_ROOT/current base branch rc
  mkdir -p "$repo"
  git init -q -b main "$repo"
  printf 'current\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -qm current
  base=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout -q -b fm/current
  printf 'task\n' > "$repo/task.txt"
  git -C "$repo" add task.txt
  git -C "$repo" commit -qm task

  rc=0
  fm_base_reconciliation_check "$repo" "fm/current" "$base" main || rc=$?
  [ "$rc" -eq 0 ] || fail "current base should be safe, got $rc"
  [ "$FM_BASE_DRIFT" -eq 0 ] || fail "current base should have zero drift"
  [ "$FM_BASE_TARGET_DELETIONS" -eq 0 ] \
    || fail "current-target diff should have no deletions, got $FM_BASE_TARGET_DELETIONS"
  [ "$FM_BASE_DESTRUCTIVE_DIFF_ANOMALY" = 0 ] \
    || fail "current base incorrectly raised a destructive anomaly"
  pass "a branch created from current target is not flagged"
}

test_local_merge_refuses_stale_base() {
  local root=$TMP_ROOT/merge-local home repo worktree
  local id=stale-delivery base current output rc
  home=$root/home
  repo=$root/repo
  worktree=$root/worktree
  mkdir -p "$home/state" "$home/data" "$home/config" "$repo"
  git init -q -b main "$repo"
  printf 'original\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -qm initial
  base=$(git -C "$repo" rev-parse HEAD)
  for i in $(seq 1 200); do
    printf 'target-only line %03d\n' "$i"
  done > "$repo/target-only.txt"
  git -C "$repo" add target-only.txt
  git -C "$repo" commit -qm 'advance target'
  current=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" worktree add -q -b "fm/$id" "$worktree" "$base"
  printf 'task change\n' > "$worktree/task.txt"
  git -C "$worktree" add task.txt
  git -C "$worktree" commit -qm 'task change'
  fm_write_meta "$home/state/$id.meta" \
    "window=fixture" \
    "worktree=$worktree" \
    "project=$repo" \
    "harness=fixture" \
    "kind=ship" \
    "mode=local-only" \
    "spawn_gen=fixture" \
    "base_sha=$base" \
    "target_branch=main"

  output=''
  rc=0
  FM_HOME="$home" FM_ROOT_OVERRIDE="$ROOT" FM_STATE_OVERRIDE="$home/state" \
    FM_DATA_OVERRIDE="$home/data" FM_CONFIG_OVERRIDE="$home/config" \
    "$ROOT/bin/fm-merge-local.sh" "$id" >"$root/merge.out" 2>&1 || rc=$?
  output=$(<"$root/merge.out")
  [ "$rc" -ne 0 ] || fail "local merge should refuse a stale base"
  assert_contains "$output" NEEDS_BASE_RECONCILIATION \
    "local merge did not expose the fail-closed reconciliation state"
  assert_grep 'blocked: NEEDS_BASE_RECONCILIATION' "$home/state/$id.status" \
    "local merge did not persist the reconciliation refusal"
  [ "$current" = "$(git -C "$repo" rev-parse main)" ] || \
    fail "local merge changed target despite stale-base refusal"
  pass "local merge refuses a stale base before landing"
}

test_stale_base_reports_destructive_diff_anomaly
test_current_base_is_not_anomaly
test_local_merge_refuses_stale_base
