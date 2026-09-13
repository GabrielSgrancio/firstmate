#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034 # Public result fields are consumed by sourcing callers.
# Shared stale task-base detection for delivery and cleanup gates.
# Usage: . bin/fm-base-reconciliation-lib.sh
#
# The caller supplies the project, task branch, recorded base commit, and target
# branch, then reads the FM_BASE_RECONCILIATION_* result fields below.

FM_BASE_RECONCILIATION_RESULT=
FM_BASE_CURRENT_TARGET_HEAD=
FM_BASE_MERGE_BASE=
FM_BASE_DRIFT=
FM_BASE_BRANCH_INSERTIONS=
FM_BASE_TARGET_DELETIONS=
FM_BASE_DESTRUCTIVE_DIFF_ANOMALY=0

# A stale base that makes a branch look like it deletes a large target-only
# surface is suspicious only when that deletion count is materially larger than
# the task's own additions. These fixed conservative bounds keep ordinary small
# edits from becoming delivery holds while catching the incident's shape.
FM_BASE_RECONCILIATION_MIN_DELETIONS=100
FM_BASE_RECONCILIATION_DELETION_RATIO=10

fm_base_reconciliation_numstat_total() {  # <project> <left> <right> <column>
  local project=$1 left=$2 right=$3 column=$4 numstat
  numstat=$(git -C "$project" diff --numstat "$left" "$right" 2>/dev/null) || return 1
  awk -F '\t' -v column="$column" \
    '$column ~ /^[0-9]+$/ { total += $column } END { print total + 0 }' \
    <<<"$numstat"
}

# Compute delivery-time base provenance.
# Returns 0 when the branch is safe, 1 for the destructive-diff anomaly, and 2
# when the recorded base or target cannot be verified.
fm_base_reconciliation_check() {  # <project> <branch> <base-sha> <target-branch>
  local project=$1 branch=$2 base_sha=$3 target_branch=$4 target_ref
  local current_target_head merge_base base_drift branch_insertions target_deletions
  FM_BASE_RECONCILIATION_RESULT=unverified
  FM_BASE_CURRENT_TARGET_HEAD=
  FM_BASE_MERGE_BASE=
  FM_BASE_DRIFT=
  FM_BASE_BRANCH_INSERTIONS=
  FM_BASE_TARGET_DELETIONS=
  FM_BASE_DESTRUCTIVE_DIFF_ANOMALY=0

  [ -d "$project" ] && [ -n "$branch" ] && [ -n "$base_sha" ] \
    && [ -n "$target_branch" ] || return 2
  target_ref="refs/heads/$target_branch"
  current_target_head=$(git -C "$project" rev-parse --verify --quiet "$target_ref^{commit}" 2>/dev/null) \
    || return 2
  git -C "$project" rev-parse --verify --quiet "$base_sha^{commit}" >/dev/null 2>&1 \
    || return 2
  git -C "$project" rev-parse --verify --quiet "$branch^{commit}" >/dev/null 2>&1 \
    || return 2
  merge_base=$(git -C "$project" merge-base "$base_sha" "$current_target_head" 2>/dev/null) \
    || return 2
  git -C "$project" merge-base --is-ancestor "$base_sha" "$current_target_head" \
    || return 2
  base_drift=$(git -C "$project" rev-list --count "$base_sha..$current_target_head" 2>/dev/null) \
    || return 2
  branch_insertions=$(fm_base_reconciliation_numstat_total \
    "$project" "$base_sha" "$branch" 1) || return 2
  target_deletions=$(fm_base_reconciliation_numstat_total \
    "$project" "$current_target_head" "$branch" 2) || return 2

  FM_BASE_RECONCILIATION_RESULT=safe
  FM_BASE_CURRENT_TARGET_HEAD=$current_target_head
  FM_BASE_MERGE_BASE=$merge_base
  FM_BASE_DRIFT=$base_drift
  FM_BASE_BRANCH_INSERTIONS=$branch_insertions
  FM_BASE_TARGET_DELETIONS=$target_deletions
  if [ "$base_drift" -gt 0 ] \
    && [ "$target_deletions" -ge "$FM_BASE_RECONCILIATION_MIN_DELETIONS" ] \
    && [ "$target_deletions" -gt $((branch_insertions * FM_BASE_RECONCILIATION_DELETION_RATIO)) ]; then
    FM_BASE_RECONCILIATION_RESULT=needs-reconciliation
    FM_BASE_DESTRUCTIVE_DIFF_ANOMALY=1
    return 1
  fi
  return 0
}

fm_base_reconciliation_summary() {
  printf 'current_target_head=%s merge_base=%s base_drift=%s branch_insertions=%s target_deletions=%s destructive_diff_anomaly=%s' \
    "$FM_BASE_CURRENT_TARGET_HEAD" "$FM_BASE_MERGE_BASE" "$FM_BASE_DRIFT" \
    "$FM_BASE_BRANCH_INSERTIONS" "$FM_BASE_TARGET_DELETIONS" \
    "$FM_BASE_DESTRUCTIVE_DIFF_ANOMALY"
}
