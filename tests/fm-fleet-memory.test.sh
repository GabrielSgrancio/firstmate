#!/usr/bin/env bash
# Behavior coverage for hub-backed fleet continuity and fail-closed memory sync.
set -eu

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v tasks-axi >/dev/null 2>&1 || { echo 'skip: tasks-axi not found'; exit 0; }

TMP_ROOT=$(fm_test_tmproot fm-fleet-memory-tests)
FM_TEST_CLEANUP_DIRS+=("$TMP_ROOT")
trap fm_test_cleanup EXIT
fm_git_identity fleet-memory-test fleet-memory-test@example.invalid

new_home() {
  local name=$1 home="$TMP_ROOT/$1"
  mkdir -p "$home/data" "$home/config"
  printf 'local\n' > "$home/config/fleet-memory-host"
  printf '%s\n' "$TMP_ROOT/hub" > "$home/config/fleet-memory-dir"
  printf '%s\n' "$name" > "$home/config/machine-profile"
  printf '%s\n' "$home"
}

mkdir -p "$TMP_ROOT/hub"
git init -q -b main "$TMP_ROOT/hub"
git -C "$TMP_ROOT/hub" commit -q --allow-empty -m init
HOME_A=$(new_home work-mac)
HOME_B=$(new_home personal-pc)

printf '%s\n' '# shared captain preferences' > "$HOME_A/data/captain-shared.md"
FM_HOME="$HOME_A" "$ROOT/bin/fm-sync-memory.sh" push > "$TMP_ROOT/push.out"
assert_grep 'pushed: captain-shared.md' "$TMP_ROOT/push.out" 'shared captain preferences did not reach the hub'
assert_grep '# shared captain preferences' "$TMP_ROOT/hub/captain-shared.md" 'hub lost shared captain preferences'
[ "$(git -C "$TMP_ROOT/hub" rev-list --count HEAD)" -eq 2 ] || fail 'accepted shared-memory write was not committed'

printf '%s\n' '# divergent local copy' > "$HOME_B/data/captain-shared.md"
if FM_HOME="$HOME_B" "$ROOT/bin/fm-sync-memory.sh" pull > "$TMP_ROOT/diverged.out" 2>&1; then
  fail 'divergent shared-memory pull succeeded'
fi
assert_grep 'REFUSED: captain-shared.md diverged' "$TMP_ROOT/diverged.out" 'divergent pull did not name its safety refusal'
assert_grep '# divergent local copy' "$HOME_B/data/captain-shared.md" 'refused pull overwrote local memory'

printf '%s\n' '## Queued' > "$HOME_A/data/backlog.md"
FM_HOME="$HOME_A" "$ROOT/bin/fm-sync-memory.sh" queue-sync > "$TMP_ROOT/queue-a.out"
assert_grep 'pushed local backlog' "$TMP_ROOT/queue-a.out" 'first owner did not publish its queue'
assert_grep 'machine=work-mac' "$TMP_ROOT/hub/.fm-queue-owner" 'hub queue owner marker did not identify the owner'
if FM_HOME="$HOME_B" "$ROOT/bin/fm-sync-memory.sh" queue-sync > "$TMP_ROOT/queue-b.out" 2>&1; then
  fail 'second machine overwrote an owned queue'
fi
assert_grep 'QUEUE OWNER CONFLICT' "$TMP_ROOT/queue-b.out" 'queue conflict was not surfaced loudly'

FM_HOME="$HOME_A" "$ROOT/bin/fm-sync-memory.sh" baton-stamp 'midway through antigravity work' > "$TMP_ROOT/baton.out"
assert_grep 'BATON STAMPED: machine=work-mac' "$TMP_ROOT/baton.out" 'baton stamp did not identify the originating machine'
FM_HOME="$HOME_B" "$ROOT/bin/fm-sync-memory.sh" baton-read > "$TMP_ROOT/baton-read.out"
assert_grep 'You were on work-mac' "$TMP_ROOT/baton-read.out" 'next home could not read the prior machine baton'
assert_grep 'midway through antigravity work' "$TMP_ROOT/baton-read.out" 'baton lost the captain-facing work summary'

printf 'unreachable\n' > "$HOME_B/config/fleet-memory-host"
before=$(cat "$HOME_B/data/captain-shared.md")
if FM_HOME="$HOME_B" "$ROOT/bin/fm-sync-memory.sh" pull > "$TMP_ROOT/offline.out" 2>&1; then
  fail 'unreachable hub pull unexpectedly succeeded'
fi
assert_grep 'OFFLINE:' "$TMP_ROOT/offline.out" 'offline path did not disclose the unavailable hub'
[ "$before" = "$(cat "$HOME_B/data/captain-shared.md")" ] || fail 'offline path changed local memory'

# Session start must remain a usable local digest when the remote hub cannot be
# reached. A fake SSH boundary makes this portable and proves the composed
# executable interface, not just the sync helper in isolation.
HOME_C=$(new_home offline-mac)
mkdir -p "$HOME_C/state" "$TMP_ROOT/fakebin"
printf '%s\n' '# local memory survives hub outage' > "$HOME_C/data/captain-shared.md"
cat > "$TMP_ROOT/fakebin/ssh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' 'simulated unreachable hub' >&2
exit 255
SH
chmod +x "$TMP_ROOT/fakebin/ssh"
before=$(cat "$HOME_C/data/captain-shared.md")
out=$(FM_HOME="$HOME_C" FM_ROOT_OVERRIDE="$ROOT" FM_MEMORY_HOST=unreachable \
  PATH="$TMP_ROOT/fakebin:$PATH" "$ROOT/bin/fm-session-start.sh" 2>&1)
assert_grep 'MACHINE & FLEET CONTINUITY' <(printf '%s\n' "$out") 'offline session start omitted the continuity section'
assert_grep 'BATON: UNCONFIRMED - hub unavailable; local memory remains available.' <(printf '%s\n' "$out") 'offline session start did not name the unconfirmed baton'
[ "$before" = "$(cat "$HOME_C/data/captain-shared.md")" ] || fail 'offline session start changed local shared memory'

FM_HOME="$HOME_A" "$ROOT/bin/fm-machine-profile.sh" requires-captain merge || fail 'work-mac profile did not constrain merge authority'
if FM_HOME="$HOME_B" "$ROOT/bin/fm-machine-profile.sh" requires-captain merge; then
  fail 'non-work profile unexpectedly constrained merge authority'
fi

TMP_TASKS=$(fm_test_tmproot task-environment-probe)
FM_TEST_CLEANUP_DIRS+=("$TMP_TASKS")
printf 'backend = "markdown"\n\n[markdown]\npath = "backlog.md"\n' > "$TMP_TASKS/.tasks.toml"
(
  cd "$TMP_TASKS"
  "$ROOT/bin/fm-task-environment.sh" add fleet task-env 'Fleet continuity' --kind docs --file "$TMP_TASKS/backlog.md"
)
assert_grep '[environment: fleet]' "$TMP_TASKS/backlog.md" 'environment annotation was not retained in the authoritative backlog'

pass 'fleet memory stays fail-closed, committed, and machine-visible'
