#!/usr/bin/env bash
# fm-cancel.sh - generic cancellation tool for a firstmate-owned agent.
#
# Completes the 8-verb Orchestrator API contract (verb: cancel).
#
# Usage: fm-cancel.sh <task-id> [--reason <text>] [--teardown] [--force] [--json]
#
# Semantics:
#   - Validates task identity and endpoint in state/<id>.meta.
#   - For antigravity tasks: sends Escape to abort active model turns and runs
#     fm-agy-hard-cancel.sh to terminate background tool processes.
#   - For verified harnesses (claude, codex, gemini, cursor, pi, opencode, etc.):
#     delegates to `fm-control.sh <task-id> exit` to stop the agent process cleanly
#     while preserving the worktree and uncommitted changes.
#   - Records the cancellation event in state/<id>.status.
#   - If --teardown is requested, safely clears decision holds and tears down the task.
#
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

usage() {
  awk '
    NR == 1 { next }
    /^#/ { sub(/^# ?/, ""); print; next }
    { exit }
  ' "$0"
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac

# shellcheck source=bin/fm-backend.sh
. "$SCRIPT_DIR/fm-backend.sh"
# shellcheck source=bin/fm-control-lib.sh
. "$SCRIPT_DIR/fm-control-lib.sh"

ID=""
REASON="cancelled by orchestrator"
DO_TEARDOWN=0
FORCE_FLAG=""
FORMAT_JSON=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --reason)
      shift
      [ "$#" -gt 0 ] || { echo "error: --reason requires an argument" >&2; exit 1; }
      REASON="$1"
      ;;
    --teardown)
      DO_TEARDOWN=1
      ;;
    --force)
      FORCE_FLAG="--force"
      ;;
    --json)
      FORMAT_JSON=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "error: unknown flag: $1" >&2
      exit 1
      ;;
    *)
      if [ -z "$ID" ]; then
        ID="$1"
      else
        echo "error: unexpected argument: $1" >&2
        exit 1
      fi
      ;;
  esac
  shift
done

if [ -z "$ID" ]; then
  usage >&2
  exit 1
fi

META="$STATE/$ID.meta"
if [ ! -f "$META" ]; then
  echo "error: no meta for task $ID at $META" >&2
  exit 1
fi

HARNESS=$(sed -n 's/^harness=//p' "$META" | head -n 1)
BACKEND=$(sed -n 's/^backend=//p' "$META" | head -n 1)
BACKEND=${BACKEND:-tmux}
ENDPOINT=$(sed -n 's/^endpoint=//p' "$META" | head -n 1)

# Check for remote secondmate refusal (same boundary as fm-control.sh)
REMOTE_HOST=$(sed -n 's/^remote_host=//p' "$META" | head -n 1)
if [ -n "$REMOTE_HOST" ]; then
  echo "error: task $ID runs on remote host '$REMOTE_HOST'; use remote control plane" >&2
  exit 1
fi

# Execute harness-specific cancellation
if [ "$HARNESS" = "antigravity" ]; then
  # 1. Send Escape via backend if endpoint exists
  if [ -n "$ENDPOINT" ]; then
    fm_backend_send_keys "$BACKEND" "$ENDPOINT" "Escape" 2>/dev/null || true
  fi
  # 2. Run agy hard-cancel if script exists
  if [ -f "$SCRIPT_DIR/fm-agy-hard-cancel.sh" ]; then
    "$SCRIPT_DIR/fm-agy-hard-cancel.sh" "$ID" || true
  fi
else
  # Generic FirstMate harness exit
  if fm_control_harness_family "$HARNESS" >/dev/null 2>&1; then
    "$SCRIPT_DIR/fm-control.sh" "$ID" exit
  else
    echo "error: harness '$HARNESS' does not support generic cancellation control plane" >&2
    exit 1
  fi
fi

# Append cancelled status event
STATUS_FILE="$STATE/$ID.status"
printf 'failed: %s\n' "$REASON" >> "$STATUS_FILE"

# Optional teardown
if [ "$DO_TEARDOWN" -eq 1 ]; then
  # Structural separation & Captain-hold protection (P0-4 / P1-5):
  # Cancel must never unilaterally wipe out an open hold held for the Captain.
  if [ -f "$SCRIPT_DIR/fm-captain-hold.sh" ] && "$SCRIPT_DIR/fm-captain-hold.sh" open "$ID" >/dev/null 2>&1; then
    echo "error: task $ID has an open hold for the Captain; refusing to unilaterally discard Captain decision-hold on cancel" >&2
    exit 1
  fi
  if [ -n "$FORCE_FLAG" ]; then
    "$SCRIPT_DIR/fm-teardown.sh" "$ID" "$FORCE_FLAG"
  else
    "$SCRIPT_DIR/fm-teardown.sh" "$ID"
  fi
fi

# Output confirmation
if [ "$FORMAT_JSON" -eq 1 ]; then
  printf '{"id":"%s","status":"cancelled","harness":"%s","reason":"%s"}\n' "$ID" "$HARNESS" "$REASON"
else
  printf 'cancelled task %s (harness: %s, reason: %s)\n' "$ID" "$HARNESS" "$REASON"
fi
