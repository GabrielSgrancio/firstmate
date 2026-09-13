#!/usr/bin/env bash
# Canonical supervisor replacement route hook.
#
# Usage:
#   fm-supervisor-route.sh <dead-harness> <mission-id> <capsule>
#
# The continuity service invokes this swappable hook with the dead harness,
# mission id, and durable capsule.  The hook calls Router V2, excludes every
# RouteTarget belonging to the dead harness, and prints exactly:
#   harness=<canonical harness>
#   command=<executable replacement command>
#
# FM_SUPERVISOR_ROUTE_ROLE and FM_SUPERVISOR_ROUTE_DATA_CLASS identify the
# supervisor route (defaults: general_engineer and PUBLIC).  Set
# FM_SUPERVISOR_ROUTE_EFFORT to preserve a requested effort when present.
# Provide FM_SUPERVISOR_COMMAND_<HARNESS> for each selectable harness, or use
# FM_SUPERVISOR_REPLACEMENT_COMMAND as one command that accepts the selected
# route through its environment.  The command must already be executable.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FM_HOME="${FM_HOME:-$ROOT}"
DEAD_HARNESS="${1-}"
MISSION_ID="${2-}"
CAPSULE="${3-}"
ROLE="${FM_SUPERVISOR_ROUTE_ROLE:-general_engineer}"
DATA_CLASS="${FM_SUPERVISOR_ROUTE_DATA_CLASS:-PUBLIC}"
EFFORT="${FM_SUPERVISOR_ROUTE_EFFORT:-}"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
valid_id() { case "${1-}" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac; }

[ "$#" -eq 3 ] || die 'usage: fm-supervisor-route.sh <dead-harness> <mission-id> <capsule>'
[ -n "$DEAD_HARNESS" ] || die 'dead harness is required'
valid_id "$MISSION_ID" || die 'invalid mission id'
[ -f "$CAPSULE" ] || die 'mission capsule is missing'
[ "$(FM_HOME="$FM_HOME" node -e 'const c=require(process.argv[1]); process.stdout.write(c.mission_id || "")' "$CAPSULE" 2>/dev/null)" = "$MISSION_ID" ] \
  || die 'mission capsule does not match mission id'

ROUTE_JSON=$(cd "$ROOT" && FM_HOME="$FM_HOME" node --input-type=module - \
  "$ROLE" "$DATA_CLASS" "$DEAD_HARNESS" "$EFFORT" <<'NODE'
import { loadConfigs, scoreAndSelectRoute } from './bin/fm-router-v2.mjs';

const [role, dataClass, deadHarnessRaw, effortRaw] = process.argv.slice(2);
const deadHarness = deadHarnessRaw === 'agy' ? 'antigravity' : deadHarnessRaw;
const { compiledRoutes } = loadConfigs();
const excludedRoutes = compiledRoutes
  .filter((route) => route.harness === deadHarness)
  .map((route) => route.route_id);
const targetEffort = ['low', 'medium', 'high', 'xhigh'].includes(effortRaw) ? effortRaw : null;
const decision = scoreAndSelectRoute({
  role,
  dataClass,
  targetEffort,
  excludeRoutes: excludedRoutes,
  useLiveAxi: process.env.FM_SUPERVISOR_USE_LIVE_QUOTA !== '0'
});
if (decision.selectedRoute.harness === deadHarness) {
  throw new Error(`Router V2 selected the dead harness "${deadHarness}"`);
}
console.error(`Router V2 excluded ${excludedRoutes.length} ${deadHarness} RouteTargets and selected route=${decision.selectedRoute.route_id} harness=${decision.selectedRoute.harness} scarcity=${decision.scarcityState}`);
console.log(JSON.stringify({ decision, excludedRoutes, deadHarness }));
NODE
) || die 'Router V2 returned no eligible supervisor replacement'

NEW_HARNESS=$(printf '%s\n' "$ROUTE_JSON" | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const r=JSON.parse(s); process.stdout.write(r.decision.selectedRoute.harness); })')

case "$NEW_HARNESS" in
  codex) COMMAND="${FM_SUPERVISOR_COMMAND_CODEX:-${FM_SUPERVISOR_REPLACEMENT_COMMAND:-}}" ;;
  claude) COMMAND="${FM_SUPERVISOR_COMMAND_CLAUDE:-${FM_SUPERVISOR_REPLACEMENT_COMMAND:-}}" ;;
  antigravity) COMMAND="${FM_SUPERVISOR_COMMAND_ANTIGRAVITY:-${FM_SUPERVISOR_REPLACEMENT_COMMAND:-}}" ;;
  opencode) COMMAND="${FM_SUPERVISOR_COMMAND_OPENCODE:-${FM_SUPERVISOR_REPLACEMENT_COMMAND:-}}" ;;
  *) COMMAND="${FM_SUPERVISOR_REPLACEMENT_COMMAND:-}" ;;
esac
[ -n "$COMMAND" ] || die "no replacement command configured for harness $NEW_HARNESS"
[ -x "$COMMAND" ] || die "replacement command is not executable: $COMMAND"

printf 'harness=%s\ncommand=%s\n' "$NEW_HARNESS" "$COMMAND"
