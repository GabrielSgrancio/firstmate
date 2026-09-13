#!/usr/bin/env bash
# Regression tests for the canonical per-mission event log and materializer.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MISSION="$ROOT/bin/fm-mission.sh"
TMP_ROOT=$(fm_test_tmproot fm-mission-event-store)
HOME_DIR="$TMP_ROOT/home"
mkdir -p "$HOME_DIR/data" "$HOME_DIR/state"

mission() {
  FM_HOME="$HOME_DIR" FM_ROOT_OVERRIDE="$ROOT" \
    FM_DATA_OVERRIDE="$HOME_DIR/data" FM_STATE_OVERRIDE="$HOME_DIR/state" \
    "$MISSION" "$@"
}

prompt="$TMP_ROOT/original-prompt.md"
printf 'Captain exact mission intent.\n' > "$prompt"
mission init event-store --intent 'Canonical mission state' --prompt-file "$prompt" \
  --prompt-source-transcript /tmp/session.jsonl --prompt-step-index 42 \
  --prompt-classification EXACT_RECOVERED >/dev/null \
  || fail 'mission initialization failed'

test_original_prompt_and_event_identity() {
  local view="$TMP_ROOT/initial-view.json" replay="$TMP_ROOT/replay.json"
  mission show event-store > "$view" || fail 'materialized mission view could not be read'
  jq -e '.schema_version == 3 and .original_prompt.file == "data/missions/event-store/original-prompt.md" and (.original_prompt.sha256 | length == 64) and .original_prompt.source_transcript == "/tmp/session.jsonl" and .original_prompt.step_index == 42 and .original_prompt.classification == "EXACT_RECOVERED"' "$view" >/dev/null \
    || fail 'mission_created did not preserve the standard original-prompt provenance shape'
  mission append event-store --event-id phase-one --type phase_transition \
    --payload '{"phase":"implementation"}' >/dev/null \
    || fail 'event append failed'
  mission append event-store --event-id phase-one --type phase_transition \
    --payload '{"phase":"implementation"}' > "$replay" \
    || fail 'idempotent event replay failed'
  jq -e '.idempotent_replay == true' "$replay" >/dev/null \
    || fail 'duplicate event identity was not idempotent'
  [ "$(wc -l < "$HOME_DIR/data/missions/event-store/events.jsonl")" -eq 2 ] \
    || fail 'idempotent replay appended a second physical event'
  pass 'mission_created provenance, ordered records, and idempotent event identity round-trip'
}

test_delivery_state_points_to_meta() {
  fm_write_meta "$HOME_DIR/state/task-a.meta" \
    'base_sha=base-from-task-meta' 'target_branch=main' 'project=/repo' \
    'worktree=/repo-task-a'
  mission append event-store --event-id dispatch-task-a --type task_dispatched \
    --payload '{"task_id":"task-a","repo":"/repo","worktree":"/repo-task-a","branch":"fm/task-a"}' >/dev/null \
    || fail 'task dispatch event failed'
  mission append event-store --event-id delivery-task-a --type delivery_state_changed \
    --payload '{"task_id":"task-a","delivery_state":"VERIFIED_LANDED","evidence":{"commit_sha":"deadbeef"}}' >/dev/null \
    || fail 'delivery state event failed'
  jq -e '.tasks["task-a"].meta_pointer == "state/task-a.meta" and .tasks["task-a"].delivery_state == "VERIFIED_LANDED" and (.tasks["task-a"] | has("base_sha") | not) and (.tasks["task-a"] | has("target_branch") | not)' "$HOME_DIR/data/missions/event-store/mission.json" >/dev/null \
    || fail 'delivery state did not round-trip by task-meta pointer'
  [ -f "$HOME_DIR/$(jq -r '.tasks["task-a"].meta_pointer' "$HOME_DIR/data/missions/event-store/mission.json")" ] \
    || fail 'delivery state pointer does not resolve to the real task meta file'
  grep -F 'base_sha=base-from-task-meta' "$HOME_DIR/state/task-a.meta" >/dev/null \
    || fail 'real task meta fixture lost its base_sha owner'
  jq -s -e 'map(select(.type == "delivery_state_changed"))[0].payload | has("base_sha") | not' "$HOME_DIR/data/missions/event-store/events.jsonl" >/dev/null \
    || fail 'delivery event duplicated task-meta ownership fields'
  if mission append event-store --event-id hold-with-copy --type captain_hold_created \
    --payload '{"task_id":"task-a","hold_id":"hold-a","reason":"copied hold text"}' >/dev/null 2>&1; then
    fail 'captain hold event accepted copied backlog content'
  fi
  pass 'delivery_state round-trips through task_id without copying base_sha or target_branch'
}

test_torn_final_line_is_discarded() {
  local log="$HOME_DIR/data/missions/event-store/events.jsonl" err="$TMP_ROOT/torn.err" view="$TMP_ROOT/torn-view.json"
  printf '{"schema_version":1,"event_id":"torn-tail"' >> "$log"
  mission materialize event-store > "$view" 2> "$err" \
    || fail 'materializer rejected a discardable torn final line'
  assert_contains "$(cat "$err")" 'discarded malformed final event-log line' \
    'materializer did not report the torn final line'
  jq -e '.tasks["task-a"].delivery_state == "VERIFIED_LANDED" and .last_event.sequence == 4' "$view" >/dev/null \
    || fail 'materializer lost events before the torn final line'
  mission append event-store --event-id after-torn --type task_completed \
    --payload '{"task_id":"task-a"}' >/dev/null \
    || fail 'append did not recover past the torn tail'
  jq -s -e 'length == 5 and (map(.sequence) == [1,2,3,4,5])' "$log" >/dev/null \
    || fail 'recovered append did not preserve ordered valid events'
  pass 'materializer discards a torn final line and preserves prior events'
}

test_concurrent_writers_are_serialized() {
  local first_out="$TMP_ROOT/first.out" second_out="$TMP_ROOT/second.out" first_pid second_pid lock="$HOME_DIR/data/missions/event-store/.events.lock"
  FM_MISSION_LOCK_HOLD_SECS=1 mission append event-store --event-id concurrent-one \
    --type phase_transition --payload '{"phase":"one"}' > "$first_out" 2>&1 &
  first_pid=$!
  for _ in $(seq 1 50); do
    [ -e "$lock" ] && break
    sleep 0.02
  done
  [ -e "$lock" ] || fail 'first writer never acquired the mission lock'
  mission append event-store --event-id concurrent-two --type phase_transition \
    --payload '{"phase":"two"}' > "$second_out" 2>&1 &
  second_pid=$!
  wait "$first_pid" || fail "first concurrent writer failed: $(cat "$first_out")"
  wait "$second_pid" || fail "second concurrent writer failed: $(cat "$second_out")"
  jq -s -e 'map(.event_id) | .[-2:] == ["concurrent-one", "concurrent-two"]' "$HOME_DIR/data/missions/event-store/events.jsonl" >/dev/null \
    || fail 'concurrent writers did not serialize in event order'
  pass 'concurrent writers serialize through the per-mission event-log lock'
}

test_original_prompt_and_event_identity
test_delivery_state_points_to_meta
test_torn_final_line_is_discarded
test_concurrent_writers_are_serialized
