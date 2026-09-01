#!/usr/bin/env bash
# Opt-in real agy drift guard for Stop execution and rendered busy-state signals.
set -u

if [ "${FM_ANTIGRAVITY_PRIMARY_LIVE_E2E:-0}" != 1 ]; then
  echo "skip: set FM_ANTIGRAVITY_PRIMARY_LIVE_E2E=1 to run the real antigravity primary drift guard"
  exit 0
fi

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

AGY_BIN=$(command -v agy 2>/dev/null || true)
REAL_TMUX=$(command -v tmux 2>/dev/null || true)
WORKSPACE=${FM_ANTIGRAVITY_LIVE_WORKSPACE:-$ROOT}
MODEL=${FM_ANTIGRAVITY_LIVE_MODEL:-gemini-3.7-flash-low}
SOCKET="fm-agy-primary-$$"
SESSION=agy-primary-live
TARGET="$SESSION:agy"
LAB=
VERSION=unknown

cleanup() {
  [ -z "$REAL_TMUX" ] || "$REAL_TMUX" -L "$SOCKET" kill-server >/dev/null 2>&1 || true
  [ -z "$LAB" ] || rm -rf -- "$LAB"
}

live_fail() {
  printf 'not ok - antigravity agy %s: %s\n' "$VERSION" "$1" >&2
  cleanup
  exit 1
}

[ -x "$AGY_BIN" ] || live_fail "FM_ANTIGRAVITY_PRIMARY_LIVE_E2E=1 but no agy executable is installed on PATH"
VERSION=$($AGY_BIN --version 2>/dev/null | sed -n '1p')
[ -x "$REAL_TMUX" ] || live_fail "tmux is required"
command -v jq >/dev/null 2>&1 || live_fail "jq is required"
[ -d "$WORKSPACE/.agents" ] && [ -f "$WORKSPACE/.agents/hooks.json" ] \
  || live_fail "FM_ANTIGRAVITY_LIVE_WORKSPACE must contain the candidate .agents/hooks.json"

LAB=$(mktemp -d "${TMPDIR:-/tmp}/fm-agy-primary.XXXXXX") || live_fail "could not create isolated state"
trap cleanup EXIT
mkdir -p "$LAB/state" "$LAB/config"
printf 'harness=antigravity\n' > "$LAB/state/live.meta"

# shellcheck source=bin/fm-busy-lib.sh
. "$ROOT/bin/fm-busy-lib.sh"

capture() {
  "$REAL_TMUX" -L "$SOCKET" capture-pane -p -t "$TARGET" -S -80 2>/dev/null
}

wait_capture() {  # <fixed-string> <attempts>
  local needle=$1 attempts=$2 out i=0
  while [ "$i" -lt "$attempts" ]; do
    out=$(capture || true)
    case "$out" in *"$needle"*) printf '%s' "$out"; return 0 ;; esac
    sleep 0.25
    i=$((i + 1))
  done
  return 1
}

send_prompt() {  # <text>
  "$REAL_TMUX" -L "$SOCKET" send-keys -t "$TARGET" -l -- "$1" \
    || live_fail "could not type into the agy pane"
  "$REAL_TMUX" -L "$SOCKET" send-keys -t "$TARGET" Enter \
    || live_fail "could not submit to the agy pane"
}

"$REAL_TMUX" -L "$SOCKET" new-session -d -s "$SESSION" -n agy -c "$WORKSPACE" -- \
  env FM_ROOT_OVERRIDE="$WORKSPACE" FM_HOME="$WORKSPACE" \
    FM_STATE_OVERRIDE="$LAB/state" FM_CONFIG_OVERRIDE="$LAB/config" \
    "$AGY_BIN" --model "$MODEL" --dangerously-skip-permissions \
  || live_fail "could not launch the real TUI"

READY=$(wait_capture '? for shortcuts' 160) \
  || live_fail "the TUI never became ready; ensure the workspace is already trusted and the model is available"
case "$READY" in *'Do you trust the contents of this project?'*) live_fail "workspace trust is not established" ;; esac

send_prompt 'Reply exactly AGY_LIVE_BASE. If a system message says a Stop hook blocked termination, reply exactly AGY_LIVE_CONTINUED, then stop.'
BUSY=$(wait_capture 'esc to cancel' 80) || live_fail "the active-turn footer never appeared"
[ "$(printf '%s' "$BUSY" | fm_busy_antigravity_tail_state)" = busy ] \
  || live_fail "the real active-turn footer did not classify busy"

STOPPED=$(wait_capture 'AGY_LIVE_CONTINUED' 240) \
  || live_fail "the real Stop hook did not execute and force its bounded continuation"
printf '%s' "$STOPPED" | grep -Fq 'AGY_LIVE_BASE' \
  || live_fail "the forced continuation lost the initial model response"
wait_capture '? for shortcuts' 160 >/dev/null \
  || live_fail "the bounded Stop continuation did not settle"
rm -f "$LAB/state/live.meta"

# shellcheck disable=SC2016 # literal model prompt, not shell interpolation
send_prompt 'Use run_command to execute `sleep 8; printf AGY_BG_DONE` as a background task. End your response immediately after launching it.'
TASK_BUSY=$(wait_capture 'task(s) · /tasks' 160) \
  || live_fail "the background-task counter never appeared"
printf '%s' "$TASK_BUSY" | grep -Fq '? for shortcuts' \
  || live_fail "the background-task audit did not separate an idle model from a live task"
[ "$(printf '%s' "$TASK_BUSY" | fm_busy_antigravity_tail_state)" = busy ] \
  || live_fail "the real background-task counter did not independently classify busy"

wait_capture 'AGY_BG_DONE' 160 >/dev/null \
  || live_fail "the real background task did not deliver its completion wake"
IDLE=$(wait_capture '? for shortcuts' 160) \
  || live_fail "the TUI did not settle after the background completion wake"
IDLE_TAIL=$(printf '%s' "$IDLE" | tail -16)
printf '%s' "$IDLE_TAIL" | grep -Eq '[0-9]+ task\(s\)[[:space:]]*·[[:space:]]*/tasks' \
  && live_fail "the settled tail retained an active-task counter"
[ "$(printf '%s' "$IDLE_TAIL" | fm_busy_antigravity_tail_state)" = idle ] \
  || live_fail "the settled real footer did not classify idle"

printf 'ok - antigravity agy %s executed the Stop hook and preserved independent turn, task, and idle signals\n' "$VERSION"
cleanup
trap - EXIT
