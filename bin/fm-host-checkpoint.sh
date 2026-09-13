#!/usr/bin/env bash
# Host checkpoint utility: serializes orchestration state so a session can survive
# host model termination, quota exhaustion, or failover to Claude/Codex.
# Usage: bin/fm-host-checkpoint.sh [--note "<reason>"]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FM_HOME="${FM_HOME:-$ROOT_DIR}"
STATE_DIR="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
DATA_DIR="${FM_DATA_OVERRIDE:-$FM_HOME/data}"

note="${1:-routine_checkpoint}"
if [[ "$note" == "--note" ]]; then
  note="${2:-routine_checkpoint}"
fi

mkdir -p "$STATE_DIR"

CHECKPOINT_JSON="$STATE_DIR/host-checkpoint.json"
CHECKPOINT_MD="$STATE_DIR/host-checkpoint.md"

# 1. Detect current host from lock or running process
host_name="unknown"
lock_file="$STATE_DIR/.lock"
lock_pid=""
if [[ -f "$lock_file" ]]; then
  lock_pid=$(cat "$lock_file" 2>/dev/null || true)
  if [[ -n "$lock_pid" && "$lock_pid" =~ ^[0-9]+$ ]]; then
    comm=$(ps -p "$lock_pid" -o comm= 2>/dev/null || true)
    case "$comm" in
      *agy*|*antigravity*) host_name="antigravity" ;;
      *claude*) host_name="claude" ;;
      *codex*) host_name="codex" ;;
      *) host_name="$comm" ;;
    esac
  fi
fi

if [[ "$host_name" == "unknown" ]]; then
  # Fallback to current process ancestry
  if pgrep -f "agy" >/dev/null 2>&1; then
    host_name="antigravity"
  fi
fi

# 2. Extract active tasks from state/*.meta
active_tasks="[]"
meta_files=("$STATE_DIR"/*.meta)
if [[ -e "${meta_files[0]}" ]]; then
  active_tasks=$(python3 -c '
import sys, glob, json

tasks = []
for f in glob.glob("state/*.meta"):
    tid = f.replace("state/", "").replace(".meta", "")
    data = {"id": tid}
    try:
        with open(f) as fp:
            for line in fp:
                if "=" in line:
                    k, v = line.strip().split("=", 1)
                    data[k] = v
        tasks.append(data)
    except Exception:
        pass
print(json.dumps(tasks))
')
fi

# 3. Read quota telemetry via quota-axi
quota_json=$(quota-axi --json 2>/dev/null || echo "{}")

# 4. Determine best failover target based on quota
failover_target=$(python3 -c '
import sys, json

try:
    data = json.loads("""'"$quota_json"'""")
    claude_headroom = 0
    codex_headroom = 0
    for p in data.get("providers", []):
        name = p.get("provider")
        eff = p.get("quotaSemantics", {}).get("effectiveAvailability", [])
        pct = eff[0].get("effectivePercentRemaining", 0) if eff else 0
        if name == "claude":
            claude_headroom = pct
        elif name == "codex":
            codex_headroom = pct
    if codex_headroom >= 60:
        print("codex")
    elif claude_headroom >= 40:
        print("claude")
    else:
        print("codex" if codex_headroom >= claude_headroom else "claude")
except Exception:
    print("codex")
')

# 5. Harvest objective
objective="No active objective set"
if [[ -f "$STATE_DIR/active-objective.txt" ]]; then
  objective=$(head -n 5 "$STATE_DIR/active-objective.txt")
elif [[ -f "$DATA_DIR/backlog.md" ]]; then
  in_progress=$(grep -A 5 "^## In progress" "$DATA_DIR/backlog.md" | grep "^- \[ \]" | head -n 1 || true)
  if [[ -n "$in_progress" ]]; then
    objective="$in_progress"
  fi
fi

# 6. Read context deltas if present
context_deltas="[]"
if [[ -f "$STATE_DIR/context-deltas.jsonl" ]]; then
  context_deltas=$(python3 -c '
import json
lines = []
with open("state/context-deltas.jsonl") as f:
    for l in f:
        l = l.strip()
        if l:
            try: lines.append(json.loads(l))
            except: lines.append({"raw": l})
print(json.dumps(lines))
')
fi

# Write JSON Checkpoint atomically
TMP_OUT=$(mktemp "$STATE_DIR/checkpoint.tmp.XXXXXX")
cat << JEOF > "$TMP_OUT"
{
  "version": 1,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "note": "$note",
  "activeHost": {
    "name": "$host_name",
    "lockPid": "$lock_pid"
  },
  "recommendedFailoverHost": "$failover_target",
  "objective": $(echo "$objective" | jq -Rs .),
  "activeTasks": $active_tasks,
  "contextDeltas": $context_deltas,
  "quotaSnapshot": $quota_json
}
JEOF

mv "$TMP_OUT" "$CHECKPOINT_JSON"

# Write Human-readable Markdown summary
cat << MEOF > "$CHECKPOINT_MD"
# Orchestration Host Checkpoint

* **Captured At**: $(date -u +%Y-%m-%dT%H:%M:%SZ)
* **Current Host**: \`$host_name\` (Lock PID: \`${lock_pid:-none}\`)
* **Recommended Failover Target**: \`$failover_target\`
* **Reason / Note**: $note

---

## Active Objective
$objective

---

## Quota Headroom Summary
\`\`\`text
$(quota-axi 2>/dev/null || echo "quota-axi unavailable")
\`\`\`

---

## Active Tasks
$(python3 -c '
import json
with open("'"$CHECKPOINT_JSON"'") as f:
    d = json.load(f)
tasks = d.get("activeTasks", [])
if not tasks:
    print("No tasks currently active in state/.")
else:
    for t in tasks:
        tid = t.get("id", "")
        kind = t.get("kind", "ship")
        st = t.get("status", "active")
        print(f"- **{tid}** | Kind: {kind} | Status: {st}")
')

---

## Resumption Instructions for Failover Host (\`$failover_target\`):
To resume orchestration seamlessly on the new host, run:
\`\`\`bash
bin/fm-host-resume.sh --host $failover_target
\`\`\`
MEOF

echo "Host orchestration checkpoint created successfully."
echo "JSON: $CHECKPOINT_JSON"
echo "Markdown: $CHECKPOINT_MD"
