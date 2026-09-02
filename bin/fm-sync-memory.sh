#!/usr/bin/env bash
# Synchronize Firstmate's shared fleet-memory layer with its hub.
#
# Usage: fm-sync-memory.sh <status|push|pull|baton-read|baton-stamp|queue-sync>
#
# config/fleet-memory-host names the SSH alias (or `local`) and
# config/fleet-memory-dir names the hub directory (default
# ~/firstmate-fleet-memory). Every hub mutation is serialized by an atomic
# mkdir lock, refuses a divergent destination, and is committed in the hub's
# Git repository. A missing, malformed, busy, or uncommittable hub therefore
# fails closed: local data is never replaced and no last-writer-wins write occurs.
#
# SHARED_FILES and LOCAL_FILES deliberately remain separate. `queue-sync` is
# the only backlog path: it adds a hub owner marker before synchronizing, so it
# cannot turn the LOCAL_FILES exception into an unsafe generic memory copy.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
DATA_DIR="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
CONFIG_DIR="${FM_CONFIG_OVERRIDE:-$FM_HOME/config}"

read_one_line() { [ -f "$1" ] && [ ! -L "$1" ] || return 1; sed -n '1p' "$1" 2>/dev/null; }
REMOTE_HOST="${FM_MEMORY_HOST:-$(read_one_line "$CONFIG_DIR/fleet-memory-host" 2>/dev/null || true)}"
REMOTE_DIR="${FM_MEMORY_DIR:-$(read_one_line "$CONFIG_DIR/fleet-memory-dir" 2>/dev/null || true)}"
[ -n "$REMOTE_HOST" ] || REMOTE_HOST=hub
# shellcheck disable=SC2088 # Literal remote-home notation is expanded by local_hub_dir.
[ -n "$REMOTE_DIR" ] || REMOTE_DIR='~/firstmate-fleet-memory'

# Fleet memory is layered, because these files answer different questions.
#
# SHARED travels between homes: knowledge and captain preferences that are true
# on every machine.
#   learnings.md        what the fleet has learned; machine-independent.
#   captain-shared.md   preferences that hold everywhere. AGENTS.md section 2
#                       owns it; each home keeps its own captain.md beside it.
#
# LOCAL never travels, because copying it would make the file lie or lose work:
#   captain.md   machine-specific preferences (a corporate-managed laptop and a
#                personal PC do not carry the same standing authority).
#   projects.md  what is cloned on THIS disk and where; clone paths differ per
#                machine, and a registry that misreports them breaks dispatch.
#   backlog.md   this home's own work queue. Sync is last-writer-wins, so
#                copying it between two live homes silently drops tasks.
#
# Overriding SHARED is deliberately rare and still performs the same
# equal-or-absent proof for every selected file.
SHARED_FILES=(learnings.md captain-shared.md)
LOCAL_FILES=(captain.md projects.md backlog.md)
if [ -n "${FM_MEMORY_FILES:-}" ]; then read -r -a FILES <<< "$FM_MEMORY_FILES"; else FILES=("${SHARED_FILES[@]}"); fi

is_local() { [ "$REMOTE_HOST" = local ] || [ "$REMOTE_HOST" = "localhost" ]; }
local_hub_dir() { # shellcheck disable=SC2088 # Match a literal remote-home prefix.
  case "$REMOTE_DIR" in '~/'*) printf '%s/%s\n' "$HOME" "${REMOTE_DIR#\~/}" ;; *) printf '%s\n' "$REMOTE_DIR" ;; esac
}
machine_name() {
  local name
  name=$(read_one_line "$CONFIG_DIR/machine-profile" 2>/dev/null || true)
  case "$name" in [a-z0-9][a-z0-9-]*) printf '%s\n' "$name" ;; *) hostname -s 2>/dev/null | tr -cd '[:alnum:]-' | sed 's/^$/unknown/' ;; esac
}
sha_file() { [ -f "$1" ] && [ ! -L "$1" ] || return 1; if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi; }
commit_hub() { # <dir> <message> <path...>
  local dir=$1 message=$2
  shift 2
  [ -d "$dir/.git" ] || { echo 'REFUSED: fleet memory hub is not a Git repository.' >&2; return 1; }
  git -C "$dir" add -- "$@"
  git -C "$dir" diff --cached --quiet || git -C "$dir" commit -m "$message" >/dev/null
}
lock_hub() { mkdir "$1/.fm-fleet-memory.lock" 2>/dev/null || { echo 'REFUSED: fleet memory hub lock is held or left unresolved; inspect the owner before retrying.' >&2; return 1; }; }
unlock_hub() { rmdir "$1/.fm-fleet-memory.lock" 2>/dev/null || true; }

# The local transport is also the hub's own execution path. The SSH transport
# stages bytes outside the target, then completes the same lock-and-commit
# transaction remotely; it never falls back to rsync overwrite semantics.
require_local_hub() {
  is_local || { echo "OFFLINE: fleet memory hub '$REMOTE_HOST' is unavailable for safe synchronization; local memory remains authoritative." >&2; return 1; }
  HUB=$(local_hub_dir)
  [ -d "$HUB" ] || { echo "OFFLINE: fleet memory hub directory is unavailable: $HUB" >&2; return 1; }
}

remote_call() { # <action> <file> <token> <owner> <timestamp>
  local action=$1 file=$2 token=$3 owner=$4 timestamp=$5 dir_b64
  dir_b64=$(printf %s "$REMOTE_DIR" | base64 | tr -d '\n')
  ssh -o ConnectTimeout=3 -o BatchMode=yes "$REMOTE_HOST" \
    "FM_FLEET_DIR_B64=$dir_b64 FM_FLEET_ACTION=$action FM_FLEET_FILE=$file FM_FLEET_TOKEN=$token FM_FLEET_OWNER=$owner FM_FLEET_TIMESTAMP=$timestamp bash -s" <<'SH'
set -eu
decode() { printf %s "$1" | { base64 -d 2>/dev/null || base64 -D; }; }
dir=$(decode "$FM_FLEET_DIR_B64")
home_prefix='~/'
case "$dir" in '~/'*) dir="$HOME/${dir#"$home_prefix"}" ;; esac
lock="$dir/.fm-fleet-memory.lock"
incoming="$dir/.fm-fleet-memory.incoming-$FM_FLEET_TOKEN"
target="$dir/$FM_FLEET_FILE"
commit() { git -C "$dir" add -- "$@" && { git -C "$dir" diff --cached --quiet || git -C "$dir" commit -m "fleet memory from $FM_FLEET_OWNER at $FM_FLEET_TIMESTAMP" >/dev/null; }; }
case "$FM_FLEET_ACTION" in
  acquire)
    [ -d "$dir/.git" ] || { echo 'REFUSED: fleet memory hub is not a Git repository.' >&2; exit 1; }
    mkdir "$lock" 2>/dev/null || { echo 'REFUSED: fleet memory hub lock is held or unresolved.' >&2; exit 1; }
    ;;
  release) rmdir "$lock" 2>/dev/null || true ;;
  finalize)
    [ -f "$incoming" ] && [ ! -L "$incoming" ] || { echo 'REFUSED: staged hub upload is missing or unsafe.' >&2; rmdir "$lock" 2>/dev/null || true; exit 1; }
    if [ -e "$target" ] && [ ! -f "$target" ]; then echo 'REFUSED: hub target is not a regular file.' >&2; rm -f "$incoming"; rmdir "$lock" 2>/dev/null || true; exit 1; fi
    if [ -f "$target" ] && ! cmp -s "$incoming" "$target"; then echo 'REFUSED: hub target diverged; refusing overwrite.' >&2; rm -f "$incoming"; rmdir "$lock" 2>/dev/null || true; exit 3; fi
    if [ ! -f "$target" ]; then
      mv "$incoming" "$target"
      commit "$FM_FLEET_FILE" || {
        rm -f "$target"
        echo 'REFUSED: hub write was not committed; restored its prior absence.' >&2
        rmdir "$lock" 2>/dev/null || true
        exit 1
      }
    else
      rm -f "$incoming"
    fi
    rmdir "$lock" 2>/dev/null || true
    ;;
  replace)
    [ -f "$incoming" ] && [ ! -L "$incoming" ] || { echo 'REFUSED: staged baton upload is missing or unsafe.' >&2; rmdir "$lock" 2>/dev/null || true; exit 1; }
    if [ -e "$target" ] && [ ! -f "$target" ]; then
      echo 'REFUSED: baton target is not a regular file.' >&2
      rm -f "$incoming"
      rmdir "$lock" 2>/dev/null || true
      exit 1
    fi
    backup="$dir/.fm-fleet-memory.before-$FM_FLEET_TOKEN"
    if [ -f "$target" ]; then cp "$target" "$backup"; fi
    mv "$incoming" "$target"
    commit "$FM_FLEET_FILE" || {
      if [ -f "$backup" ]; then mv "$backup" "$target"; else rm -f "$target"; fi
      echo 'REFUSED: hub baton was not committed; restored the prior baton.' >&2
      rmdir "$lock" 2>/dev/null || true
      exit 1
    }
    rm -f "$backup"
    rmdir "$lock" 2>/dev/null || true
    ;;
  claim-queue)
    marker="$dir/.fm-queue-owner"
    if [ -e "$marker" ] && { [ ! -f "$marker" ] || [ -L "$marker" ]; }; then echo 'REFUSED: queue owner marker is unsafe.' >&2; rmdir "$lock" 2>/dev/null || true; exit 1; fi
    if [ -f "$marker" ] && ! grep -Fx "machine=$FM_FLEET_OWNER" "$marker" >/dev/null 2>&1; then echo "QUEUE OWNER CONFLICT: hub queue is owned by $(sed -n 's/^machine=//p' "$marker" | head -1); this home ($FM_FLEET_OWNER) will not overwrite it." >&2; rmdir "$lock" 2>/dev/null || true; exit 3; fi
    if [ ! -f "$marker" ]; then
      printf 'machine=%s\nclaimed_at=%s\n' "$FM_FLEET_OWNER" "$FM_FLEET_TIMESTAMP" > "$marker"
      commit .fm-queue-owner || {
        rm -f "$marker"
        echo 'REFUSED: queue ownership claim was not committed; restored its prior absence.' >&2
        rmdir "$lock" 2>/dev/null || true
        exit 1
      }
    fi
    rmdir "$lock" 2>/dev/null || true
    ;;
  read) [ -f "$target" ] && [ ! -L "$target" ] && cat "$target" ;;
  *) exit 2 ;;
esac
SH
}

remote_push_file() { # <source> <target filename> <replace 0|1>
  local src=$1 file=$2 replace=$3 token owner now rc
  token="$$.$RANDOM"; owner=$(machine_name); now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  remote_call acquire "$file" "$token" "$owner" "$now" || return 1
  if ! rsync -az "$src" "$REMOTE_HOST:$REMOTE_DIR/.fm-fleet-memory.incoming-$token"; then remote_call release "$file" "$token" "$owner" "$now" || true; echo 'OFFLINE: fleet memory hub upload did not complete.' >&2; return 1; fi
  if [ "$replace" -eq 1 ]; then remote_call replace "$file" "$token" "$owner" "$now"; else remote_call finalize "$file" "$token" "$owner" "$now"; fi
  rc=$?
  [ "$rc" -ne 3 ] || echo "REFUSED: $file diverged locally and on the hub; refusing an overwrite." >&2
  return "$rc"
}
remote_pull_file() { # <filename>
  local file=$1 dst="$DATA_DIR/$1" tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/fm-memory-pull.XXXXXX") || return 1
  trap 'rm -f "$tmp"' RETURN
  if ! rsync -az "$REMOTE_HOST:$REMOTE_DIR/$file" "$tmp" 2>/dev/null; then echo "OFFLINE: hub file is unavailable: $file" >&2; return 1; fi
  [ -f "$tmp" ] || return 0
  if [ -f "$dst" ] && ! cmp -s "$tmp" "$dst"; then echo "REFUSED: $file diverged locally and on the hub; refusing an overwrite." >&2; return 1; fi
  if [ ! -e "$dst" ]; then mkdir -p "$DATA_DIR"; mv "$tmp" "$dst"; printf 'pulled: %s\n' "$file"; else printf 'unchanged: %s\n' "$file"; fi
}

safe_push_file() { # <filename> <commit message>
  local file=$1 message=$2 src="$DATA_DIR/$1" dst="$HUB/$1" tmp
  [ -f "$src" ] && [ ! -L "$src" ] || return 0
  lock_hub "$HUB" || return 1
  trap 'unlock_hub "$HUB"' RETURN
  if [ -e "$dst" ] && [ ! -f "$dst" ]; then echo "REFUSED: hub target is not a regular file: $file" >&2; return 1; fi
  if [ -f "$dst" ] && ! cmp -s "$src" "$dst"; then echo "REFUSED: $file diverged locally and on the hub; refusing an overwrite." >&2; return 1; fi
  if [ ! -f "$dst" ]; then
    tmp=$(mktemp "$HUB/.${file}.incoming.XXXXXX") || return 1
    cp "$src" "$tmp" && mv "$tmp" "$dst"
    if ! commit_hub "$HUB" "$message" "$file"; then
      rm -f "$dst"
      echo "REFUSED: hub write for $file was not committed; restored its prior absence." >&2
      return 1
    fi
    printf 'pushed: %s\n' "$file"
  else
    printf 'unchanged: %s\n' "$file"
  fi
}
safe_pull_file() { # <filename>
  local file=$1 src="$HUB/$1" dst="$DATA_DIR/$1" tmp
  [ -e "$src" ] || { printf 'absent on hub: %s\n' "$file"; return 0; }
  [ -f "$src" ] && [ ! -L "$src" ] || { echo "REFUSED: hub target is not a regular file: $file" >&2; return 1; }
  if [ -f "$dst" ] && ! cmp -s "$src" "$dst"; then echo "REFUSED: $file diverged locally and on the hub; refusing an overwrite." >&2; return 1; fi
  if [ ! -e "$dst" ]; then mkdir -p "$DATA_DIR"; tmp=$(mktemp "$DATA_DIR/.${file}.incoming.XXXXXX") || return 1; cp "$src" "$tmp" && mv "$tmp" "$dst"; printf 'pulled: %s\n' "$file"; else printf 'unchanged: %s\n' "$file"; fi
}
status() {
  printf 'Fleet Memory Hub: %s:%s\n' "$REMOTE_HOST" "$REMOTE_DIR"
  if ! require_local_hub; then printf 'Status: OFFLINE / UNREACHABLE\n'; return 1; fi
  printf 'Status: ONLINE\nNot synced (per-machine): %s\n' "${LOCAL_FILES[*]}"
  local file local_sha remote_sha state
  for file in "${FILES[@]}"; do
    local_sha=$(sha_file "$DATA_DIR/$file" 2>/dev/null || true); remote_sha=$(sha_file "$HUB/$file" 2>/dev/null || true)
    case "$local_sha:$remote_sha" in :) state='ABSENT BOTH' ;; :*) state='REMOTE ONLY' ;; *:) state='LOCAL ONLY' ;; "$local_sha:$local_sha") state='IN SYNC' ;; *) state='DIVERGED (REFUSED)' ;; esac
    printf '%s: %s\n' "$file" "$state"
  done
}
format_baton() { # Baton bytes on stdin.
  local machine timestamp summary payload
  payload=$(cat)
  machine=$(printf '%s\n' "$payload" | sed -n 's/^machine=//p' | head -1)
  timestamp=$(printf '%s\n' "$payload" | sed -n 's/^timestamp=//p' | head -1)
  summary=$(printf '%s\n' "$payload" | sed -n 's/^summary=//p' | head -1)
  if [ -n "$machine" ] && [ -n "$summary" ]; then
    printf 'BATON: You were on %s at %s, %s.\n' "$machine" "${timestamp:-an unknown time}" "$summary"
  else
    echo 'BATON: ABSENT - no prior session was confirmed on the hub.'
  fi
}
baton_read() {
  if ! is_local; then
    remote_call read session-baton.md read "$(machine_name)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | format_baton || return 1
    return 0
  fi
  require_local_hub || return 1
  local baton="$HUB/session-baton.md"
  [ -f "$baton" ] && [ ! -L "$baton" ] || { echo 'BATON: ABSENT - no prior session was confirmed on the hub.'; return 0; }
  format_baton < "$baton"
}
baton_stamp() {
  if ! is_local; then
    local remote_tmp
    remote_tmp=$(mktemp "${TMPDIR:-/tmp}/fm-baton.XXXXXX") || return 1
    trap 'rm -f "$remote_tmp"' RETURN
    printf 'machine=%s\ntimestamp=%s\nsummary=%s\n' "$(machine_name)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${*:-open work summary unavailable}" > "$remote_tmp"
    remote_push_file "$remote_tmp" session-baton.md 1
    return $?
  fi
  require_local_hub || return 1
  local baton="$HUB/session-baton.md" tmp backup now owner summary
  owner=$(machine_name); now=$(date -u +%Y-%m-%dT%H:%M:%SZ); summary=${*:-'open work summary unavailable'}
  lock_hub "$HUB" || return 1
  trap 'unlock_hub "$HUB"' RETURN
  tmp=$(mktemp "$HUB/.session-baton.incoming.XXXXXX") || return 1
  backup=$(mktemp "$HUB/.session-baton.before.XXXXXX") || return 1
  [ ! -f "$baton" ] || cp "$baton" "$backup"
  printf 'machine=%s\ntimestamp=%s\nsummary=%s\n' "$owner" "$now" "$summary" > "$tmp"; mv "$tmp" "$baton"
  if ! commit_hub "$HUB" "fleet baton from $owner at $now" session-baton.md; then
    if [ -s "$backup" ]; then mv "$backup" "$baton"; else rm -f "$baton"; fi
    echo 'REFUSED: session baton was not committed on the hub; restored the prior baton.' >&2
    return 1
  fi
  rm -f "$backup"
  printf 'BATON STAMPED: machine=%s timestamp=%s\n' "$owner" "$now"
}
queue_sync() {
  if ! is_local; then
    local owner now
    owner=$(machine_name); now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    remote_call acquire backlog.md queue "$owner" "$now" || return 1
    remote_call claim-queue backlog.md queue "$owner" "$now" || return $?
    if [ -f "$DATA_DIR/backlog.md" ]; then
      remote_push_file "$DATA_DIR/backlog.md" backlog.md 0
      printf 'QUEUE SYNC: hub owner claimed and local backlog verified.\n'
    else
      remote_pull_file backlog.md || return 1
      printf 'QUEUE SYNC: hub owner claimed and backlog pulled.\n'
    fi
    return 0
  fi
  require_local_hub || return 1
  local owner marker="$HUB/.fm-queue-owner" backlog="$DATA_DIR/backlog.md" remote="$HUB/backlog.md" now
  owner=$(machine_name); now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  lock_hub "$HUB" || return 1
  trap 'unlock_hub "$HUB"' RETURN
  if [ -e "$marker" ] && { [ ! -f "$marker" ] || [ -L "$marker" ]; }; then echo 'REFUSED: queue owner marker is unsafe.' >&2; return 1; fi
  if [ -f "$marker" ] && ! grep -Fx "machine=$owner" "$marker" >/dev/null 2>&1; then printf 'QUEUE OWNER CONFLICT: hub queue is owned by %s; this home (%s) will not overwrite it.\n' "$(sed -n 's/^machine=//p' "$marker" | head -1)" "$owner" >&2; return 1; fi
  if [ ! -f "$marker" ]; then
    printf 'machine=%s\nclaimed_at=%s\n' "$owner" "$now" > "$marker"
    if ! commit_hub "$HUB" "queue claimed by $owner at $now" .fm-queue-owner; then
      rm -f "$marker"
      echo 'REFUSED: queue ownership claim was not committed; restored its prior absence.' >&2
      return 1
    fi
  fi
  if [ -f "$backlog" ] && [ -f "$remote" ] && ! cmp -s "$backlog" "$remote"; then echo 'REFUSED: shared backlog diverged locally and on the hub; resolving it requires an explicit review.' >&2; return 1; fi
  if [ -f "$backlog" ] && [ ! -e "$remote" ]; then
    local incoming
    incoming=$(mktemp "$HUB/.backlog.incoming.XXXXXX") || return 1
    cp "$backlog" "$incoming" && mv "$incoming" "$remote"
    if ! commit_hub "$HUB" "queue snapshot from $owner at $now" backlog.md; then
      rm -f "$remote"
      echo 'REFUSED: queue snapshot was not committed; restored its prior absence.' >&2
      return 1
    fi
    echo 'QUEUE SYNC: pushed local backlog after claiming hub ownership.'
  elif [ ! -e "$backlog" ] && [ -f "$remote" ]; then mkdir -p "$DATA_DIR"; cp "$remote" "$backlog"; echo 'QUEUE SYNC: pulled hub backlog after claiming hub ownership.'
  else echo 'QUEUE SYNC: unchanged.'; fi
}

case "${1:-status}" in
  status) status ;;
  push)
    if is_local; then require_local_hub; for f in "${FILES[@]}"; do safe_push_file "$f" "shared memory snapshot from $(machine_name)"; done
    else for f in "${FILES[@]}"; do [ ! -f "$DATA_DIR/$f" ] || remote_push_file "$DATA_DIR/$f" "$f" 0; done; fi
    ;;
  pull)
    if is_local; then require_local_hub; for f in "${FILES[@]}"; do safe_pull_file "$f"; done
    else for f in "${FILES[@]}"; do remote_pull_file "$f"; done; fi
    ;;
  baton-read) baton_read ;;
  baton-stamp) shift; baton_stamp "$@" ;;
  queue-sync) queue_sync ;;
  *) echo 'usage: fm-sync-memory.sh <status|push|pull|baton-read|baton-stamp|queue-sync>' >&2; exit 2 ;;
esac
