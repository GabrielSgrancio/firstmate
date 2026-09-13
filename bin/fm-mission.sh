#!/usr/bin/env bash
# Durable mission intent and resume capsule.
#
# Usage:
#   fm-mission.sh init <mission-id> [--intent <text>] [--prompt-file <path>]
#       [--task-graph-file <json>] [--next <action>]
#   fm-mission.sh session-start <mission-id> --harness <harness> [--session-id <id>]
#   fm-mission.sh session-end <mission-id> --reason <reason>
#   fm-mission.sh capsule <mission-id> [--next <action>]
#   fm-mission.sh show <mission-id>
#
# FM_HOME selects the private home; FM_DATA_OVERRIDE and FM_STATE_OVERRIDE are
# accepted for isolated tests and alternate home layouts.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-$FM_ROOT}"
DATA_DIR="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
STATE_DIR="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
MISSIONS_DIR="$DATA_DIR/missions"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
valid_id() { case "${1-}" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac; }
usage() { sed -n '2,/^set -u$/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }
mission_dir() { printf '%s/%s\n' "$MISSIONS_DIR" "$1"; }
mission_file() { printf '%s/mission.json\n' "$(mission_dir "$1")"; }

cmd_init() {
  local id="${1-}" intent='' prompt_file='' graph_file='' next_action='' arg
  if [ -z "$id" ] || ! valid_id "$id"; then die 'mission id must contain only letters, digits, dot, underscore, or dash'; fi
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --intent) [ "$#" -gt 1 ] || die '--intent requires a value'; intent="$2"; shift 2 ;;
      --prompt-file) [ "$#" -gt 1 ] || die '--prompt-file requires a path'; prompt_file="$2"; shift 2 ;;
      --task-graph-file) [ "$#" -gt 1 ] || die '--task-graph-file requires a JSON file'; graph_file="$2"; shift 2 ;;
      --next) [ "$#" -gt 1 ] || die '--next requires a value'; next_action="$2"; shift 2 ;;
      *) die "unknown init option: $arg" ;;
    esac
  done
  local dir pointer graph_json
  dir="$(mission_dir "$id")"
  mkdir -p "$dir" "$STATE_DIR" || die 'could not create mission directories'
  pointer="data/missions/$id/original-prompt.md"
  if [ -n "$prompt_file" ]; then
    [ -f "$prompt_file" ] || die "prompt file not found: $prompt_file"
    cp -- "$prompt_file" "$dir/original-prompt.md" || die 'could not preserve original prompt'
  elif [ ! -f "$dir/original-prompt.md" ]; then
    printf '# Mission %s\n\n%s\n' "$id" "${intent:-Pending mission intent}" >"$dir/original-prompt.md" || die 'could not create original prompt'
  fi
  graph_json='[]'
  if [ -n "$graph_file" ]; then
    [ -f "$graph_file" ] || die "task graph file not found: $graph_file"
    graph_json="$(cat -- "$graph_file")" || die 'could not read task graph'
  fi
  python3 - "$id" "$intent" "$pointer" "$graph_json" "$next_action" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(mission_file "$id")" <<'PY'
import json, os, sys, tempfile
mission_id, intent, pointer, graph_text, next_action, now, output = sys.argv[1:]
try:
    graph = json.loads(graph_text)
except json.JSONDecodeError as exc:
    raise SystemExit(f"invalid task graph JSON: {exc}")
if not isinstance(graph, (list, dict)):
    raise SystemExit("task graph must be a JSON array or object")
data = {"schema_version": 2, "mission_id": mission_id, "created_at": now,
        "updated_at": now, "status": "ACTIVE", "intent": intent or f"Mission {mission_id}",
        "original_prompt_pointer": pointer, "task_graph": graph,
        "next_action": next_action or "Continue the active mission",
        "current_session_id": None, "sessions": []}
os.makedirs(os.path.dirname(output), exist_ok=True)
fd, temp = tempfile.mkstemp(prefix=".mission-", dir=os.path.dirname(output), text=True)
os.fchmod(fd, 0o600)
with os.fdopen(fd, "w") as handle:
    json.dump(data, handle, indent=2); handle.write("\n")
os.replace(temp, output)
PY
  printf '%s\n' "$id" >"$STATE_DIR/.active-mission" || die 'could not publish active mission'
  cmd_capsule "$id" --next "$next_action"
}

cmd_session_start() {
  local id="${1-}" harness='' session_id='' arg
  if [ -z "$id" ] || ! valid_id "$id"; then die 'mission id is required'; fi
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --harness) [ "$#" -gt 1 ] || die '--harness requires a value'; harness="$2"; shift 2 ;;
      --session-id) [ "$#" -gt 1 ] || die '--session-id requires a value'; session_id="$2"; shift 2 ;;
      *) die "unknown session-start option: $arg" ;;
    esac
  done
  [ -n "$harness" ] || die '--harness is required'
  [ -n "$session_id" ] || session_id="session-$(date -u +%Y%m%dT%H%M%S)-${BASHPID:-$$}"
  local file
  file="$(mission_file "$id")"
  [ -f "$file" ] || die "mission not found: $id"
  python3 - "$file" "$harness" "$session_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" <<'PY'
import json, os, sys, tempfile
file, harness, session_id, now = sys.argv[1:]
with open(file) as handle:
    data = json.load(handle)
for item in data.get("sessions", []):
    if item.get("status") == "RUNNING":
        item.update(status="ENDED", ended_at=now, end_reason="SUPERSEDED")
item = {"session_id": session_id, "harness": harness, "started_at": now,
        "ended_at": None, "status": "RUNNING", "end_reason": None}
data.setdefault("sessions", []).append(item)
data["current_session_id"] = session_id
data["updated_at"] = now
fd, temp = tempfile.mkstemp(prefix=".mission-", dir=os.path.dirname(file), text=True)
os.fchmod(fd, 0o600)
with os.fdopen(fd, "w") as handle:
    json.dump(data, handle, indent=2); handle.write("\n")
os.replace(temp, file)
PY
  printf '%s\n' "$id" >"$STATE_DIR/.active-mission" || die 'could not publish active mission'
  cmd_capsule "$id"
}

cmd_session_end() {
  local id="${1-}" reason='' arg
  if [ -z "$id" ] || ! valid_id "$id"; then die 'mission id is required'; fi
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --reason) [ "$#" -gt 1 ] || die '--reason requires a value'; reason="$2"; shift 2 ;;
      *) die "unknown session-end option: $arg" ;;
    esac
  done
  [ -n "$reason" ] || die '--reason requires a non-empty value'
  local file
  file="$(mission_file "$id")"
  [ -f "$file" ] || die "mission not found: $id"
  python3 - "$file" "$reason" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" <<'PY'
import json, os, sys, tempfile
file, reason, now = sys.argv[1:]
with open(file) as handle:
    data = json.load(handle)
current = next((item for item in reversed(data.get("sessions", []))
                if item.get("status") == "RUNNING"), None)
if current is not None:
    current.update(status="ENDED", ended_at=now, end_reason=reason)
data["updated_at"] = now
fd, temp = tempfile.mkstemp(prefix=".mission-", dir=os.path.dirname(file), text=True)
os.fchmod(fd, 0o600)
with os.fdopen(fd, "w") as handle:
    json.dump(data, handle, indent=2); handle.write("\n")
os.replace(temp, file)
PY
  cmd_capsule "$id"
}

cmd_capsule() {
  local id="${1-}" next_action='' arg
  if [ -z "$id" ] || ! valid_id "$id"; then die 'mission id is required'; fi
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --next) [ "$#" -gt 1 ] || die '--next requires a value'; next_action="$2"; shift 2 ;;
      *) die "unknown capsule option: $arg" ;;
    esac
  done
  local file dir
  file="$(mission_file "$id")"
  dir="$(mission_dir "$id")"
  [ -f "$file" ] || die "mission not found: $id"
  python3 - "$file" "$dir/capsule.json" "$STATE_DIR/mission-capsule.json" "$next_action" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" <<'PY'
import json, os, sys, tempfile
file, mission_output, state_output, next_action, now = sys.argv[1:]
with open(file) as handle:
    data = json.load(handle)
if next_action:
    data["next_action"] = next_action
    data["updated_at"] = now
    fd, temp = tempfile.mkstemp(prefix=".mission-", dir=os.path.dirname(file), text=True)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(data, handle, indent=2); handle.write("\n")
    os.replace(temp, file)
capsule = {"schema_version": 2, "mission_id": data["mission_id"], "intent": data["intent"],
           "original_prompt_pointer": data["original_prompt_pointer"],
           "task_graph": data.get("task_graph", []), "next_action": data.get("next_action"),
           "active_session": next((item for item in reversed(data.get("sessions", []))
                                   if item.get("status") == "RUNNING"), None),
           "sessions_history": data.get("sessions", []),
           "updated_at": data.get("updated_at", now)}
for output in (mission_output, state_output):
    os.makedirs(os.path.dirname(output), exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".capsule-", dir=os.path.dirname(output), text=True)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(capsule, handle, indent=2); handle.write("\n")
    os.replace(temp, output)
PY
}

cmd_show() {
  local id="${1-}" file
  if [ -z "$id" ] || ! valid_id "$id"; then die 'mission id is required'; fi
  file="$(mission_dir "$id")/capsule.json"
  [ -f "$file" ] || die "capsule not found: $id"
  python3 - "$file" <<'PY'
import json, sys
with open(sys.argv[1]) as handle:
    print(json.dumps(json.load(handle), indent=2))
PY
}

case "${1-}" in
  init) shift; cmd_init "$@" ;;
  session-start) shift; cmd_session_start "$@" ;;
  session-end) shift; cmd_session_end "$@" ;;
  capsule) shift; cmd_capsule "$@" ;;
  show) shift; cmd_show "$@" ;;
  ''|-h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
