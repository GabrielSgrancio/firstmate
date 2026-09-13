#!/usr/bin/env bash
# Host quota monitor & failover sentinel.
# Periodically checks active host runway via quota-axi and triggers preemptive
# checkpoints and failover warnings before quota exhaustion kills the coordinator.
# Usage: bin/fm-host-monitor.sh [--check-only] [--loop <seconds>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FM_HOME="${FM_HOME:-$ROOT_DIR}"
STATE_DIR="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
mkdir -p "$STATE_DIR"

LOOP_INTERVAL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --loop) LOOP_INTERVAL="${2:-60}"; shift 2 ;;
    *) shift ;;
  esac
done

evaluate_host_runway() {
  # Run quota-axi and evaluate the active host
  local q_json
  q_json=$(quota-axi --json 2>/dev/null || echo "{}")

  # Detect active host
  local active_host="antigravity"
  if [[ -f "$STATE_DIR/.lock" ]]; then
    local lock_pid
    lock_pid=$(cat "$STATE_DIR/.lock" 2>/dev/null || true)
    if [[ -n "$lock_pid" && "$lock_pid" =~ ^[0-9]+$ ]]; then
      local comm
      comm=$(ps -p "$lock_pid" -o comm= 2>/dev/null || true)
      case "$comm" in
        *claude*) active_host="claude" ;;
        *codex*) active_host="codex" ;;
        *agy*|*antigravity*) active_host="antigravity" ;;
      esac
    fi
  fi

  # Evaluate effective headroom in python safely via stdin
  local eval_result
  eval_result=$(printf '%s\n' "$q_json" | python3 -c '
import sys, json

try:
    raw = sys.stdin.read().strip()
    data = json.loads(raw) if raw else {}
except Exception:
    data = {}

host = "'"$active_host"'"
headroom = -1
limiting_window = "unknown"
status = "UNKNOWN"
best_alternate = "none"

providers = data.get("providers", [])
alternates = []

for p in providers:
    name = p.get("provider")
    p_state = p.get("state", {})
    is_fresh = p_state.get("status") in ["fresh", "cached"] or (not p_state.get("stale") and p_state.get("status") not in ["auth_required", "error"])
    semantics = p.get("quotaSemantics", {})
    is_known = semantics.get("status") == "known"
    eff_list = semantics.get("effectiveAvailability", [])

    p_headroom = -1
    p_limiting = "unknown"

    if is_fresh and is_known and eff_list:
        if name == "antigravity":
            gemini_eff = next((e for e in eff_list if e.get("scope") == "gemini"), None)
            if gemini_eff and isinstance(gemini_eff.get("effectivePercentRemaining"), (int, float)):
                p_headroom = int(gemini_eff["effectivePercentRemaining"])
                p_limiting = ",".join(gemini_eff.get("limitingWindowIds", ["gemini"]))
        else:
            eff = eff_list[0]
            if isinstance(eff.get("effectivePercentRemaining"), (int, float)):
                p_headroom = int(eff["effectivePercentRemaining"])
                p_limiting = ",".join(eff.get("limitingWindowIds", ["session"]))

    if name == host:
        headroom = p_headroom
        limiting_window = p_limiting
        status = "KNOWN" if p_headroom >= 0 else "UNKNOWN"
    else:
        if p_headroom >= 0:
            alternates.append((p_headroom, name))

if alternates:
    alternates.sort(key=lambda x: x[0], reverse=True)
    best_alternate = alternates[0][1]
else:
    best_alternate = "codex" if host != "codex" else "claude"

print(f"{headroom}|{limiting_window}|{host}|{status}|{best_alternate}")
')

  local headroom limiting_window host status best_alternate
  IFS='|' read -r headroom limiting_window host status best_alternate <<< "$eval_result"

  if [[ "$status" == "UNKNOWN" || "$headroom" -lt 0 ]]; then
    echo "Host: $host | Limiting Window: $limiting_window | Headroom: UNKNOWN"
    echo "WARNING: Host $host quota status is UNKNOWN / UNVERIFIED (fail-closed)!" >&2
    "$SCRIPT_DIR/fm-host-checkpoint.sh" --note "unknown_quota_fail_closed"
    echo "$best_alternate" > "$STATE_DIR/.host-failover-needed"
    return 1
  fi

  echo "Host: $host | Limiting Window: $limiting_window | Headroom: ${headroom}%"

  if (( headroom <= 0 )); then
    echo "EXHAUSTED: Host $host quota is completely exhausted (0%)!" >&2
    "$SCRIPT_DIR/fm-host-checkpoint.sh" --note "host_quota_exhausted"
    echo "$best_alternate" > "$STATE_DIR/.host-failover-needed"
    if [[ -x "$SCRIPT_DIR/fm-host-resume.sh" ]]; then
      echo "Invoking host failover resumption on $best_alternate..."
      "$SCRIPT_DIR/fm-host-resume.sh" --host "$best_alternate" || true
    fi
    return 3
  elif (( headroom < 15 )); then
    echo "CRITICAL: Host $host headroom (${headroom}%) is below 15% threshold!" >&2
    "$SCRIPT_DIR/fm-host-checkpoint.sh" --note "critical_quota_exhaustion_threshold"
    echo "$best_alternate" > "$STATE_DIR/.host-failover-needed"
    return 2
  elif (( headroom < 30 )); then
    echo "WARNING: Host $host headroom (${headroom}%) is below 30% threshold. Preemptive checkpoint triggered."
    "$SCRIPT_DIR/fm-host-checkpoint.sh" --note "preemptive_quota_warning"
    return 1
  else
    echo "OK: Host $host headroom is healthy (${headroom}%)."
    return 0
  fi
}

if [[ "$LOOP_INTERVAL" -gt 0 ]]; then
  echo "Starting continuous host quota monitor (interval: ${LOOP_INTERVAL}s)..."
  while true; do
    evaluate_host_runway || true
    sleep "$LOOP_INTERVAL"
  done
else
  evaluate_host_runway
fi
