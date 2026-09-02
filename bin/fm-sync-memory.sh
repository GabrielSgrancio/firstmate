#!/usr/bin/env bash
# fm-sync-memory.sh: synchronize Firstmate fleet memory (captain.md,
# learnings.md, backlog.md, projects.md) across homes (Mac, PC, Cloud Hub)
# via Tailscale and the central Oracle hub.
#
# Usage:
#   fm-sync-memory.sh status     Check sync status between local and remote hub
#   fm-sync-memory.sh push       Push local data/ memories to central hub
#   fm-sync-memory.sh pull       Pull central hub memories to local data/
#
# Configuration:
#   config/fleet-memory-host     Remote SSH host alias or "local" (default: oracle or hub)
#   config/fleet-memory-dir      Remote directory (default: ~/firstmate-fleet-memory)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FM_HOME="${FM_HOME:-$FM_ROOT}"
DATA_DIR="$FM_HOME/data"

CONFIG_HOST_FILE="$FM_HOME/config/fleet-memory-host"
CONFIG_DIR_FILE="$FM_HOME/config/fleet-memory-dir"

REMOTE_HOST="${FM_MEMORY_HOST:-}"
if [ -z "$REMOTE_HOST" ]; then
  if [ -f "$CONFIG_HOST_FILE" ]; then
    REMOTE_HOST="$(tr -d '[:space:]' < "$CONFIG_HOST_FILE")"
  fi
fi

# Detect if running directly on the hub itself
if [ -z "$REMOTE_HOST" ]; then
  if [ -d "$HOME/firstmate-fleet-memory" ] && [ "$FM_HOME" != "$HOME/firstmate-fleet-memory" ]; then
    REMOTE_HOST="local"
  else
    REMOTE_HOST="oracle"
  fi
fi

REMOTE_DIR="${FM_MEMORY_DIR:-}"
if [ -z "$REMOTE_DIR" ]; then
  if [ -f "$CONFIG_DIR_FILE" ]; then
    REMOTE_DIR="$(tr -d '[:space:]' < "$CONFIG_DIR_FILE")"
  fi
fi
if [ -z "$REMOTE_DIR" ]; then
  REMOTE_DIR="~/firstmate-fleet-memory"
fi

FILES=("captain.md" "learnings.md" "backlog.md" "projects.md")

is_local() {
  [ "$REMOTE_HOST" = "local" ] || [ "$REMOTE_HOST" = "localhost" ]
}

check_connectivity() {
  if is_local; then
    mkdir -p "$REMOTE_DIR"
    return 0
  fi
  if ! ssh -o ConnectTimeout=3 -o BatchMode=yes "$REMOTE_HOST" "true" 2>/dev/null; then
    echo "warning: cannot reach fleet memory hub at '$REMOTE_HOST' via SSH/Tailscale." >&2
    echo "Ensure Tailscale is connected and SSH alias '$REMOTE_HOST' is configured." >&2
    return 1
  fi
  return 0
}

remote_run() {
  local cmd="$1"
  if is_local; then
    bash -c "$cmd"
  else
    ssh "$REMOTE_HOST" "$cmd"
  fi
}

do_status() {
  echo "Fleet Memory Hub: $REMOTE_HOST:$REMOTE_DIR"
  if ! check_connectivity; then
    echo "Status: OFFLINE / UNREACHABLE"
    return 1
  fi
  echo "Status: ONLINE"
  echo ""
  printf "%-16s | %-12s | %-12s | %s\n" "File" "Local Size" "Remote Size" "Sync State"
  printf "%s\n" "-----------------+--------------+--------------+----------------"

  local tmp_remote_sums
  if is_local; then
    tmp_remote_sums="$(cd "$REMOTE_DIR" 2>/dev/null && sha256sum ${FILES[*]} 2>/dev/null || true)"
  else
    tmp_remote_sums="$(ssh "$REMOTE_HOST" "cd $REMOTE_DIR 2>/dev/null && sha256sum ${FILES[*]} 2>/dev/null || true")"
  fi

  for f in "${FILES[@]}"; do
    local local_path="$DATA_DIR/$f"
    local local_size="absent"
    local local_sha=""
    if [ -f "$local_path" ]; then
      local_size="$(wc -c < "$local_path" | tr -d ' ')"
      local_sha="$(sha256sum "$local_path" | awk '{print $1}')"
    fi

    local remote_sha
    remote_sha="$(printf '%s\n' "$tmp_remote_sums" | grep -w "$f" | awk '{print $1}' || true)"
    local remote_size="absent"
    if [ -n "$remote_sha" ]; then
      if is_local; then
        remote_size="$(wc -c < "$REMOTE_DIR/$f" 2>/dev/null | tr -d ' ' || echo absent)"
      else
        remote_size="$(ssh "$REMOTE_HOST" "wc -c < $REMOTE_DIR/$f 2>/dev/null || echo absent" | tr -d ' ')"
      fi
    fi

    local state="DIVERGED"
    if [ -z "$local_sha" ] && [ -z "$remote_sha" ]; then
      state="ABSENT BOTH"
    elif [ -z "$local_sha" ]; then
      state="REMOTE ONLY"
    elif [ -z "$remote_sha" ]; then
      state="LOCAL ONLY"
    elif [ "$local_sha" = "$remote_sha" ]; then
      state="IN SYNC"
    fi

    printf "%-16s | %-12s | %-12s | %s\n" "$f" "$local_size" "$remote_size" "$state"
  done
}

do_push() {
  check_connectivity || exit 1
  echo "Pushing fleet memories from $DATA_DIR to $REMOTE_HOST:$REMOTE_DIR..."
  if is_local; then
    mkdir -p "$REMOTE_DIR"
  else
    ssh "$REMOTE_HOST" "mkdir -p $REMOTE_DIR"
  fi

  local pushed=0
  for f in "${FILES[@]}"; do
    local src="$DATA_DIR/$f"
    if [ -f "$src" ]; then
      if is_local; then
        rsync -az "$src" "$REMOTE_DIR/$f"
      else
        rsync -az "$src" "$REMOTE_HOST:$REMOTE_DIR/$f"
      fi
      pushed=$((pushed + 1))
      echo "  pushed: $f"
    fi
  done

  # Commit snapshot on remote git repository if git is present
  local host_ident
  host_ident="$(hostname 2>/dev/null || echo 'unknown-host')"
  local iso_date
  iso_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  remote_run "cd $REMOTE_DIR && if [ -d .git ]; then git add -A && git diff --cached --quiet || git commit -m 'memory snapshot from $host_ident at $iso_date'; fi"

  echo "Successfully pushed $pushed file(s) to fleet memory hub."
}

do_pull() {
  check_connectivity || exit 1
  echo "Pulling fleet memories from $REMOTE_HOST:$REMOTE_DIR to $DATA_DIR..."
  mkdir -p "$DATA_DIR"

  local pulled=0
  for f in "${FILES[@]}"; do
    local dst="$DATA_DIR/$f"
    local tmp_file="$DATA_DIR/.${f}.incoming"
    local src_spec
    if is_local; then
      src_spec="$REMOTE_DIR/$f"
    else
      src_spec="$REMOTE_HOST:$REMOTE_DIR/$f"
    fi

    if rsync -az "$src_spec" "$tmp_file" 2>/dev/null; then
      if [ -f "$dst" ]; then
        if ! cmp -s "$dst" "$tmp_file"; then
          local bak="${dst}.bak.$(date +%Y%m%d%H%M%S)"
          cp "$dst" "$bak"
          echo "  backup saved: $(basename "$bak")"
          mv "$tmp_file" "$dst"
          echo "  updated: $f"
          pulled=$((pulled + 1))
        else
          rm -f "$tmp_file"
          echo "  unchanged: $f"
        fi
      else
        mv "$tmp_file" "$dst"
        echo "  created: $f"
        pulled=$((pulled + 1))
      fi
    else
      rm -f "$tmp_file"
    fi
  done

  echo "Pull complete ($pulled updated/created)."
}

ACTION="${1:-status}"
case "$ACTION" in
  status) do_status ;;
  push)   do_push ;;
  pull)   do_pull ;;
  *)
    echo "usage: fm-sync-memory.sh [status|push|pull]" >&2
    exit 1
    ;;
esac
