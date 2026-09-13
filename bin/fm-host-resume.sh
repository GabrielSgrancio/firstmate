#!/usr/bin/env bash
# Host failover resumption utility: called by an alternate host (Claude, Codex, etc.)
# to restore orchestration state when the previous host was exhausted or terminated.
# Usage: bin/fm-host-resume.sh [--host <name>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FM_HOME="${FM_HOME:-$ROOT_DIR}"
STATE_DIR="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

CHECKPOINT_JSON="$STATE_DIR/host-checkpoint.json"

if [[ ! -f "$CHECKPOINT_JSON" ]]; then
  echo "error: no host checkpoint found at $CHECKPOINT_JSON. Nothing to resume." >&2
  exit 1
fi

target_host="${1:-}"
if [[ "$target_host" == "--host" ]]; then
  target_host="${2:-}"
fi

echo "========================================================================"
echo "⚡ FirstMate Orchestration Host Resumption"
echo "========================================================================"

# Extract checkpoint metadata
ts=$(jq -r '.timestamp' "$CHECKPOINT_JSON")
prev_host=$(jq -r '.activeHost.name' "$CHECKPOINT_JSON")
prev_pid=$(jq -r '.activeHost.lockPid // empty' "$CHECKPOINT_JSON")
obj=$(jq -r '.objective' "$CHECKPOINT_JSON")

echo "Resuming from checkpoint captured at: $ts"
echo "Previous Host: $prev_host (PID: ${prev_pid:-none})"
if [[ -n "$target_host" ]]; then
  echo "Incoming Host: $target_host"
fi
echo ""
echo "Active Objective:"
echo "$obj"
echo ""

# Check and reconcile session lock
LOCK_FILE="$STATE_DIR/.lock"
if [[ -f "$LOCK_FILE" ]]; then
  curr_lock_pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if [[ -n "$curr_lock_pid" && "$curr_lock_pid" =~ ^[0-9]+$ ]]; then
    if ! kill -0 "$curr_lock_pid" 2>/dev/null; then
      echo "Stale lock detected (PID $curr_lock_pid is dead). Releasing lock..."
      rm -f "$LOCK_FILE"
    else
      echo "Notice: Lock held by live process PID $curr_lock_pid."
      echo "If previous host died or was stopped, run 'bin/fm-lock.sh break' to acquire."
    fi
  fi
fi

# Print active tasks
echo "------------------------------------------------------------------------"
echo "Active Tasks in Flight:"
python3 -c '
import json
with open("'"$CHECKPOINT_JSON"'") as f:
    d = json.load(f)
tasks = d.get("activeTasks", [])
if not tasks:
    print("  (No active tasks recorded)")
for t in tasks:
    tid=t.get("id",""); k=t.get("kind","ship"); st=t.get("status","active"); print(f"  • {tid}: {k} [{st}]")
'
echo "------------------------------------------------------------------------"
echo "Orchestration state restored. You may now continue supervising the fleet."
echo "Run 'bin/fm-session-start.sh' to re-verify digest or dispatch next tasks."
echo "========================================================================"
