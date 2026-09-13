#!/usr/bin/env bash
# Worker quota failover coordinator.
#
# Detects a durable quota-exhaustion event for one worker, asks Router V2 for
# an eligible replacement while excluding every RouteTarget on the failed
# harness, and delegates the replacement transaction to fm-control.sh.
#
# This script owns neither task metadata, leases, endpoints, nor worktrees.
# fm-control.sh owns the checkpoint, lease guard, stop, relaunch, and metadata
# publication transaction for the existing task.
#
# Usage:
#   fm-failover.sh <task-id> [--reason QUOTA_EXHAUSTED]
#                  [--failed-route <route-id>] [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "${1:-}" = -h ] || [ "${1:-}" = --help ]; then
  sed -n '2,${/^#/!q;p;}' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

if [ -z "${FM_HOME+x}" ] || [ -z "${FM_HOME:-}" ]; then
  echo "error: FM_HOME is not set; fm-failover refuses to resolve a task without an explicit firstmate home" >&2
  exit 1
fi
export FM_HOME
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"

usage() {
  sed -n '2,${/^#/!q;p;}' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  echo "error: $1" >&2
  exit 1
}

TASK_ID=${1:-}
[ -n "$TASK_ID" ] || { usage >&2; exit 2; }
shift

REASON=QUOTA_EXHAUSTED
FAILED_ROUTE=
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --reason)
      [ "$#" -ge 2 ] || die "--reason requires a value"
      REASON=$2
      shift 2
      ;;
    --failed-route)
      [ "$#" -ge 2 ] || die "--failed-route requires a value"
      FAILED_ROUTE=$2
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -d "$STATE" ] || die "state dir '$STATE' is missing; failover will not create fleet state"
[ -d "$DATA" ] || die "data dir '$DATA' is missing; failover cannot resolve task ownership"

META="$STATE/$TASK_ID.meta"
STATUS="$STATE/$TASK_ID.status"
TASK_DATA="$DATA/$TASK_ID"
DECISION="$TASK_DATA/failover-decision.json"
[ -f "$META" ] || die "metadata file for task $TASK_ID not found at $META"
[ -f "$STATUS" ] || die "status file for task $TASK_ID not found at $STATUS"
[ -d "$TASK_DATA" ] || die "task data directory '$TASK_DATA' is missing; failover will not create task state"

meta_field() {
  awk -F= -v wanted="$1" '$1 == wanted { value = substr($0, index($0, "=") + 1) } END { print value }' "$META"
}

case "$REASON" in
  QUOTA_EXHAUSTED) ;;
  *) die "unsupported failover reason '$REASON'; worker failover currently accepts only QUOTA_EXHAUSTED" ;;
esac

grep -Eq '(^|[[:space:]])(quota_exhausted|QUOTA_EXHAUSTED)(:|[[:space:]]|$)|^status:[[:space:]]*exhausted([[:space:]]|$)' "$STATUS" \
  || die "task $TASK_ID has no durable QUOTA_EXHAUSTED status event"

ROLE=$(meta_field role)
DATA_CLASS=$(meta_field data_class)
FAILED_HARNESS=$(meta_field harness)
OLD_EFFORT=$(meta_field effort)
[ -n "$ROLE" ] || die "task $TASK_ID metadata has no role; failover refuses to guess Router V2 inputs"
[ -n "$DATA_CLASS" ] || die "task $TASK_ID metadata has no data_class; failover refuses to bypass the data policy"
[ -n "$FAILED_HARNESS" ] || die "task $TASK_ID metadata has no harness; failover cannot exclude the failed worker"

LOCK="$STATE/.failover-$TASK_ID.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  die "another quota failover is already handling task $TASK_ID"
fi
cleanup() {
  rmdir "$LOCK" 2>/dev/null || true
}
trap cleanup EXIT

if [ -f "$DECISION" ]; then
  phase=$(jq -r '.phase // empty' "$DECISION" 2>/dev/null || true)
  case "$phase" in
    complete)
      echo "failover already complete for $TASK_ID; durable decision is $DECISION"
      exit 0
      ;;
    planned)
      die "task $TASK_ID has an unfinished failover decision at $DECISION; reconcile its control journal before retrying"
      ;;
    *)
      die "task $TASK_ID has an unreadable failover decision at $DECISION"
      ;;
  esac
fi

if [ -z "$FAILED_ROUTE" ]; then
  FAILED_ROUTE=$(meta_field route_id)
fi

ROUTE_JSON=$(cd "$ROOT_DIR" && FM_HOME="$FM_HOME" node --input-type=module - \
  "$ROLE" "$DATA_CLASS" "$FAILED_HARNESS" "$FAILED_ROUTE" "$OLD_EFFORT" <<'NODE'
import { loadConfigs, scoreAndSelectRoute } from './bin/fm-router-v2.mjs';

const [role, dataClass, failedHarnessRaw, failedRoute, oldEffort] = process.argv.slice(2);
const failedHarness = failedHarnessRaw === 'agy' ? 'antigravity' : failedHarnessRaw;
const { compiledRoutes } = loadConfigs();
const excludedRoutes = compiledRoutes
  .filter((route) => route.harness === failedHarness)
  .map((route) => route.route_id);
if (failedRoute && !excludedRoutes.includes(failedRoute)) excludedRoutes.push(failedRoute);
const targetEffort = ['low', 'medium', 'high', 'xhigh'].includes(oldEffort) ? oldEffort : null;
let quotaOverrides = null;
if (process.env.FM_FAILOVER_QUOTA_OVERRIDES) {
  quotaOverrides = JSON.parse(process.env.FM_FAILOVER_QUOTA_OVERRIDES);
}
const decision = scoreAndSelectRoute({
  role,
  dataClass,
  targetEffort,
  quotaOverrides,
  excludeRoutes: excludedRoutes,
  useLiveAxi: process.env.FM_FAILOVER_USE_LIVE_QUOTA !== '0'
});
console.log(JSON.stringify({
  failedHarness,
  failedRoute: failedRoute || null,
  excludedRoutes,
  selectedRoute: decision.selectedRoute,
  scarcityState: decision.scarcityState,
  rejectedRoutes: decision.rejectedRoutes
}));
NODE
)

NEW_ROUTE=$(printf '%s\n' "$ROUTE_JSON" | jq -r '.selectedRoute.route_id')
NEW_HARNESS=$(printf '%s\n' "$ROUTE_JSON" | jq -r '.selectedRoute.harness')
NEW_MODEL=$(printf '%s\n' "$ROUTE_JSON" | jq -r '.selectedRoute.resolved_runtime_model')
NEW_EFFORT=$(printf '%s\n' "$ROUTE_JSON" | jq -r '.selectedRoute.reasoning_effort // empty')
[ -n "$NEW_ROUTE" ] && [ "$NEW_ROUTE" != null ] || die "Router V2 returned no replacement route"
[ "$NEW_HARNESS" != "$FAILED_HARNESS" ] || die "Router V2 selected the failed harness '$FAILED_HARNESS'"

echo "quota failover: task=$TASK_ID from=$FAILED_HARNESS route=${FAILED_ROUTE:-unknown} to=$NEW_ROUTE"
echo "quota failover: Router V2 excluded ${FAILED_HARNESS} RouteTargets and selected harness=$NEW_HARNESS model=$NEW_MODEL effort=${NEW_EFFORT:-default}"

if [ "$DRY_RUN" = 1 ]; then
  echo "quota failover dry-run complete; no control transaction or durable decision was written"
  exit 0
fi

STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DECISION_TMP="$DECISION.tmp.${BASHPID:-$$}"
jq -n \
  --arg task_id "$TASK_ID" \
  --arg phase planned \
  --arg reason "$REASON" \
  --arg failed_harness "$FAILED_HARNESS" \
  --arg failed_route "${FAILED_ROUTE:-}" \
  --arg selected_route "$NEW_ROUTE" \
  --arg selected_harness "$NEW_HARNESS" \
  --arg selected_model "$NEW_MODEL" \
  --arg selected_effort "${NEW_EFFORT:-}" \
  --arg role "$ROLE" \
  --arg data_class "$DATA_CLASS" \
  --arg planned_at "$STAMP" \
  --argjson route "$(printf '%s\n' "$ROUTE_JSON" | jq '.selectedRoute')" \
  '{version: 1, task_id: $task_id, phase: $phase, reason: $reason,
    failed_harness: $failed_harness, failed_route: ($failed_route // null),
    selected_route: $selected_route, selected_harness: $selected_harness,
    selected_model: $selected_model, selected_effort: ($selected_effort // null),
    role: $role, data_class: $data_class, route_target: $route,
    planned_at: $planned_at}' > "$DECISION_TMP"
mv -f "$DECISION_TMP" "$DECISION"

NOTE="Quota exhausted on ${FAILED_HARNESS}${FAILED_ROUTE:+ ($FAILED_ROUTE)}. Router V2 selected ${NEW_ROUTE}; continue this same task in its recorded worktree and preserve all progress. Do not create a second task or discard uncommitted work."
CONTROL="${FM_FAILOVER_CONTROL:-$SCRIPT_DIR/fm-control.sh}"
CONTROL_ARGS=("$TASK_ID" relaunch --harness "$NEW_HARNESS" --model "$NEW_MODEL")
[ -z "$NEW_EFFORT" ] || CONTROL_ARGS+=(--effort "$NEW_EFFORT")
CONTROL_ARGS+=(--route-id "$NEW_ROUTE" --note "$NOTE")
CONTROL_OUTPUT=
if CONTROL_OUTPUT=$(FM_HOME="$FM_HOME" "$CONTROL" "${CONTROL_ARGS[@]}" 2>&1); then
  printf '%s\n' "$CONTROL_OUTPUT"
else
  rc=$?
  printf '%s\n' "$CONTROL_OUTPUT" >&2
  die "fm-control relaunch failed for task $TASK_ID; planned decision remains at $DECISION (exit $rc)"
fi

COMPLETE_STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
COMPLETE_TMP="$DECISION.tmp.${BASHPID:-$$}"
jq --arg phase complete --arg completed_at "$COMPLETE_STAMP" \
  '.phase = $phase | .completed_at = $completed_at' "$DECISION" > "$COMPLETE_TMP"
mv -f "$COMPLETE_TMP" "$DECISION"
printf 'failover: task=%s route=%s harness=%s reason=%s\n' \
  "$TASK_ID" "$NEW_ROUTE" "$NEW_HARNESS" "$REASON" >> "$STATUS"
echo "quota failover complete: task=$TASK_ID decision=$DECISION"
