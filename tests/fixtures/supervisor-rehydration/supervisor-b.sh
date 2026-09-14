#!/usr/bin/env bash
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

# Mission identity is intentionally discovered through the bootstrap command.
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
  "$mission_id" "$$" claude "${FM_SUPERVISOR_SESSION_ID:-session-b}"
sleep 300
