#!/usr/bin/env bash
# Portable behavior coverage for agy's Stop adapter and the tracked hook command.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TMP_ROOT=$(fm_test_tmproot fm-agy-turnend-guard)
ADAPTER="$ROOT/bin/fm-agy-turnend-guard.sh"
HOOKS="$ROOT/.agents/hooks.json"
LAB="$TMP_ROOT/primary"
STATE="$LAB/state"

mkdir -p "$LAB/bin" "$STATE" "$LAB/config"
git -C "$LAB" init -q
cp "$ROOT/AGENTS.md" "$LAB/AGENTS.md"
printf 'harness=antigravity\n' > "$STATE/live.meta"

run_adapter() {  # <payload>
  printf '%s\n' "$1" | FM_ROOT_OVERRIDE="$LAB" FM_HOME="$LAB" \
    FM_STATE_OVERRIDE="$STATE" FM_CONFIG_OVERRIDE="$LAB/config" "$ADAPTER"
}

test_initial_stop_forces_one_continuation() {
  local out
  out=$(run_adapter '{"executionNum":0,"fullyIdle":true,"modelName":"gemini-3.7-flash-low","workspacePaths":["/tmp/work"]}')
  [ "$(printf '%s' "$out" | jq -r '.decision')" = continue ] \
    || fail "agy initial Stop did not map shared guard status 2 to decision=continue: $out"
  printf '%s' "$out" | jq -er '.reason | contains("TURN WOULD END BLIND")' >/dev/null \
    || fail "agy continuation omitted the shared guard's actionable reason"
  pass "agy initial Stop maps the shared blind-turn predicate to one continuation"
}

test_followup_stop_is_loop_bounded() {
  local out
  out=$(run_adapter '{"executionNum":1,"fullyIdle":true,"modelName":"gemini-3.7-flash-low","workspacePaths":["/tmp/work"]}')
  [ "$(printf '%s' "$out" | jq -r '.decision')" = allow ] \
    || fail "agy executionNum=1 did not map to the shared loop guard: $out"
  pass "agy executionNum bounds the Stop continuation to one follow-up"
}

test_invalid_payload_fails_loudly_inside_agy_contract() {
  local out
  out=$(run_adapter '{"executionNum":"zero"}')
  [ "$(printf '%s' "$out" | jq -r '.decision')" = continue ] \
    || fail "an invalid agy payload did not stay inside the decision contract: $out"
  printf '%s' "$out" | jq -er '.reason | contains("invalid Stop payload") and contains("agy")' >/dev/null \
    || fail "an invalid agy payload did not name the harness and repair"
  pass "invalid agy Stop payloads fail loudly without relying on swallowed hook exit status"
}

test_tracked_hook_command_executes_adapter_from_real_hook_cwd() {
  local command out
  command=$(jq -er '."firstmate-primary-supervision".Stop[0].command' "$HOOKS") \
    || fail "could not read the tracked agy Stop command"
  out=$(cd "$ROOT/.agents" && printf '%s\n' '{"executionNum":0,"fullyIdle":true}' \
    | FM_ROOT_OVERRIDE="$LAB" FM_HOME="$LAB" FM_STATE_OVERRIDE="$STATE" \
      FM_CONFIG_OVERRIDE="$LAB/config" /bin/sh -c "$command")
  [ "$(printf '%s' "$out" | jq -r '.decision')" = continue ] \
    || fail "the tracked command registered but did not execute the adapter from agy's hook cwd: $out"
  printf '%s' "$out" | jq -er '.reason | contains("TURN WOULD END BLIND")' >/dev/null \
    || fail "the tracked command did not reach the executable shared predicate"
  pass "tracked .agents/hooks.json executes the adapter from agy's real hook working directory"
}

test_initial_stop_forces_one_continuation
test_followup_stop_is_loop_bounded
test_invalid_payload_fails_loudly_inside_agy_contract
test_tracked_hook_command_executes_adapter_from_real_hook_cwd
