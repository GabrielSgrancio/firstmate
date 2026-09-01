#!/usr/bin/env bash
# Adapt Antigravity CLI's Stop hook payload and stdout decision contract to
# Firstmate's shared primary turn-end predicate.
#
# agy 1.1.23 invokes workspace-local hooks from the directory containing
# .agents/hooks.json and does not provide a stable workspace-root environment
# variable. The tracked hooks.json therefore reaches this file as ../bin/...
# and carries its own loud path-drift fallback.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/fm-turnend-guard.sh"

continue_fixed() {  # <JSON-safe fixed reason>
  printf '{"decision":"continue","reason":"%s"}\n' "$1"
  exit 0
}

command -v jq >/dev/null 2>&1 \
  || continue_fixed 'firstmate agy turn-end guard unavailable: jq is required. Repair the primary supervision hook before ending this turn.'
[ -x "$GUARD" ] \
  || continue_fixed 'firstmate agy turn-end guard unavailable: bin/fm-turnend-guard.sh is missing or not executable. Repair the primary supervision hook before ending this turn.'

PAYLOAD=$(cat 2>/dev/null || true)
EXECUTION_NUM=$(printf '%s' "$PAYLOAD" | jq -er '
  if type != "object" then error("payload")
  elif (.executionNum | type) != "number" or (.executionNum | floor) != .executionNum or .executionNum < 0 then error("executionNum")
  else .executionNum
  end
' 2>/dev/null) \
  || continue_fixed 'firstmate agy turn-end guard received an invalid Stop payload. Repair or reverify the agy hook before ending this turn.'

STOP_ACTIVE=false
[ "$EXECUTION_NUM" -eq 0 ] || STOP_ACTIVE=true
GUARD_PAYLOAD=$(jq -cn --argjson active "$STOP_ACTIVE" '{stop_hook_active:$active}') \
  || continue_fixed 'firstmate agy turn-end guard could not adapt the Stop payload. Repair the agy hook before ending this turn.'

GUARD_OUTPUT=$(printf '%s\n' "$GUARD_PAYLOAD" | "$GUARD" 2>&1)
GUARD_STATUS=$?
case "$GUARD_STATUS" in
  0)
    printf '%s\n' '{"decision":"allow"}'
    ;;
  2)
    jq -cn --arg reason "$GUARD_OUTPUT" '{decision:"continue",reason:$reason}'
    ;;
  *)
    jq -cn --arg status "$GUARD_STATUS" --arg detail "$GUARD_OUTPUT" \
      '{decision:"continue",reason:("firstmate agy turn-end guard failed with status " + $status + ". Repair primary supervision before ending this turn. " + $detail)}'
    ;;
esac

exit 0
