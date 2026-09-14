#!/usr/bin/env bash
# fm-supervisor-launch.sh - bootstrap and launch a routed primary supervisor.
#
# Usage:
#   fm-supervisor-launch.sh <harness> <executable-command>
#
# The continuity service starts this adapter as the replacement process.  The
# adapter discovers active missions and renders their resume contexts itself,
# then delivers the result through the launch-brief operational-input carrier.
# The executable command is the configured command for the selected harness.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
HOME_DIR="${FM_HOME:-$ROOT}"
DATA="${FM_DATA_OVERRIDE:-$HOME_DIR/data}"
STATE="${FM_STATE_OVERRIDE:-$HOME_DIR/state}"
MISSION="$ROOT/bin/fm-mission.sh"
OPERATIONAL_INPUT="$ROOT/bin/fm-operational-input.sh"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
valid_id() { case "${1-}" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac; }

HARNESS="${1-}"
COMMAND="${2-}"
case "$HARNESS" in
  codex|claude|antigravity|opencode) ;;
  *) die "unsupported supervisor harness: $HARNESS" ;;
esac
[ -n "$COMMAND" ] || die 'supervisor replacement command is required'
[ -x "$COMMAND" ] || die "supervisor replacement command is not executable: $COMMAND"
[ -x "$MISSION" ] || die "mission bootstrap is not executable: $MISSION"
[ -x "$OPERATIONAL_INPUT" ] || die "operational-input encoder is not executable: $OPERATIONAL_INPUT"

active_missions=$(FM_HOME="$HOME_DIR" FM_ROOT_OVERRIDE="$ROOT" \
  FM_DATA_OVERRIDE="$DATA" FM_STATE_OVERRIDE="$STATE" \
  "$MISSION" active) || die 'could not discover active missions'
[ -n "$(printf '%s' "$active_missions" | tr -d '[:space:]')" ] || die 'no active mission is available for supervisor replacement'

context_file=$(mktemp "$STATE/.supervisor-resume-context.XXXXXX") || die 'could not create resume context'
cleanup() { rm -f -- "$context_file"; }
trap cleanup EXIT

context_written=0
while IFS= read -r mission_id || [ -n "$mission_id" ]; do
  [ -n "$mission_id" ] || continue
  valid_id "$mission_id" || die "active mission has an invalid id: $mission_id"
  context=$(FM_HOME="$HOME_DIR" FM_ROOT_OVERRIDE="$ROOT" \
    FM_DATA_OVERRIDE="$DATA" FM_STATE_OVERRIDE="$STATE" \
    "$MISSION" resume-context "$mission_id") \
    || die "could not render resume context for mission $mission_id"
  if [ "$context_written" -eq 1 ]; then
    printf '\n' >>"$context_file"
  fi
  printf '%s\n' "$context" >>"$context_file"
  context_written=1
done <<<"$active_missions"
[ "$context_written" -eq 1 ] || die 'active mission discovery returned no usable mission'

launch_input=$("$OPERATIONAL_INPUT" encode launch-brief <"$context_file") \
  || die 'could not encode supervisor resume context'

case "$HARNESS" in
  claude|codex)
    exec "$COMMAND" "$launch_input"
    ;;
  antigravity)
    exec "$COMMAND" --prompt-interactive "$launch_input"
    ;;
  opencode)
    exec "$COMMAND" --prompt "$launch_input"
    ;;
esac
