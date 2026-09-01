#!/usr/bin/env bash
# Behavior tests for the Google Antigravity CLI (agy) crew and primary adapter.
# Its version-gated rendered busy source is verified, while --secondmate stays
# refused because no safe addressable interrupt exists across supported backends.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SPAWN="$ROOT/bin/fm-spawn.sh"
TMP_ROOT=$(fm_test_tmproot fm-antigravity-harness)
BASE_PATH=${FM_TEST_BASE_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}

cleanup_antigravity_harness() {
  rm -rf "$TMP_ROOT"
}
trap cleanup_antigravity_harness EXIT

make_spawn_fakebin() {
  local dir=$1 fakebin
  fakebin=$(fm_fakebin "$dir")
  cat > "$fakebin/tmux" <<'SH'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$FM_FAKE_TMUX_CALL_LOG"
state=$(cat "$FM_FAKE_AGY_STATE" 2>/dev/null || true)
fake_screen() {
  case "$state" in
    ready)
      printf 'Antigravity CLI 1.1.10\n────────────────────────\n>\n────────────────────────\n? for shortcuts\n'
      ;;
    delivered)
      printf '> Read the brief at %s and follow it exactly.\n\n● Read(...)\n────────────────────────\n>\n────────────────────────\n? for shortcuts\n' "$FM_FAKE_BRIEF_REAL"
      ;;
    *)
      printf 'shell starting\n$ \n'
      ;;
  esac
}
case "$*" in
  *"#{pane_current_path}"*) printf '%s\n' "$FM_FAKE_PANE_PATH"; exit 0 ;;
  *"#{cursor_y}"*) printf '3\n'; exit 0 ;;
esac
case "${1:-}" in
  display-message) printf 'firstmate\n'; exit 0 ;;
  list-windows) exit 0 ;;
  has-session|new-session|new-window|kill-window) exit 0 ;;
  send-keys)
    prev=
    literal=
    for arg in "$@"; do
      if [ "$prev" = -l ]; then literal=$arg; break; fi
      prev=$arg
    done
    if [ -n "$literal" ]; then
      case "$literal" in
        *'--dangerously-skip-permissions')
          printf '%s\n' "$literal" >> "$FM_FAKE_LAUNCH_LOG"
          if [ "${FM_FAKE_AGY_READY:-yes}" = yes ]; then
            printf 'ready\n' > "$FM_FAKE_AGY_STATE"
          else
            printf 'launched\n' > "$FM_FAKE_AGY_STATE"
          fi
          ;;
        *)
          printf '%s\n' "$literal" >> "$FM_FAKE_POINTER_LOG"
          printf 'delivered\n' > "$FM_FAKE_AGY_STATE"
          ;;
      esac
      exit 0
    fi
    exit 0
    ;;
  capture-pane)
    start= end= prev=
    for arg in "$@"; do
      case "$prev" in
        -S) start=$arg ;;
        -E) end=$arg ;;
      esac
      case "$arg" in -S|-E) prev=$arg ;; *) prev= ;; esac
    done
    case "$start:$end" in
      *[!0-9:]*|'':*|*:'') fake_screen ;;
      *) fake_screen | awk -v start="$start" -v end="$end" \
           'NR - 1 >= start && NR - 1 <= end' ;;
    esac
    exit 0
    ;;
esac
exit 0
SH
  chmod +x "$fakebin/tmux"
  fm_fake_exit0 "$fakebin" treehouse gh-axi gh
  cat > "$fakebin/agy" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" = --version ] && printf '1.1.23\n'
exit 0
SH
  chmod +x "$fakebin/agy"
  printf '%s\n' "$fakebin"
}

make_spawn_case() {
  local name=$1 id=$2 case_dir home proj wt fakebin
  case_dir="$TMP_ROOT/$name"
  home="$case_dir/home"
  proj="$case_dir/project"
  wt="$case_dir/wt"
  fakebin=$(make_spawn_fakebin "$case_dir/fake")
  mkdir -p "$home/data/$id" "$home/projects" "$home/state" "$home/config"
  printf 'brief for antigravity\n' > "$home/data/$id/brief.md"
  printf 'antigravity\n' > "$home/config/crew-harness"
  fm_git_worktree "$proj" "$wt" "wt-$name"
  touch "$home/state/.last-watcher-beat"
  : > "$case_dir/launch.log"
  : > "$case_dir/pointer.log"
  : > "$case_dir/agy.state"
  : > "$case_dir/tmux-calls.log"
  printf '%s\n' "$case_dir|$home|$proj|$wt|$fakebin"
}

run_spawn() {
  local case_dir=$1 home=$2 proj=$3 wt=$4 fakebin=$5 id=$6
  shift 6
  HOME="$home" FM_ROOT_OVERRIDE='' FM_HOME="$home" \
    FM_STATE_OVERRIDE="$home/state" FM_DATA_OVERRIDE="$home/data" \
    FM_PROJECTS_OVERRIDE="$home/projects" FM_CONFIG_OVERRIDE="$home/config" \
    FM_SPAWN_NO_GUARD=1 FM_FAKE_PANE_PATH="$wt" TMUX="fake,1,0" \
    FM_FAKE_LAUNCH_LOG="$case_dir/launch.log" \
    FM_FAKE_POINTER_LOG="$case_dir/pointer.log" \
    FM_FAKE_AGY_STATE="$case_dir/agy.state" \
    FM_FAKE_TMUX_CALL_LOG="$case_dir/tmux-calls.log" \
    FM_FAKE_BRIEF_REAL="$(cd "$home/data/$id" && pwd -P)/brief.md" \
    FM_AGY_READY_POLLS=2 FM_AGY_POLL_INTERVAL=0 \
    PATH="$fakebin:$BASE_PATH" \
    "$SPAWN" "$id" "$proj" --harness antigravity --mode no-mistakes --yolo off "$@" 2>&1
}

read_spawn_record() {
  IFS='|' read -r CASE_DIR HOME_DIR PROJ_DIR WT_DIR FAKEBIN_DIR <<EOF
$1
EOF
}

test_antigravity_launch_then_send_is_verified() {
  local id rec out rc launch pointer brief_real meta
  id="agy-success-z1-$$"
  rec=$(make_spawn_case success "$id")
  read_spawn_record "$rec"
  out=$(run_spawn "$CASE_DIR" "$HOME_DIR" "$PROJ_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$id" \
    --model gemini-3.6-flash --effort low)
  rc=$?
  expect_code 0 "$rc" "verified antigravity launch-then-send should succeed"
  assert_contains "$out" "spawned $id harness=antigravity" "antigravity spawn did not report success"

  launch=$(cat "$CASE_DIR/launch.log")
  [ "$launch" = "'$FAKEBIN_DIR/agy' --model 'gemini-3.6-flash' --effort 'low' --dangerously-skip-permissions" ] \
    || fail "antigravity launch did not use the absolute binary, model, effort, and autonomy flag: $launch"

  brief_real="$(cd "$HOME_DIR/data/$id" && pwd -P)/brief.md"
  pointer=$(cat "$CASE_DIR/pointer.log")
  [ "$pointer" = "Read the brief at $brief_real and follow it exactly." ] \
    || fail "antigravity pointer was not the exact absolute-path-only instruction: $pointer"
  meta="$HOME_DIR/state/$id.meta"
  assert_grep 'model=gemini-3.6-flash' "$meta" "antigravity meta lost the requested model"
  assert_grep 'effort=low' "$meta" "antigravity meta lost the requested effort"
  pass "fm-spawn: antigravity launches bare, delivers its brief pointer after readiness"
}

test_antigravity_effort_omitted_when_unsupported() {
  local id rec out rc launch
  id="agy-xhigh-z2-$$"
  rec=$(make_spawn_case xhigh "$id")
  read_spawn_record "$rec"
  out=$(run_spawn "$CASE_DIR" "$HOME_DIR" "$PROJ_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$id" \
    --model gemini-3.6-flash --effort xhigh)
  rc=$?
  expect_code 0 "$rc" "antigravity spawn with an unsupported effort ceiling should still launch"
  launch=$(cat "$CASE_DIR/launch.log")
  assert_not_contains "$launch" "--effort" "antigravity launch emitted an unsupported effort flag (agy only accepts low|medium|high)"
  assert_grep 'effort=xhigh' "$HOME_DIR/state/$id.meta" \
    "antigravity meta did not retain the unsupported requested effort axis"
  pass "fm-spawn: antigravity omits an effort value outside its low|medium|high ceiling rather than passing it"
}

test_antigravity_model_without_effort_omits_effort_flag() {
  local id rec out rc launch
  id="agy-noeffort-z3-$$"
  rec=$(make_spawn_case noeffort "$id")
  read_spawn_record "$rec"
  out=$(run_spawn "$CASE_DIR" "$HOME_DIR" "$PROJ_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$id" \
    --model claude-sonnet-4-6)
  rc=$?
  expect_code 0 "$rc" "antigravity spawn with a model and no effort should launch"
  launch=$(cat "$CASE_DIR/launch.log")
  [ "$launch" = "'$FAKEBIN_DIR/agy' --model 'claude-sonnet-4-6' --dangerously-skip-permissions" ] \
    || fail "antigravity launch with no requested effort emitted an unexpected command: $launch"
  pass "fm-spawn: antigravity threads --model alone when no effort is requested"
}

test_antigravity_readiness_gate_precedes_pointer() {
  local id rec out rc
  id="agy-not-ready-z4-$$"
  rec=$(make_spawn_case not-ready "$id")
  read_spawn_record "$rec"
  rc=0
  out=$(FM_FAKE_AGY_READY=no run_spawn \
    "$CASE_DIR" "$HOME_DIR" "$PROJ_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$id") || rc=$?
  [ "$rc" -ne 0 ] || fail "antigravity spawn without a ready signal should fail"
  assert_contains "$out" "agy did not show a verified idle ready signal" \
    "antigravity readiness failure lacked a loud diagnostic"
  [ ! -s "$CASE_DIR/pointer.log" ] || fail "antigravity pointer was sent before readiness"
  pass "fm-spawn: antigravity never sends the brief pointer before the idle-footer ready signal"
}

test_antigravity_missing_binary_refuses_before_pane_creation() {
  local id rec out rc
  id="agy-missing-z5-$$"
  rec=$(make_spawn_case missing "$id")
  read_spawn_record "$rec"
  rm "$FAKEBIN_DIR/agy"
  rc=0
  out=$(run_spawn "$CASE_DIR" "$HOME_DIR" "$PROJ_DIR" "$WT_DIR" "$FAKEBIN_DIR" "$id") || rc=$?
  [ "$rc" -ne 0 ] || fail "missing agy executable should refuse the spawn"
  assert_contains "$out" "agy executable not found on PATH" "missing agy diagnostic omitted PATH"
  if grep -Eq '(^| )new-(session|window)( |$)' "$CASE_DIR/tmux-calls.log"; then
    fail "missing agy executable created a tmux container or pane"
  fi
  pass "fm-spawn: missing agy executable refuses before pane creation"
}

test_antigravity_secondmate_spawn_is_refused() {
  local id rec out rc
  id="agy-secondmate-z6-$$"
  rec=$(make_spawn_case secondmate "$id")
  read_spawn_record "$rec"
  mkdir -p "$HOME_DIR/data"
  printf 'secondmate charter\n' > "$HOME_DIR/data/charter.md"
  rc=0
  out=$(HOME="$HOME_DIR" FM_ROOT_OVERRIDE='' FM_HOME="$HOME_DIR" \
    FM_STATE_OVERRIDE="$HOME_DIR/state" FM_DATA_OVERRIDE="$HOME_DIR/data" \
    FM_PROJECTS_OVERRIDE="$HOME_DIR/projects" FM_CONFIG_OVERRIDE="$HOME_DIR/config" \
    FM_SPAWN_NO_GUARD=1 TMUX="fake,1,0" PATH="$FAKEBIN_DIR:$BASE_PATH" \
    "$SPAWN" "$id" "$HOME_DIR" --harness antigravity --secondmate 2>&1) || rc=$?
  [ "$rc" -ne 0 ] || fail "antigravity --secondmate spawn should be refused in this first cut"
  assert_contains "$out" "unknown harness 'antigravity'" \
    "antigravity secondmate refusal lacked the expected diagnostic"
  pass "fm-spawn: antigravity is not yet extended to --secondmate"
}

test_antigravity_detection_uses_ancestry_after_markers() {
  local dir fakebin cfg out
  dir="$TMP_ROOT/detection"
  fakebin=$(fm_fakebin "$dir")
  cfg="$dir/config"
  mkdir -p "$cfg"
  cat > "$fakebin/ps" <<'SH'
#!/usr/bin/env bash
set -u
field=
pid=
prev=
for arg in "$@"; do
  [ "$prev" = -o ] && field=$arg
  [ "$prev" = -p ] && pid=$arg
  prev=$arg
done
case "$field:$pid" in
  comm=:4242) printf '/home/x/.local/bin/agy\n' ;;
  comm=:*) printf '/bin/bash\n' ;;
  ppid=:4242) printf '1\n' ;;
  ppid=:*) printf '4242\n' ;;
  args=:*) printf 'bash\n' ;;
esac
SH
  chmod +x "$fakebin/ps"

  out=$(env -u CLAUDECODE -u PI_CODING_AGENT -u GROK_AGENT \
    PATH="$fakebin:$BASE_PATH" FM_CONFIG_OVERRIDE="$cfg" "$ROOT/bin/fm-harness.sh")
  [ "$out" = antigravity ] || fail "antigravity ancestry detection returned '$out'"
  out=$(CLAUDECODE=1 PATH="$fakebin:$BASE_PATH" FM_CONFIG_OVERRIDE="$cfg" "$ROOT/bin/fm-harness.sh")
  [ "$out" = claude ] || fail "verified env-marker precedence changed, got '$out'"
  pass "fm-harness: markerless antigravity (agy) is detected by ancestry after env-marker precedence"
}

test_antigravity_busy_state_uses_two_independent_positive_signals() {
  local state out
  # shellcheck source=/dev/null
  . "$ROOT/bin/fm-busy-lib.sh"
  state="$TMP_ROOT/busy-state"
  mkdir -p "$state"
  # shellcheck disable=SC2329 # invoked indirectly by fm_busy_antigravity_verified
  fm_busy_antigravity_version() { printf '1.1.23'; }

  out=$(fm_busy_classify tmux fake antigravity agy-busy-z7 "$state" 'Working...\nesc to cancel')
  [ "$out" = "busy antigravity-rendered" ] \
    || fail "the active-turn footer did not independently classify busy: $out"

  out=$(fm_busy_classify tmux fake antigravity agy-busy-z7 "$state" '? for shortcuts\nGemini 3.7 Flash · low · 2 task(s) · /tasks')
  [ "$out" = "busy antigravity-rendered" ] \
    || fail "the background-task counter did not independently classify busy: $out"

  out=$(fm_busy_classify tmux fake antigravity agy-busy-z7 "$state" '? for shortcuts\nGemini 3.7 Flash · low')
  [ "$out" = "idle antigravity-rendered" ] \
    || fail "the settled footer without either busy signal did not classify idle: $out"

  out=$(fm_busy_classify tmux fake antigravity agy-busy-z7 "$state" '● Bash(done)\n>')
  [ "$out" = "unknown antigravity-rendered" ] \
    || fail "an ambiguous animated tool marker should stay unknown: $out"

  [ -z "$(fm_busy_sources_for_harness antigravity)" ] \
    || fail "antigravity must not trust a stored record source without a writer"
  pass "busy detection: agy uses independent turn and task signals and narrows idle to a settled footer"
}

test_antigravity_busy_state_fails_closed_on_version_drift() {
  local state out
  # shellcheck source=/dev/null
  . "$ROOT/bin/fm-busy-lib.sh"
  state="$TMP_ROOT/busy-version-drift"
  mkdir -p "$state"
  # shellcheck disable=SC2329 # invoked indirectly by fm_busy_antigravity_verified
  fm_busy_antigravity_version() { printf '1.1.24'; }
  out=$(fm_busy_classify tmux fake antigravity agy-busy-z8 "$state" 'esc to cancel')
  [ "$out" = "unknown antigravity-unverified" ] \
    || fail "an unverified agy version must fail closed, got: $out"
  pass "busy detection: an unverified agy version fails closed with a named source"
}

test_antigravity_launch_then_send_is_verified
test_antigravity_effort_omitted_when_unsupported
test_antigravity_model_without_effort_omits_effort_flag
test_antigravity_readiness_gate_precedes_pointer
test_antigravity_missing_binary_refuses_before_pane_creation
test_antigravity_secondmate_spawn_is_refused
test_antigravity_detection_uses_ancestry_after_markers
test_antigravity_busy_state_uses_two_independent_positive_signals
test_antigravity_busy_state_fails_closed_on_version_drift
