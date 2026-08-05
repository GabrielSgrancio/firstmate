#!/usr/bin/env bash
# Hard-cancel an in-flight background Bash tool call inside an antigravity
# (agy) task's pane, without killing the agy TUI process itself.
#
# Usage: fm-agy-hard-cancel.sh <task-id>
#
# Live-verified 2026-08-05 (tmux backend): a single Escape stops agy's own
# turn/wait, but does NOT reliably kill a background Bash tool subprocess -
# the process survived 6 seconds past the interrupt in direct PID testing,
# and agy's own /tasks panel later showed that same command completed, not
# cancelled. This script is the real cancellation primitive: it walks the
# OS process tree rooted at the pane's own shell, finds every descendant
# EXCEPT the agy process itself, and terminates them (SIGTERM, then SIGKILL
# for any survivor), leaving agy's TUI alive to report the interruption.
#
# Backend scope: TMUX ONLY in this cut. herdr exposes `herdr pane
# process-info`, which is structurally capable of the same job, but that path
# was not live-verified in the time available and is refused rather than
# guessed at - see the harness-adapters skill "antigravity" section.
#
# This does not exit agy, does not interrupt agy's own current turn (send
# Escape separately first if the model itself should stop talking), and does
# not tear down the task. It only kills what agy itself spawned as OS
# processes under the pane.
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

ID=${1:-}
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
if [ "$HARNESS" != antigravity ]; then
  echo "error: task $ID is recorded as harness=$HARNESS, not antigravity; fm-agy-hard-cancel.sh is antigravity-only" >&2
  exit 1
fi

T=$(fm_backend_resolve_selector "$ID" "$STATE")
BACKEND=$(fm_backend_of_selector "$ID" "$T" "$STATE")

if [ "$BACKEND" != tmux ]; then
  echo "error: fm-agy-hard-cancel.sh only supports the tmux backend in this cut; task $ID uses backend=$BACKEND, which is not yet implemented (see this script's header)" >&2
  exit 1
fi

ROOT_PID=$(tmux display-message -p -t "$T" '#{pane_pid}' 2>/dev/null || true)
case "$ROOT_PID" in
  ''|*[!0-9]*)
    echo "error: could not read a numeric pane_pid for $ID (target $T); refusing to guess a kill target" >&2
    exit 1
    ;;
esac

# collect_descendants: every OS process whose ancestry traces back to
# <root-pid>, EXCLUDING root-pid itself, one pid per line. Plain POSIX
# `ps -eo pid=,ppid=` plus an awk BFS - no pstree/psmisc dependency.
collect_descendants() {  # <root-pid>
  local root=$1 snapshot
  snapshot=$(ps -eo pid=,ppid= 2>/dev/null) || return 1
  printf '%s\n' "$snapshot" | awk -v root="$root" '
    { p=$1+0; pp=$2+0; ppid[p]=pp }
    END {
      queue[1] = root; qn = 1; qi = 1
      while (qi <= qn) {
        cur = queue[qi]; qi++
        for (p in ppid) {
          if (ppid[p] == cur && !seen[p]) {
            seen[p] = 1
            print p
            qn++
            queue[qn] = p
          }
        }
      }
    }
  '
}

DESCENDANTS=$(collect_descendants "$ROOT_PID") || {
  echo "error: could not enumerate the process tree under pane_pid $ROOT_PID for $ID" >&2
  exit 1
}
if [ -z "$DESCENDANTS" ]; then
  echo "note: no descendant processes found under $ID's pane shell (pid $ROOT_PID); nothing to cancel" >&2
  exit 0
fi

AGY_PID=$(ps -eo pid=,comm= 2>/dev/null | awk '$2 == "agy" { print $1 }' \
  | grep -Fx -f <(printf '%s\n' "$DESCENDANTS") || true)

KILL_TARGETS=$(printf '%s\n' "$DESCENDANTS" | grep -Fxv "$AGY_PID" 2>/dev/null || printf '%s\n' "$DESCENDANTS")
if [ -z "$KILL_TARGETS" ]; then
  echo "note: only the agy process itself (pid $AGY_PID) was found under $ID's pane; nothing to cancel" >&2
  exit 0
fi

# shellcheck disable=SC2086  # deliberate word-splitting: one pid per kill argument
kill -TERM $KILL_TARGETS 2>/dev/null || true
sleep 1

SURVIVORS=
for pid in $KILL_TARGETS; do
  if kill -0 "$pid" 2>/dev/null; then
    SURVIVORS="$SURVIVORS $pid"
  fi
done
if [ -n "$SURVIVORS" ]; then
  # shellcheck disable=SC2086
  kill -KILL $SURVIVORS 2>/dev/null || true
  sleep 0.3
fi

STILL_ALIVE=
for pid in $KILL_TARGETS; do
  if kill -0 "$pid" 2>/dev/null; then
    STILL_ALIVE="$STILL_ALIVE $pid"
  fi
done
if [ -n "$STILL_ALIVE" ]; then
  echo "error: hard-cancel for $ID could not terminate:$STILL_ALIVE (checked with kill -0 after SIGTERM and SIGKILL)" >&2
  exit 1
fi

echo "hard-cancelled $ID: terminated${KILL_TARGETS:+ pids$(printf '%s' "$KILL_TARGETS" | tr '\n' ' ')}, agy pid $AGY_PID left running"
