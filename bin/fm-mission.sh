#!/usr/bin/env bash
# Canonical per-mission event store and derived resume views.
#
# Usage:
#   fm-mission.sh init <mission-id> [--intent <text>] [--prompt-file <path>]
#       [--task-graph-file <json>] [--next <action>]
#       [--prompt-source-transcript <path>] [--prompt-step-index <n>]
#       [--prompt-classification <EXACT_RECOVERED|RECONSTRUCTED|SUMMARIZED>]
#   fm-mission.sh append <mission-id> --event-id <id> --type <type>
#       [--payload <json> | --payload-file <path>] [--occurred-at <timestamp>]
#   fm-mission.sh session-start <mission-id> --harness <harness>
#       [--session-id <id>]
#   fm-mission.sh session-end <mission-id> --reason <reason>
#   fm-mission.sh materialize <mission-id>
#   fm-mission.sh show <mission-id>
#   fm-mission.sh capsule <mission-id> [--next <action>]
#   fm-mission.sh active
#   fm-mission.sh resume-context <mission-id>
#
# FM_HOME selects the private home; FM_DATA_OVERRIDE and FM_STATE_OVERRIDE are
# accepted for isolated tests and alternate home layouts.
#
# The event log and materialized view use the existing tempfile.mkstemp +
# os.replace primitive below. The per-mission lock uses the same lock owner and
# stale-holder recovery as state/.wake-queue.lock in fm-wake-lib.sh.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-$FM_ROOT}"
DATA_DIR="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
STATE_DIR="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
MISSIONS_DIR="$DATA_DIR/missions"
# shellcheck disable=SC2034
STATE="$STATE_DIR"
# shellcheck source=bin/fm-wake-lib.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/fm-wake-lib.sh"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
valid_id() { case "${1-}" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac; }
usage() { sed -n '2,/^set -u$/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }
mission_dir() { printf '%s/%s\n' "$MISSIONS_DIR" "$1"; }

MISSION_LOCK=
release_mission_lock() {
  [ -n "$MISSION_LOCK" ] || return 0
  fm_lock_release "$MISSION_LOCK" || true
  MISSION_LOCK=
}

acquire_mission_lock() {
  local id=$1 rc=0 timeout=${FM_MISSION_LOCK_TIMEOUT:-10}
  MISSION_LOCK="$(mission_dir "$id")/.events.lock"
  fm_lock_acquire_wait_bounded "$MISSION_LOCK" "$timeout" || rc=$?
  [ "$rc" -eq 0 ] || {
    if [ "$rc" -eq 124 ]; then
      die "mission event log is locked${FM_LOCK_HELD_PID:+ by pid $FM_LOCK_HELD_PID}"
    fi
    die 'could not acquire mission event-log lock'
  }
  trap 'release_mission_lock' EXIT
  if [ -n "${FM_MISSION_LOCK_HOLD_SECS:-}" ]; then
    sleep "$FM_MISSION_LOCK_HOLD_SECS"
  fi
}

run_store() {
  python3 - "$MISSIONS_DIR" "$STATE_DIR" "$SCRIPT_DIR" "$@" <<'PY'
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

missions_dir, state_dir, script_dir, operation = sys.argv[1:5]
args = sys.argv[5:]
EVENT_SCHEMA_VERSION = 1
VIEW_SCHEMA_VERSION = 3
VALID_DELIVERY_STATES = {"EXECUTION_DONE", "DELIVERY_READY", "LANDED", "VERIFIED_LANDED"}
VALID_TYPES = {
    "mission_created", "session_started", "session_ended", "task_dispatched",
    "task_blocked", "task_completed", "captain_hold_created",
    "captain_hold_resolved", "worktree_created", "commit_produced",
    "delivery_state_changed", "phase_transition", "supervisor_handoff",
    "supervisor_termination", "reconciliation_correction",
}
FORBIDDEN_META_FIELDS = {"base_sha", "target_branch"}
ID_RE = re.compile(r"^[A-Za-z0-9._:-]+$")


class StoreError(Exception):
    pass


def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def atomic_write(path, data, mode=0o600):
    """The fm-mission atomic-write primitive: tempfile.mkstemp + os.replace."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="." + os.path.basename(path) + ".", dir=directory)
    try:
        os.fchmod(fd, mode)
        if isinstance(data, bytes):
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
        else:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(data)
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def mission_path(mission_id):
    return os.path.join(missions_dir, mission_id)


def log_path(mission_id):
    return os.path.join(mission_path(mission_id), "events.jsonl")


def view_path(mission_id):
    return os.path.join(mission_path(mission_id), "mission.json")


def cursor_path(mission_id):
    return os.path.join(mission_path(mission_id), ".materializer.cursor")


def capsule_path(mission_id):
    return os.path.join(mission_path(mission_id), "capsule.json")


def require_mission_id(mission_id):
    if not re.fullmatch(r"[A-Za-z0-9._-]+", mission_id or "") or mission_id.startswith("-"):
        raise StoreError("invalid mission id")


def require_event_id(event_id):
    if not ID_RE.fullmatch(event_id or ""):
        raise StoreError("event id must contain only letters, digits, dot, underscore, colon, or dash")


def validate_no_meta_duplication(value):
    if isinstance(value, dict):
        forbidden = FORBIDDEN_META_FIELDS.intersection(value)
        if forbidden:
            raise StoreError("mission events must reference task .meta by task_id, not duplicate " + ", ".join(sorted(forbidden)))
        for child in value.values():
            validate_no_meta_duplication(child)
    elif isinstance(value, list):
        for child in value:
            validate_no_meta_duplication(child)


def validate_event_type(event_type):
    if event_type not in VALID_TYPES:
        raise StoreError("unsupported mission event type: " + event_type)


def validate_payload(event_type, payload):
    validate_no_meta_duplication(payload)
    if event_type in {"captain_hold_created", "captain_hold_resolved"}:
        if {"reason", "resolution", "text"}.intersection(payload):
            raise StoreError("captain hold events must reference backlog content by pointer, not copy it")
    if event_type == "delivery_state_changed" and payload.get("delivery_state") not in VALID_DELIVERY_STATES:
        raise StoreError("delivery_state_changed requires one of the four delivery states")


def parse_json(text, label):
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise StoreError("invalid " + label + " JSON: " + str(exc)) from exc
    if not isinstance(value, dict):
        raise StoreError(label + " must be a JSON object")
    return value


def validate_record(record, offset):
    if not isinstance(record, dict):
        raise StoreError("event at byte %d is not an object" % offset)
    if record.get("schema_version") != EVENT_SCHEMA_VERSION:
        raise StoreError("event at byte %d has unsupported schema version" % offset)
    for key in ("event_id", "sequence", "occurred_at", "type", "payload"):
        if key not in record:
            raise StoreError("event at byte %d is missing %s" % (offset, key))
    require_event_id(record["event_id"])
    if not isinstance(record["sequence"], int) or record["sequence"] < 1:
        raise StoreError("event at byte %d has an invalid sequence" % offset)
    validate_event_type(record["type"])
    if not isinstance(record["payload"], dict):
        raise StoreError("event at byte %d has a non-object payload" % offset)
    validate_payload(record["type"], record["payload"])


def read_records(path):
    """Return complete records, the valid byte prefix, and a torn-tail flag."""
    if not os.path.exists(path):
        return [], b"", False
    with open(path, "rb") as handle:
        raw = handle.read()
    records = []
    valid_end = 0
    for line in raw.splitlines(keepends=True):
        start = valid_end
        valid_end += len(line)
        if not line.endswith(b"\n"):
            return records, raw[:start], True
        try:
            record = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            if valid_end == len(raw):
                return records, raw[:start], True
            raise StoreError("malformed non-final event-log line at byte " + str(start))
        validate_record(record, start)
        records.append(record)
    return records, raw[:valid_end], False


def validate_order(records):
    seen = {}
    for expected, record in enumerate(records, 1):
        if record["sequence"] != expected:
            raise StoreError("event sequence is not contiguous at %d" % record["sequence"])
        prior = seen.get(record["event_id"])
        if prior is not None and prior != record:
            raise StoreError("event id is reused with different content: " + record["event_id"])
        seen[record["event_id"]] = record


def load_log(mission_id):
    records, prefix, torn = read_records(log_path(mission_id))
    validate_order(records)
    return records, prefix, torn


def new_view(mission_id):
    return {
        "schema_version": VIEW_SCHEMA_VERSION, "mission_id": mission_id,
        "created_at": None, "updated_at": None, "status": "ACTIVE",
        "intent": None, "original_prompt": None, "task_graph": [],
        "next_action": "Continue the active mission", "current_session_id": None,
        "sessions": [], "tasks": {}, "captain_holds": {}, "worktrees": [],
        "phases": [], "supervisor_handoffs": [], "supervisor_termination": None,
        "reconciliations": [],
        "last_event": None,
    }


def task_for(view, payload):
    task_id = payload.get("task_id")
    if not isinstance(task_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]+", task_id):
        raise StoreError("task event requires a valid task_id")
    return view["tasks"].setdefault(task_id, {
        "task_id": task_id, "meta_pointer": "state/" + task_id + ".meta",
        "delivery_state": None, "delivery_history": [], "worktree": None,
        "branch": None, "repo": None, "harness": None, "commits": [],
        "blocked": False, "completed": False, "last_event": None,
    })


def apply_event(view, record):
    event_type = record["type"]
    payload = record["payload"]
    event_ref = {key: record[key] for key in ("event_id", "sequence", "type", "occurred_at")}
    if event_type == "mission_created":
        if view["created_at"] is not None:
            raise StoreError("mission_created may occur only once")
        view["created_at"] = record["occurred_at"]
        view["intent"] = payload["intent"]
        view["original_prompt"] = copy.deepcopy(payload["original_prompt"])
        view["task_graph"] = copy.deepcopy(payload.get("task_graph", []))
        view["next_action"] = payload.get("next_action") or view["next_action"]
    elif event_type == "session_started":
        for session in view["sessions"]:
            if session["status"] == "RUNNING":
                session.update(status="ENDED", ended_at=record["occurred_at"], end_reason="SUPERSEDED")
        session = {"session_id": payload["session_id"], "harness": payload["harness"],
                   "started_at": record["occurred_at"], "ended_at": None,
                   "status": "RUNNING", "end_reason": None}
        view["sessions"].append(session)
        view["current_session_id"] = payload["session_id"]
    elif event_type == "session_ended":
        session_id = payload.get("session_id") or view.get("current_session_id")
        for session in reversed(view["sessions"]):
            if session["session_id"] == session_id and session["status"] == "RUNNING":
                session.update(status="ENDED", ended_at=record["occurred_at"], end_reason=payload["reason"])
                break
        else:
            raise StoreError("session-ended event does not identify a running session")
        view["current_session_id"] = None
    elif event_type in {"task_dispatched", "task_blocked", "task_completed", "delivery_state_changed"}:
        task = task_for(view, payload)
        if event_type == "task_dispatched":
            for field in ("repo", "worktree", "branch", "harness"):
                if field in payload:
                    task[field] = payload[field]
        elif event_type == "task_blocked":
            task["blocked"] = True
        elif event_type == "task_completed":
            task["completed"] = True
        else:
            state = payload["delivery_state"]
            task["delivery_state"] = state
            task["delivery_history"].append({
                "delivery_state": state, "event": event_ref,
                "evidence": copy.deepcopy(payload.get("evidence", {})),
            })
        task["last_event"] = event_ref
    elif event_type in {"captain_hold_created", "captain_hold_resolved"}:
        task_id = payload.get("task_id")
        if not isinstance(task_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]+", task_id):
            raise StoreError("captain hold event requires a valid task_id")
        hold_id = payload.get("hold_id", task_id + "-captain-hold")
        if not isinstance(hold_id, str) or not ID_RE.fullmatch(hold_id):
            raise StoreError("captain hold event requires a valid hold_id")
        hold = view["captain_holds"].setdefault(hold_id, {
            "hold_id": hold_id, "task_id": task_id,
            "backlog_pointer": payload.get("backlog_pointer", "data/backlog.md#" + task_id),
            "status": "OPEN",
        })
        hold["status"] = "OPEN" if event_type.endswith("created") else "RESOLVED"
    elif event_type == "worktree_created":
        item = copy.deepcopy(payload); item["event"] = event_ref
        view["worktrees"].append(item)
    elif event_type == "commit_produced":
        task = task_for(view, payload)
        commit = {key: payload[key] for key in ("sha", "message", "authored_at") if key in payload}
        commit["event"] = event_ref
        task["commits"].append(commit); task["last_event"] = event_ref
    elif event_type == "phase_transition":
        phase = copy.deepcopy(payload); phase["event"] = event_ref
        view["phases"].append(phase)
        if "next_action" in payload:
            view["next_action"] = payload["next_action"]
    elif event_type == "supervisor_handoff":
        item = copy.deepcopy(payload); item["event"] = event_ref
        view["supervisor_handoffs"].append(item)
    elif event_type == "supervisor_termination":
        item = copy.deepcopy(payload); item["event"] = event_ref
        view["supervisor_termination"] = item; view["status"] = "TERMINATED"
    elif event_type == "reconciliation_correction":
        task = task_for(view, payload)
        correction = copy.deepcopy(payload); correction["event"] = event_ref
        view.setdefault("reconciliations", [])
        view["reconciliations"].append(correction)
        if payload.get("field") == "delivery_state" and payload.get("observed") in VALID_DELIVERY_STATES:
            task["delivery_state"] = payload["observed"]
        task["last_event"] = event_ref
    view["updated_at"] = record["occurred_at"]
    view["last_event"] = event_ref


def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def _legacy_safe(value):
    if isinstance(value, dict):
        return {key: _legacy_safe(child) for key, child in value.items()
                if key not in FORBIDDEN_META_FIELDS}
    if isinstance(value, list):
        return [_legacy_safe(child) for child in value]
    return value


def migrate_legacy_mission(mission_id):
    """Convert a schema-1 mission/capsule into the v2 event stream once."""
    directory = mission_path(mission_id)
    legacy_path = os.path.join(directory, "mission.json")
    legacy_capsule_path = os.path.join(directory, "capsule.json")
    if not os.path.exists(legacy_path) and not os.path.exists(legacy_capsule_path):
        raise StoreError("active mission directory has neither events.jsonl nor a legacy mission.json/capsule.json")
    try:
        legacy = read_json(legacy_path) if os.path.exists(legacy_path) else {}
        capsule = read_json(legacy_capsule_path) if os.path.exists(legacy_capsule_path) else {}
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise StoreError("legacy mission %s could not be read: %s" % (mission_id, exc)) from exc
    if not isinstance(legacy, dict) or not isinstance(capsule, dict):
        raise StoreError("legacy mission %s must contain JSON objects" % mission_id)
    versions = [item.get("schema_version") for item in (legacy, capsule) if item]
    if any(version != 1 for version in versions):
        raise StoreError("legacy mission %s has unsupported schema_version (expected 1)" % mission_id)

    def first(*values):
        return next((value for value in values if value not in (None, "")), None)

    created_at = first(legacy.get("created_at"), capsule.get("updated_at"), now_utc())
    updated_at = first(legacy.get("updated_at"), capsule.get("updated_at"), created_at)
    intent = first(legacy.get("intent"), capsule.get("intent"), "Mission " + mission_id)
    sessions = legacy.get("sessions") or capsule.get("sessions_history") or []
    if not isinstance(sessions, list):
        raise StoreError("legacy mission %s has a non-list sessions history" % mission_id)
    task_graph = legacy.get("task_graph", [])
    if not isinstance(task_graph, (list, dict)):
        task_graph = []
    next_action = first(capsule.get("recommended_next_step"), capsule.get("next_action"),
                        "Continue the active mission")
    prompt_candidates = ("original-prompt.md", "original-ufd-prompt.md")
    prompt_name = next((name for name in prompt_candidates if os.path.exists(os.path.join(directory, name))),
                       "original-prompt.md")
    prompt_file = os.path.join(directory, prompt_name)
    if not os.path.exists(prompt_file):
        atomic_write(prompt_file, ("# Mission %s\n\n%s\n" % (mission_id, intent)).encode("utf-8"))
    with open(prompt_file, "rb") as handle:
        prompt_sha = hashlib.sha256(handle.read()).hexdigest()
    original_prompt = {
        "file": "data/missions/%s/%s" % (mission_id, prompt_name),
        "sha256": prompt_sha, "source_transcript": None, "step_index": None,
        "classification": "RECONSTRUCTED",
    }

    records = []

    def add_event(event_id, event_type, payload, occurred_at):
        require_event_id(event_id)
        validate_event_type(event_type)
        validate_payload(event_type, payload)
        records.append({"schema_version": EVENT_SCHEMA_VERSION, "event_id": event_id,
                        "sequence": len(records) + 1, "occurred_at": occurred_at or now_utc(),
                        "type": event_type, "payload": payload})

    add_event("migration-mission-created:" + mission_id, "mission_created", {
        "mission_id": mission_id, "intent": intent, "original_prompt": original_prompt,
        "task_graph": _legacy_safe(task_graph), "next_action": next_action,
    }, created_at)
    for index, session in enumerate(sessions, 1):
        if not isinstance(session, dict):
            continue
        session_id = session.get("session_id")
        if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]+", session_id):
            continue
        started_at = first(session.get("started_at"), created_at)
        harness = first(session.get("harness"), "legacy")
        add_event("migration-session-started:%d:%s" % (index, session_id), "session_started",
                  {"session_id": session_id, "harness": harness}, started_at)
        status = session.get("status")
        ended_at = session.get("ended_at")
        reason = first(session.get("end_reason"), session.get("reason"), "legacy session ended")
        if status not in (None, "RUNNING") or ended_at:
            add_event("migration-session-ended:%d:%s" % (index, session_id), "session_ended",
                      {"session_id": session_id, "reason": reason}, ended_at or updated_at)

    completed = capsule.get("completed_tasks_sample") or []
    if not isinstance(completed, list):
        completed = []
    completed_ids = []
    for item in completed:
        if not isinstance(item, str):
            continue
        task_id = item.split(" - ", 1)[0].strip()
        if re.fullmatch(r"[A-Za-z0-9._-]+", task_id) and task_id not in completed_ids:
            completed_ids.append(task_id)
            add_event("migration-task-completed:%s" % task_id, "task_completed",
                      {"task_id": task_id}, updated_at)
    in_flight = capsule.get("in_flight_tasks") or []
    if not isinstance(in_flight, list):
        in_flight = []
    for index, task in enumerate(in_flight, 1):
        if not isinstance(task, dict):
            continue
        task_id = task.get("task_id")
        if not isinstance(task_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]+", task_id):
            continue
        add_event("migration-task-dispatched:%d:%s" % (index, task_id), "task_dispatched",
                  _legacy_safe(task), updated_at)
    preserved = capsule.get("preserved_worktrees") or []
    if not isinstance(preserved, list):
        preserved = []
    for index, worktree in enumerate(preserved, 1):
        if isinstance(worktree, dict):
            add_event("migration-worktree:%d" % index, "worktree_created",
                      _legacy_safe(worktree), updated_at)
    add_event("migration-legacy-summary:" + mission_id, "phase_transition", {
        "phase": "legacy-schema-1-migration", "legacy_schema_version": 1,
        "completed_tasks_count": capsule.get("completed_tasks_count", len(completed)),
        "completed_tasks_sample": _legacy_safe(completed),
        "pending_tasks_count": capsule.get("pending_tasks_count", 0),
        "pending_tasks_sample": _legacy_safe(capsule.get("pending_tasks_sample") or []),
        "in_flight_tasks_count": len(in_flight), "recommended_next_step": next_action,
    }, updated_at)
    if legacy.get("status", "ACTIVE") != "ACTIVE":
        add_event("migration-supervisor-termination:" + mission_id, "supervisor_termination", {
            "reason": "legacy schema-1 status=%s" % legacy.get("status"),
        }, updated_at)
    encoded = "".join(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n" for record in records)
    atomic_write(log_path(mission_id), encoded)


def ensure_event_log(mission_id):
    if os.path.exists(log_path(mission_id)):
        return
    migrate_legacy_mission(mission_id)


def parse_delta(raw, base_offset):
    records = []
    valid_end = 0
    for line in raw.splitlines(keepends=True):
        start = valid_end; valid_end += len(line)
        if not line.endswith(b"\n"):
            return records, start, True
        try:
            record = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            if valid_end == len(raw):
                return records, start, True
            raise StoreError("malformed non-final event-log line at byte " + str(base_offset + start))
        validate_record(record, base_offset + start); records.append(record)
    return records, valid_end, False


def materialize(mission_id, emit_warning=True):
    path = log_path(mission_id)
    with open(path, "rb") as handle:
        raw = handle.read()
    records, prefix, torn = [], b"", False
    view = new_view(mission_id)
    cursor = None
    if os.path.exists(cursor_path(mission_id)) and os.path.exists(view_path(mission_id)):
        try:
            candidate_cursor = read_json(cursor_path(mission_id))
            candidate_view = read_json(view_path(mission_id))
            stat = os.stat(path)
            same_file = (candidate_cursor.get("device") == stat.st_dev and candidate_cursor.get("inode") == stat.st_ino)
            offset = candidate_cursor.get("offset")
            if (candidate_cursor.get("schema_version") == 1 and same_file and isinstance(offset, int)
                    and 0 <= offset <= len(raw) and candidate_view.get("schema_version") == VIEW_SCHEMA_VERSION):
                view = candidate_view; tail = raw[offset:]
                records, delta_end, delta_torn = parse_delta(tail, offset)
                prefix = raw[:offset + delta_end]; torn = delta_torn
                cursor = candidate_cursor
        except (OSError, ValueError, KeyError, json.JSONDecodeError, StoreError):
            cursor = None
    if cursor is None:
        view = new_view(mission_id); records, prefix, torn = load_log(mission_id)
    for record in records:
        apply_event(view, record)
    if torn and emit_warning:
        print("warning: discarded malformed final event-log line for " + mission_id, file=sys.stderr)
    stat = os.stat(path)
    atomic_write(cursor_path(mission_id), json.dumps({
        "schema_version": 1, "offset": len(prefix), "device": stat.st_dev,
        "inode": stat.st_ino, "last_sequence": view["last_event"]["sequence"] if view["last_event"] else 0,
    }, indent=2) + "\n")
    atomic_write(view_path(mission_id), json.dumps(view, indent=2) + "\n")
    return view


def append_event(mission_id, event_id, event_type, payload, occurred_at=None):
    require_event_id(event_id); validate_event_type(event_type)
    if not isinstance(payload, dict):
        raise StoreError("event payload must be a JSON object")
    validate_payload(event_type, payload)
    records, prefix, _ = load_log(mission_id)
    for record in records:
        if record["event_id"] == event_id:
            if record["type"] != event_type or record["payload"] != payload:
                raise StoreError("event id is reused with different content: " + event_id)
            return record, False
    record = {"schema_version": EVENT_SCHEMA_VERSION, "event_id": event_id,
              "sequence": len(records) + 1, "occurred_at": occurred_at or now_utc(),
              "type": event_type, "payload": payload}
    encoded = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    atomic_write(log_path(mission_id), prefix + encoded)
    return record, True


def write_capsule(view):
    active = next((session for session in reversed(view["sessions"]) if session["status"] == "RUNNING"), None)
    capsule = {"schema_version": VIEW_SCHEMA_VERSION, "mission_id": view["mission_id"],
               "intent": view["intent"], "original_prompt_pointer": view["original_prompt"]["file"],
               "task_graph": view["task_graph"], "next_action": view["next_action"],
               "active_session": active, "sessions_history": view["sessions"],
               "tasks": view["tasks"], "captain_holds": view["captain_holds"],
               "updated_at": view["updated_at"]}
    text = json.dumps(capsule, indent=2) + "\n"
    atomic_write(capsule_path(view["mission_id"]), text)


def command_output(args, env, timeout=10):
    try:
        result = subprocess.run(args, env=env, text=True, capture_output=True, timeout=timeout, check=False)
        return result.returncode, (result.stdout or "").strip(), (result.stderr or "").strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, "", str(exc)


def parse_meta(path):
    values = {}
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                key, separator, value = line.rstrip("\n").partition("=")
                if separator:
                    values[key] = value
    except OSError:
        pass
    return values


def parse_crew_state(line):
    fields = {}
    for part in line.split(" · "):
        key, separator, value = part.partition(": ")
        if separator:
            fields[key] = value
    return fields


def reconcile_task(task_id, task, script_dir):
    home = os.path.dirname(state_dir)
    env = os.environ.copy()
    env.update({"FM_HOME": home, "FM_ROOT_OVERRIDE": os.path.dirname(script_dir),
                "FM_DATA_OVERRIDE": os.path.dirname(missions_dir), "FM_STATE_OVERRIDE": state_dir})
    meta = parse_meta(os.path.join(state_dir, task.get("meta_pointer", "state/" + task_id + ".meta").removeprefix("state/")))
    worktree = meta.get("worktree") or task.get("worktree") or ""
    repo = meta.get("project") or task.get("repo") or ""
    live = {"state": "unknown", "source": "none", "detail": "task state unavailable"}
    try:
        result = subprocess.run(["bash", os.path.join(script_dir, "fm-crew-state.sh"), task_id],
                                env=env, text=True, capture_output=True, timeout=10, check=False)
        line = (result.stdout or "").strip().splitlines()
        if line:
            live.update(parse_crew_state(line[-1]))
    except (OSError, subprocess.TimeoutExpired):
        pass

    if task.get("delivery_state") in {"LANDED", "VERIFIED_LANDED"} and repo:
        projects = os.path.join(home, "projects")
        try:
            if os.path.commonpath([os.path.realpath(repo), os.path.realpath(projects)]) == os.path.realpath(projects):
                subprocess.run(["bash", os.path.join(script_dir, "fm-fleet-sync.sh"), repo],
                               env=env, text=True, capture_output=True, timeout=15, check=False)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass

    git_info = {"exists": bool(worktree and os.path.isdir(worktree)), "path": worktree,
                "branch": "unknown", "head": "unknown", "clean": "unknown"}
    if git_info["exists"]:
        for key, args in (("branch", ["git", "-C", worktree, "symbolic-ref", "--short", "HEAD"]),
                          ("head", ["git", "-C", worktree, "rev-parse", "HEAD"])):
            rc, out, _ = command_output(args, env)
            if rc == 0 and out:
                git_info[key] = out
        rc, out, _ = command_output(["git", "-C", worktree, "status", "--porcelain"], env)
        if rc == 0:
            git_info["clean"] = not bool(out)

    observed_delivery = task.get("delivery_state") or "UNRECORDED"
    delivery_history = [item.get("delivery_state", "unknown") for item in task.get("delivery_history", [])]
    if observed_delivery in {"LANDED", "VERIFIED_LANDED"} and repo:
        evidence = task.get("delivery_history", [])[-1].get("evidence", {}) if task.get("delivery_history") else {}
        commit = evidence.get("commit_sha") or evidence.get("merge_commit") or evidence.get("fast_forward_commit")
        target = meta.get("target_branch")
        if commit and target:
            rc, _, _ = command_output(["git", "-C", repo, "merge-base", "--is-ancestor", commit, target], env)
            if rc == 0:
                observed_delivery = "VERIFIED_LANDED"
    return {"meta": meta, "live": live, "git": git_info,
            "delivery_state": observed_delivery, "delivery_history": delivery_history}


def resume_context(mission_id, script_dir):
    view = materialize(mission_id, emit_warning=False)
    reconciled = {task_id: reconcile_task(task_id, task, script_dir)
                  for task_id, task in sorted(view["tasks"].items())}
    corrected = False
    for task_id, item in reconciled.items():
        stored = view["tasks"][task_id].get("delivery_state")
        observed = item.get("delivery_state")
        if stored != observed and observed in VALID_DELIVERY_STATES:
            event_id = "reconcile:%s:%s" % (task_id, observed)
            append_event(mission_id, event_id, "reconciliation_correction", {
                "task_id": task_id, "field": "delivery_state", "stored": stored, "observed": observed,
                "reason": "live Git verification during supervisor rehydration",
            })
            corrected = True
    if corrected:
        view = materialize(mission_id, emit_warning=False)
        write_capsule(view)
        reconciled = {task_id: reconcile_task(task_id, task, script_dir)
                      for task_id, task in sorted(view["tasks"].items())}
    print("SUPERVISOR RESUME CONTEXT")
    print("MISSION " + mission_id)
    print("INTENT " + str(view.get("intent") or "(missing)"))
    prompt = view.get("original_prompt") or {}
    print("ORIGINAL PROMPT file=%s sha256=%s source=%s step=%s classification=%s" %
          (prompt.get("file", "(missing)"), prompt.get("sha256", "(missing)"),
           prompt.get("source_transcript") or "(none)", prompt.get("step_index") or "(none)",
           prompt.get("classification", "(missing)")))
    print("TASK GRAPH " + json.dumps(view.get("task_graph", []), sort_keys=True, separators=(",", ":")))
    phases = view.get("phases", [])
    print("PROGRESS " + "; ".join(str(phase.get("phase", "unknown")) for phase in phases) if phases else "PROGRESS none")
    for task_id, task in sorted(view["tasks"].items()):
        item = reconciled[task_id]
        git_info = item["git"]
        meta = item["meta"]
        print("TASK %s delivery_state=%s delivery_history=%s completed=%s blocked=%s live_state=%s live_source=%s worktree=%s branch=%s" %
              (task_id, item["delivery_state"], ",".join(item["delivery_history"]) or "(none)",
               str(task.get("completed", False)).lower(), str(task.get("blocked", False)).lower(),
               item["live"].get("state", "unknown"), item["live"].get("source", "none"),
               git_info["path"] or "(none)", git_info["branch"]))
        print("SOURCE CONTROL %s repo=%s target_branch=%s base_sha=%s head=%s clean=%s" %
              (task_id, meta.get("project") or task.get("repo") or "(none)",
               meta.get("target_branch", "(none)"), meta.get("base_sha", "(none)"),
               git_info["head"], str(git_info["clean"]).lower()))
    holds = [hold for hold in view.get("captain_holds", {}).values() if hold.get("status") == "OPEN"]
    if holds:
        print("DECISIONS " + "; ".join("%s task=%s pointer=%s" %
              (hold["hold_id"], hold["task_id"], hold.get("backlog_pointer", "(none)")) for hold in holds))
    else:
        print("DECISIONS none")
    ended = [session for session in view.get("sessions", []) if session.get("status") == "ENDED"]
    prior = ended[-1] if ended else None
    wake_count = 0
    try:
        with open(os.path.join(state_dir, ".wake-queue"), encoding="utf-8") as handle:
            wake_count = sum(1 for line in handle if any(task_id in line for task_id in view["tasks"]))
    except OSError:
        pass
    if prior:
        print("RECOVERY prior_session=%s harness=%s end_reason=%s ended_at=%s open_wakes=%s" %
              (prior.get("session_id"), prior.get("harness"), prior.get("end_reason"), prior.get("ended_at"), wake_count))
    else:
        print("RECOVERY prior_session=none end_reason=none open_wakes=%s" % wake_count)
    print("NEXT ACTION " + str(view.get("next_action") or "No unblocked next action"))
    print("sourced from event-store materialization plus live reconciliation")


def publish_active(mission_id):
    atomic_write(os.path.join(state_dir, ".active-mission"), mission_id + "\n")


def initialize(mission_id, intent, prompt_file, graph_file, next_action, source_transcript, step_index, classification):
    require_mission_id(mission_id)
    directory = mission_path(mission_id); os.makedirs(directory, mode=0o700, exist_ok=True)
    if os.path.exists(log_path(mission_id)):
        raise StoreError("mission already exists: " + mission_id)
    if prompt_file:
        with open(prompt_file, "rb") as handle:
            prompt = handle.read()
    else:
        prompt = ("# Mission " + mission_id + "\n\n" + (intent or "Pending mission intent") + "\n").encode()
    atomic_write(os.path.join(directory, "original-prompt.md"), prompt)
    graph = []
    if graph_file:
        with open(graph_file, encoding="utf-8") as handle:
            graph = json.load(handle)
        if not isinstance(graph, (list, dict)):
            raise StoreError("task graph must be a JSON array or object")
    classification = classification or "EXACT_RECOVERED"
    if classification not in {"EXACT_RECOVERED", "RECONSTRUCTED", "SUMMARIZED"}:
        raise StoreError("invalid original prompt classification")
    prompt_pointer = "data/missions/%s/original-prompt.md" % mission_id
    original_prompt = {"file": prompt_pointer, "sha256": hashlib.sha256(prompt).hexdigest(),
                       "source_transcript": source_transcript or None,
                       "step_index": int(step_index) if step_index else None,
                       "classification": classification}
    append_event(mission_id, "mission-created:" + mission_id, "mission_created", {
        "mission_id": mission_id, "intent": intent or "Mission " + mission_id,
        "original_prompt": original_prompt, "task_graph": graph,
        "next_action": next_action or "Continue the active mission"})
    view = materialize(mission_id); write_capsule(view); publish_active(mission_id)
    print(mission_id)


def session_start(mission_id, harness, session_id):
    require_mission_id(mission_id); materialize(mission_id, emit_warning=False)
    append_event(mission_id, "session-started:" + session_id, "session_started",
                 {"session_id": session_id, "harness": harness})
    view = materialize(mission_id); write_capsule(view); publish_active(mission_id)
    print(session_id)


def session_end(mission_id, reason):
    require_mission_id(mission_id); view = materialize(mission_id, emit_warning=False)
    session = next((item for item in reversed(view["sessions"]) if item["status"] == "RUNNING"), None)
    if session is None:
        raise StoreError("mission has no running session")
    append_event(mission_id, "session-ended:" + session["session_id"], "session_ended",
                 {"session_id": session["session_id"], "reason": reason})
    view = materialize(mission_id); write_capsule(view)


def append_operation(mission_id, event_id, event_type, payload_text, payload_file, occurred_at):
    require_mission_id(mission_id)
    if payload_file:
        with open(payload_file, encoding="utf-8") as handle:
            payload_text = handle.read()
    payload = parse_json(payload_text or "{}", "event payload")
    record, created = append_event(mission_id, event_id, event_type, payload, occurred_at)
    view = materialize(mission_id); write_capsule(view); publish_active(mission_id)
    print(json.dumps({"event": record, "idempotent_replay": not created}, sort_keys=True))


def main():
    try:
        if operation == "init":
            initialize(*args)
        elif operation == "append":
            append_operation(*args)
        elif operation == "session-start":
            session_start(*args)
        elif operation == "session-end":
            session_end(*args)
        elif operation in {"materialize", "show"}:
            require_mission_id(args[0]); print(json.dumps(materialize(args[0]), indent=2))
        elif operation == "resume-context":
            require_mission_id(args[0]); resume_context(args[0], script_dir)
        elif operation == "capsule":
            require_mission_id(args[0]); view = materialize(args[0])
            if len(args) > 1 and args[1]:
                next_action = args[1]
                event_id = "phase-next-action:" + hashlib.sha256(next_action.encode()).hexdigest()[:24]
                append_event(args[0], event_id, "phase_transition", {"next_action": next_action})
                view = materialize(args[0])
            write_capsule(view)
        elif operation == "active":
            if os.path.isdir(missions_dir):
                for mission_id in sorted(os.listdir(missions_dir)):
                    directory = mission_path(mission_id)
                    has_legacy_record = os.path.exists(os.path.join(directory, "mission.json")) or os.path.exists(os.path.join(directory, "capsule.json"))
                    migrated = False
                    if not re.fullmatch(r"[A-Za-z0-9._-]+", mission_id):
                        if has_legacy_record:
                            raise StoreError("legacy mission directory '%s' has an invalid id; rename it to a valid mission id before recovery" % mission_id)
                        continue
                    if mission_id.startswith("-"):
                        if has_legacy_record:
                            raise StoreError("legacy mission directory '%s' cannot be recovered because mission ids may not start with '-' ; rename it before recovery" % mission_id)
                        continue
                    if not os.path.exists(log_path(mission_id)):
                        if not has_legacy_record:
                            continue
                        ensure_event_log(mission_id)
                        migrated = True
                    try:
                        view = materialize(mission_id, emit_warning=False)
                    except (OSError, ValueError, KeyError, json.JSONDecodeError, StoreError) as exc:
                        raise StoreError("active mission %s could not be recovered: %s" % (mission_id, exc)) from exc
                    if migrated:
                        write_capsule(view)
                    if view.get("schema_version") == VIEW_SCHEMA_VERSION and view.get("status") == "ACTIVE":
                        print(mission_id)
        else:
            raise StoreError("unknown operation: " + operation)
    except (OSError, ValueError, StoreError, KeyError, TypeError) as exc:
        print("error: " + str(exc), file=sys.stderr); raise SystemExit(1)


main()
PY
}

cmd_init() {
  local id="${1-}" intent='' prompt_file='' graph_file='' next_action='' source_transcript='' step_index='' classification='' arg
  if [ -z "$id" ] || ! valid_id "$id"; then die 'mission id must contain only letters, digits, dot, underscore, or dash'; fi
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --intent) [ "$#" -gt 1 ] || die '--intent requires a value'; intent="$2"; shift 2 ;;
      --prompt-file) [ "$#" -gt 1 ] || die '--prompt-file requires a path'; prompt_file="$2"; shift 2 ;;
      --task-graph-file) [ "$#" -gt 1 ] || die '--task-graph-file requires a JSON file'; graph_file="$2"; shift 2 ;;
      --next) [ "$#" -gt 1 ] || die '--next requires a value'; next_action="$2"; shift 2 ;;
      --prompt-source-transcript) [ "$#" -gt 1 ] || die '--prompt-source-transcript requires a path'; source_transcript="$2"; shift 2 ;;
      --prompt-step-index) [ "$#" -gt 1 ] || die '--prompt-step-index requires a number'; step_index="$2"; shift 2 ;;
      --prompt-classification) [ "$#" -gt 1 ] || die '--prompt-classification requires a value'; classification="$2"; shift 2 ;;
      *) die "unknown init option: $arg" ;;
    esac
  done
  mkdir -p "$(mission_dir "$id")" "$STATE_DIR" || die 'could not create mission directories'
  acquire_mission_lock "$id"
  run_store init "$id" "$intent" "$prompt_file" "$graph_file" "$next_action" "$source_transcript" "$step_index" "$classification"
}

cmd_append() {
  local id="${1-}" event_id='' event_type='' payload='' payload_file='' occurred_at='' arg
  if [ -z "$id" ] || ! valid_id "$id"; then die 'mission id is required'; fi
  shift
  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --event-id) [ "$#" -gt 1 ] || die '--event-id requires a value'; event_id="$2"; shift 2 ;;
      --type) [ "$#" -gt 1 ] || die '--type requires a value'; event_type="$2"; shift 2 ;;
      --payload) [ "$#" -gt 1 ] || die '--payload requires a value'; payload="$2"; shift 2 ;;
      --payload-file) [ "$#" -gt 1 ] || die '--payload-file requires a path'; payload_file="$2"; shift 2 ;;
      --occurred-at) [ "$#" -gt 1 ] || die '--occurred-at requires a value'; occurred_at="$2"; shift 2 ;;
      *) die "unknown append option: $arg" ;;
    esac
  done
  [ -n "$event_id" ] || die '--event-id is required'; [ -n "$event_type" ] || die '--type is required'
  [ -z "$payload" ] || [ -z "$payload_file" ] || die 'choose only one payload source'
  [ -d "$(mission_dir "$id")" ] || die "mission not found: $id"
  acquire_mission_lock "$id"
  run_store append "$id" "$event_id" "$event_type" "$payload" "$payload_file" "$occurred_at"
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
  [ -n "$harness" ] || die '--harness is required'; [ -n "$session_id" ] || session_id="session-$(date -u +%Y%m%dT%H%M%S)-${BASHPID:-$$}"
  [ -d "$(mission_dir "$id")" ] || die "mission not found: $id"
  acquire_mission_lock "$id"; run_store session-start "$id" "$harness" "$session_id"
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
  [ -n "$reason" ] || die '--reason requires a non-empty value'; [ -d "$(mission_dir "$id")" ] || die "mission not found: $id"
  acquire_mission_lock "$id"; run_store session-end "$id" "$reason"
}

cmd_read() {
  local operation=$1 id=${2-}
  if [ "$operation" = active ]; then run_store active; return; fi
  if [ -z "$id" ] || ! valid_id "$id"; then die 'mission id is required'; fi
  [ -d "$(mission_dir "$id")" ] || die "mission not found: $id"
  acquire_mission_lock "$id"; run_store "$operation" "$id"
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
  [ -d "$(mission_dir "$id")" ] || die "mission not found: $id"; acquire_mission_lock "$id"
  run_store capsule "$id" "$next_action"
}

case "${1-}" in
  init) shift; cmd_init "$@" ;;
  append) shift; cmd_append "$@" ;;
  session-start) shift; cmd_session_start "$@" ;;
  session-end) shift; cmd_session_end "$@" ;;
  materialize|show|resume-context) cmd_read "$1" "${2-}" ;;
  capsule) shift; cmd_capsule "$@" ;;
  active) cmd_read active ;;
  ''|-h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
