#!/usr/bin/env bash
# Real-harness replacement supervisor: receives the launch-brief exactly like
# the fixture-only supervisor-b.sh, but instead of only recording the input
# for assertions, it hands the delivered resume context to a real `codex`
# process and lets that process genuinely decide, from the delivered context
# alone, whether the disposable trivial task is already done.
set -u
ROOT=${FM_ROOT_OVERRIDE:?}
HOME_DIR=${FM_HOME:?}
STATE=${FM_STATE_OVERRIDE:-$HOME_DIR/state}
DATA=${FM_DATA_OVERRIDE:-$HOME_DIR/data}

[ "$#" -eq 1 ] || exit 1
launch_input=$1
[ -z "${FM_MISSION_ID+x}" ] && [ -z "${FM_MISSION_CAPSULE+x}" ] || exit 1
printf '%s' "$launch_input" > "$STATE/supervisor-b-launch-raw"
printf '%s' "$launch_input" | "$ROOT/bin/fm-operational-input.sh" kind > "$STATE/supervisor-b-launch-kind"
printf '%s' "$launch_input" | "$ROOT/bin/fm-operational-input.sh" body > "$STATE/supervisor-b-launch-input.md"
[ "$(cat "$STATE/supervisor-b-launch-kind")" = launch-brief ] || exit 1

# Mission identity is intentionally discovered through the bootstrap command,
# never through env vars the launch adapter deliberately never sets.
unset FM_MISSION_ID FM_MISSION_CAPSULE
mission_id=$(FM_HOME="$HOME_DIR" FM_ROOT_OVERRIDE="$ROOT" \
  FM_DATA_OVERRIDE="$DATA" FM_STATE_OVERRIDE="$STATE" \
  "$ROOT/bin/fm-mission.sh" active | head -1)
[ -n "$mission_id" ] || exit 1
FM_HOME="$HOME_DIR" FM_ROOT_OVERRIDE="$ROOT" \
  FM_DATA_OVERRIDE="$DATA" FM_STATE_OVERRIDE="$STATE" \
  "$ROOT/bin/fm-mission.sh" resume-context "$mission_id" > "$STATE/supervisor-b-context.md"
printf '%s\n' "$$" > "$STATE/supervisor-b.pid"
FM_HOME="$HOME_DIR" FM_ROOT_OVERRIDE="$ROOT" \
  FM_DATA_OVERRIDE="$DATA" FM_STATE_OVERRIDE="$STATE" \
  "$ROOT/bin/fm-supervisor-continuity.sh" record-supervisor \
  "$mission_id" "$$" codex "${FM_SUPERVISOR_SESSION_ID:-session-b}"

# The delivered context references the original prompt only by pointer
# (ORIGINAL PROMPT file=<path> sha256=<hash>), never by inline text, so the
# real harness has to genuinely resolve and read that pointer itself, the
# same way a real rehydrated supervisor would. This preamble is operating
# instruction, not the task answer: it tells the session how to interpret a
# resume context at all, standing in for the operating contract a real
# firstmate session already carries, without ever stating what the task is
# or whether it is done.
body=$(cat "$STATE/supervisor-b-launch-input.md")
prompt=$(cat <<PROMPT
You are Supervisor B, a fresh session starting because Supervisor A's process
was unexpectedly terminated. Below is your delivered resume context for the
mission you are taking over.

Find the line starting with "ORIGINAL PROMPT" and read the file named by its
file=<path> field (that path is relative to your current working directory);
it contains your actual task instructions. Carry out exactly those
instructions, taking into account the PROGRESS and TASK lines below so you do
not repeat work that is already done. Do not invent additional work beyond
what that original prompt file asks for.

--- BEGIN DELIVERED RESUME CONTEXT ---
$body
--- END DELIVERED RESUME CONTEXT ---
PROMPT
)

codex exec "$prompt" \
  -s workspace-write -C "$HOME_DIR" --skip-git-repo-check \
  -o "$STATE/supervisor-b-real-output.txt" \
  >"$STATE/supervisor-b-real.log" 2>&1
printf '%s\n' "$?" > "$STATE/supervisor-b-real-exit"
touch "$STATE/supervisor-b-real-done"
sleep 300
