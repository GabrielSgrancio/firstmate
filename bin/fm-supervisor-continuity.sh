#!/usr/bin/env bash
# Outer supervisor continuity service.
#
# Usage:
#   fm-supervisor-continuity.sh install
#   fm-supervisor-continuity.sh run
#   fm-supervisor-continuity.sh status
#   fm-supervisor-continuity.sh record-supervisor <mission-id> <pid> <harness> <session-id>
#   fm-supervisor-continuity.sh mark-failed <mission-id> <reason>
#
# The foreground run command is intended to be ExecStart for the generated
# systemd --user unit. It never relies on a supervisor or harness process.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-$FM_ROOT}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
MISSION="$SCRIPT_DIR/fm-mission.sh"
WATCH="$SCRIPT_DIR/fm-watch.sh"
SERVICE_NAME=firstmate-supervisor-continuity.service
LEASE="$STATE/.supervisor-continuity-lease"
REPLACEMENT="$STATE/supervisor-continuity-replacement.json"
EVENTS="$STATE/supervisor-continuity.jsonl"
LOCK="$STATE/.supervisor-continuity.lock"
WATCHER_PID_FILE="$STATE/.supervisor-continuity-watcher.pid"
INTERVAL="${FM_SUPERVISOR_CONTINUITY_INTERVAL:-5}"
WATCHER_GRACE="${FM_SUPERVISOR_CONTINUITY_WATCHER_GRACE:-300}"
ROUTE_COMMAND="${FM_SUPERVISOR_ROUTE_COMMAND:-$SCRIPT_DIR/fm-supervisor-route.sh}"
ROUTE_ROLE="${FM_SUPERVISOR_ROUTE_ROLE:-general_engineer}"
ROUTE_DATA_CLASS="${FM_SUPERVISOR_ROUTE_DATA_CLASS:-PUBLIC}"
ROUTE_EFFORT="${FM_SUPERVISOR_ROUTE_EFFORT:-}"
USE_LIVE_QUOTA="${FM_SUPERVISOR_USE_LIVE_QUOTA:-1}"
COMMAND_CODEX="${FM_SUPERVISOR_COMMAND_CODEX:-}"
COMMAND_CLAUDE="${FM_SUPERVISOR_COMMAND_CLAUDE:-}"
COMMAND_ANTIGRAVITY="${FM_SUPERVISOR_COMMAND_ANTIGRAVITY:-}"
COMMAND_OPENCODE="${FM_SUPERVISOR_COMMAND_OPENCODE:-}"
REPLACEMENT_COMMAND="${FM_SUPERVISOR_REPLACEMENT_COMMAND:-}"
die() { printf 'error: %s\n' "$1" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$STATE/.supervisor-continuity.log"; }
valid_id() { case "${1-}" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac; }
whole_number() { case "${1-}" in ''|*[!0-9]*) return 1 ;; esac; }
pid_identity() {
  local pid="${1-}" stat_line
  if [ -r "/proc/$pid/stat" ]; then
    stat_line=$(cat "/proc/$pid/stat" 2>/dev/null || true)
    printf '%s\n' "$stat_line" | awk '{print $22}'
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    ps -p "$pid" -o lstart= 2>/dev/null | sha256sum | awk '{print $1}'
  else
    ps -p "$pid" -o lstart= 2>/dev/null | shasum -a 256 | awk '{print $1}'
  fi
}
pid_alive() {
  local pid="${1-}" state
  whole_number "$pid" || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  state=$(ps -p "$pid" -o stat= 2>/dev/null | tr -d '[:space:]' || true)
  [ -n "$state" ] && [ "${state#Z}" = "$state" ]
}
field() { awk -F= -v key="$2" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$1" 2>/dev/null; }

write_lease() {
  local mission_id="$1" pid="$2" harness="$3" session_id="$4" failure="${5-}" identity tmp
  identity=$(pid_identity "$pid")
  [ -n "$identity" ] || return 1
  tmp=$(mktemp "$STATE/.supervisor-lease.XXXXXX") || return 1
  {
    printf 'schema=1\nmission_id=%s\nsupervisor_pid=%s\nsupervisor_identity=%s\nharness=%s\nsession_id=%s\nstatus=%s\nheartbeat=%s\n' \
      "$mission_id" "$pid" "$identity" "$harness" "$session_id" "RUNNING" "$(date +%s)"
    [ -n "$failure" ] && printf 'failure=%s\n' "$failure"
  } >"$tmp"
  chmod 600 "$tmp" && mv -f -- "$tmp" "$LEASE"
}

cmd_record_supervisor() {
  local mission_id="${1-}" pid="${2-}" harness="${3-}" session_id="${4-}"
  valid_id "$mission_id" || die 'invalid mission id'
  if ! whole_number "$pid" || ! pid_alive "$pid"; then die 'supervisor pid is not a live process'; fi
  [ -n "$harness" ] && [ -n "$session_id" ] || die 'harness and session id are required'
  [ -f "$DATA/missions/$mission_id/capsule.json" ] || die 'mission capsule is missing'
  mkdir -p "$STATE" || die 'could not create state directory'
  write_lease "$mission_id" "$pid" "$harness" "$session_id" || die 'could not publish supervisor lease'
  printf 'supervisor lease recorded: mission=%s pid=%s harness=%s session=%s\n' "$mission_id" "$pid" "$harness" "$session_id"
}

cmd_mark_failed() {
  local mission_id="${1-}" reason="${2-}" pid harness session_id
  valid_id "$mission_id" || die 'invalid mission id'
  [ -n "$reason" ] || die 'failure reason is required'
  [ -f "$LEASE" ] || die 'supervisor lease is missing'
  [ "$(field "$LEASE" mission_id)" = "$mission_id" ] || die 'supervisor lease belongs to another mission'
  pid=$(field "$LEASE" supervisor_pid)
  harness=$(field "$LEASE" harness)
  session_id=$(field "$LEASE" session_id)
  write_lease "$mission_id" "$pid" "$harness" "$session_id" "$reason" || die 'could not publish failure lease'
  printf 'supervisor failure recorded: mission=%s reason=%s\n' "$mission_id" "$reason"
}

watcher_healthy() {
  local pid beat age
  pid=$(cat "$STATE/.watch.lock/pid" 2>/dev/null || true)
  beat="$STATE/.last-watcher-beat"
  pid_alive "$pid" || return 1
  [ -f "$beat" ] || return 1
  age=$(( $(date +%s) - $(stat -c %Y "$beat" 2>/dev/null || stat -f %m "$beat" 2>/dev/null || printf 0) ))
  [ "$age" -le "$WATCHER_GRACE" ]
}
ensure_watcher() {
  local pid lock_pid
  watcher_healthy && return 0
  pid=$(cat "$WATCHER_PID_FILE" 2>/dev/null || true)
  lock_pid=$(cat "$STATE/.watch.lock/pid" 2>/dev/null || true)
  if pid_alive "$pid" && [ ! -e "$STATE/.last-watcher-beat" ]; then
    return 0
  fi
  if [ -n "$pid" ] && [ "$pid" = "$lock_pid" ] && pid_alive "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
  if pid_alive "$pid"; then
    return 0
  fi
  setsid env FM_HOME="$FM_HOME" FM_ROOT_OVERRIDE="$FM_ROOT" FM_STATE_OVERRIDE="$STATE" \
    FM_WATCH_HANDLING_SUCCESSOR=1 \
    "$WATCH" >>"$STATE/.supervisor-continuity-watcher.log" 2>&1 </dev/null &
  pid=$!
  printf '%s\n' "$pid" >"$WATCHER_PID_FILE"
  log "started independent FirstMate watcher pid=$pid"
}

replacement_healthy() {
  local mission_id pid
  [ -f "$REPLACEMENT" ] || return 1
  mission_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("mission_id",""))' "$REPLACEMENT" 2>/dev/null || true)
  pid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid",""))' "$REPLACEMENT" 2>/dev/null || true)
  [ -n "$mission_id" ] && pid_alive "$pid"
}

record_replacement() {
  local capsule="$1" mission_id="$2" pid="$3" identity="$4" harness="$5" session_id="$6" command="$7" now="$8"
  python3 - "$capsule" "$REPLACEMENT" "$mission_id" "$pid" "$identity" "$harness" "$session_id" "$command" "$now" <<'PY'
import json, os, sys, tempfile
capsule_file, output, mission_id, pid, identity, harness, session_id, command, now = sys.argv[1:]
with open(capsule_file) as handle:
    capsule = json.load(handle)
record = {
    "schema_version": 1, "mission_id": mission_id, "pid": int(pid),
    "identity": identity, "harness": harness, "session_id": session_id,
    "command": command, "started_at": now,
    "original_prompt_pointer": capsule["original_prompt_pointer"],
    "task_graph": capsule["task_graph"], "next_action": capsule["next_action"],
}
fd, temp = tempfile.mkstemp(prefix=".replacement-", dir=os.path.dirname(output), text=True)
os.fchmod(fd, 0o600)
with os.fdopen(fd, "w") as handle:
    json.dump(record, handle, indent=2); handle.write("\n")
os.replace(temp, output)
PY
}

route_replacement() {
  local old_harness="$1" mission_id="$2" capsule="$3" output
  [ -n "$ROUTE_COMMAND" ] && [ -x "$ROUTE_COMMAND" ] || {
    log "replacement route unavailable: $ROUTE_COMMAND"
    return 1
  }
  output=$("$ROUTE_COMMAND" "$old_harness" "$mission_id" "$capsule" 2>>"$STATE/.supervisor-continuity.log") || return 1
  printf '%s\n' "$output"
}

failover_once() {
  local mission_id="$1" old_harness capsule route new_harness command session_id now pid identity
  capsule="$DATA/missions/$mission_id/capsule.json"
  [ -f "$capsule" ] || { log "failover refused: mission capsule missing for $mission_id"; return 1; }
  old_harness=$(field "$LEASE" harness)
  route=$(route_replacement "$old_harness" "$mission_id" "$capsule") || return 1
  new_harness=$(printf '%s\n' "$route" | sed -n 's/^harness=//p' | tail -1)
  command=$(printf '%s\n' "$route" | sed -n 's/^command=//p' | tail -1)
  [ -n "$new_harness" ] && [ -n "$command" ] && [ "$new_harness" != "$old_harness" ] && [ -x "$command" ] || {
    log "failover refused: route must provide a different executable harness"
    return 1
  }
  session_id="session-$(date -u +%Y%m%dT%H%M%S)-$(basename "$new_harness")-${BASHPID:-$$}"
  FM_HOME="$FM_HOME" FM_DATA_OVERRIDE="$DATA" FM_STATE_OVERRIDE="$STATE" \
    "$MISSION" session-end "$mission_id" --reason "SUPERVISOR_FAILOVER:$old_harness" >/dev/null || return 1
  FM_HOME="$FM_HOME" FM_DATA_OVERRIDE="$DATA" FM_STATE_OVERRIDE="$STATE" \
    "$MISSION" session-start "$mission_id" --harness "$new_harness" --session-id "$session_id" >/dev/null || return 1
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  env FM_HOME="$FM_HOME" FM_ROOT_OVERRIDE="$FM_ROOT" FM_SUPERVISOR_SESSION_ID="$session_id" \
    setsid "$command" </dev/null >>"$STATE/.supervisor-replacement.log" 2>&1 &
  pid=$!
  identity=$(pid_identity "$pid") || return 1
  record_replacement "$capsule" "$mission_id" "$pid" "$identity" "$new_harness" "$session_id" "$command" "$now" || return 1
  printf 'failover=%s\tfrom=%s\tto=%s\tpid=%s\tmission=%s\n' "$now" "$old_harness" "$new_harness" "$pid" "$mission_id" >>"$EVENTS"
  log "started replacement pid=$pid harness=$new_harness mission=$mission_id"
}

run_loop() {
  local mission_id pid identity lease_identity failure
  mkdir -p "$STATE" || die 'could not create state directory'
  exec 9>"$LOCK" || die 'could not open continuity lock'
  flock -n 9 || die 'another continuity service owns this home'
  while :; do
    ensure_watcher
    mission_id=$(cat "$STATE/.active-mission" 2>/dev/null || true)
    if valid_id "$mission_id" && [ -f "$LEASE" ]; then
      if replacement_healthy; then
        :
      else
        pid=$(field "$LEASE" supervisor_pid)
        identity=$(field "$LEASE" supervisor_identity)
        lease_identity=$(pid_identity "$pid" 2>/dev/null || true)
        failure=$(field "$LEASE" failure)
        if [ -n "$failure" ] || ! pid_alive "$pid" || [ "$lease_identity" != "$identity" ]; then
          if ! failover_once "$mission_id"; then
            log "failover pending for mission=$mission_id"
          fi
        fi
      fi
    fi
    sleep "$INTERVAL"
  done
}

install_service() {
  local config_dir unit_dir unit tmp
  command -v systemctl >/dev/null 2>&1 || die 'systemctl is unavailable'
  systemctl --user show-environment >/dev/null 2>&1 || die 'systemd --user manager is unavailable'
  [ -n "$ROUTE_COMMAND" ] && [ -x "$ROUTE_COMMAND" ] || die 'FM_SUPERVISOR_ROUTE_COMMAND must name an executable route dispatcher'
  config_dir="${XDG_CONFIG_HOME:-$HOME/.config}"
  unit_dir="$config_dir/systemd/user"
  unit="$unit_dir/$SERVICE_NAME"
  mkdir -p "$unit_dir" || die 'could not create user unit directory'
  tmp=$(mktemp "$unit_dir/.continuity.XXXXXX") || die 'could not create unit temporary file'
  {
    printf '[Unit]\nDescription=FirstMate supervisor continuity\nAfter=default.target\n\n[Service]\nType=simple\nEnvironment=FM_HOME=%s\nEnvironment=FM_ROOT_OVERRIDE=%s\nEnvironment=FM_SUPERVISOR_ROUTE_COMMAND=%s\nEnvironment=FM_SUPERVISOR_ROUTE_ROLE=%s\nEnvironment=FM_SUPERVISOR_ROUTE_DATA_CLASS=%s\nEnvironment=FM_SUPERVISOR_ROUTE_EFFORT=%s\nEnvironment=FM_SUPERVISOR_USE_LIVE_QUOTA=%s\nEnvironment=FM_SUPERVISOR_COMMAND_CODEX=%s\nEnvironment=FM_SUPERVISOR_COMMAND_CLAUDE=%s\nEnvironment=FM_SUPERVISOR_COMMAND_ANTIGRAVITY=%s\nEnvironment=FM_SUPERVISOR_COMMAND_OPENCODE=%s\nEnvironment=FM_SUPERVISOR_REPLACEMENT_COMMAND=%s\nExecStart=%s run\nRestart=always\nRestartSec=2\nKillMode=process\n\n[Install]\nWantedBy=default.target\n' \
      "$FM_HOME" "$FM_ROOT" "$ROUTE_COMMAND" "$ROUTE_ROLE" "$ROUTE_DATA_CLASS" "$ROUTE_EFFORT" "$USE_LIVE_QUOTA" \
      "$COMMAND_CODEX" "$COMMAND_CLAUDE" "$COMMAND_ANTIGRAVITY" "$COMMAND_OPENCODE" "$REPLACEMENT_COMMAND" \
      "$SCRIPT_DIR/fm-supervisor-continuity.sh"
  } >"$tmp"
  if ! chmod 600 "$tmp" || ! mv -f -- "$tmp" "$unit"; then die 'could not publish user unit'; fi
  systemctl --user daemon-reload || die 'systemd user daemon reload failed'
  systemctl --user enable --now "$SERVICE_NAME" || die 'could not enable continuity service'
  printf 'installed and started %s\n' "$unit"
}

service_status() {
  command -v systemctl >/dev/null 2>&1 || die 'systemctl is unavailable'
  systemctl --user --no-pager status "$SERVICE_NAME"
}

case "${1-}" in
  install) install_service ;;
  run) run_loop ;;
  status) service_status ;;
  record-supervisor) shift; cmd_record_supervisor "$@" ;;
  mark-failed) shift; cmd_mark_failed "$@" ;;
  ''|-h|--help|help) sed -n '2,/^set -u$/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//' ;;
  *) die "unknown command: ${1-}" ;;
esac
