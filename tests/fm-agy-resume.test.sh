#!/usr/bin/env bash
# Behavior tests for the antigravity (agy) resume-with-verification helper
# (bin/fm-agy-resume.sh). A fake `tmux` plays back a pre-scripted sequence of
# pane captures (one file per poll) so each scenario can exercise the
# script's real verification logic - including two bugs found and fixed
# during live testing: a transitional partial footer render, and stale
# scrollback from an earlier resume attempt in the same pane.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RESUME="$ROOT/bin/fm-agy-resume.sh"
TMP_ROOT=$(fm_test_tmproot fm-agy-resume)
BASE_PATH=${FM_TEST_BASE_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}

cleanup_agy_resume() {
  rm -rf "$TMP_ROOT"
}
trap cleanup_agy_resume EXIT

# make_fakebin: <captures-dir> holds numbered files 0, 1, 2, ... Each
# capture-pane call returns the next file's content, staying on the last
# file once the sequence is exhausted (steady state), so a script that
# polls until something settles reliably converges.
make_fakebin() {
  local dir=$1 captures_dir=$2 fakebin
  fakebin=$(fm_fakebin "$dir")
  mkdir -p "$dir/state"
  printf '0\n' > "$dir/state/counter"
  cat > "$fakebin/tmux" <<SH
#!/usr/bin/env bash
set -u
CAPTURES_DIR="$captures_dir"
COUNTER_FILE="$dir/state/counter"
SEND_LOG="$dir/state/send.log"
case "\${1:-}" in
  display-message) printf 'firstmate\n'; exit 0 ;;
  send-keys)
    printf '%s\n' "\$*" >> "\$SEND_LOG"
    exit 0
    ;;
  capture-pane)
    n=\$(cat "\$COUNTER_FILE" 2>/dev/null || printf '0')
    last=\$(ls "\$CAPTURES_DIR" | sort -n | tail -n 1)
    [ "\$n" -lt "\$last" ] 2>/dev/null && echo \$((n + 1)) > "\$COUNTER_FILE"
    [ -f "\$CAPTURES_DIR/\$n" ] || n=\$last
    cat "\$CAPTURES_DIR/\$n"
    exit 0
    ;;
esac
exit 0
SH
  chmod +x "$fakebin/tmux"
  printf '%s\n' "$fakebin"
}

make_task_meta() {
  local home=$1 id=$2
  mkdir -p "$home/state"
  printf 'window=fake:0\nharness=antigravity\nbackend=tmux\n' > "$home/state/$id.meta"
}

FOOTER_READY='? for shortcuts                                                                                                                                                              Claude Sonnet 4.6 (Thinking)'
FOOTER_PARTIAL='? for shortcuts'
BANNER='      Antigravity CLI 1.1.10'

test_agy_resume_requires_model() {
  local home dir out rc id
  id="agy-resume-nomodel-$$"
  dir="$TMP_ROOT/nomodel-$id"
  home="$dir/home"
  make_task_meta "$home" "$id"
  rc=0
  out=$(FM_HOME="$home" PATH="$BASE_PATH" "$RESUME" "$id" "some-conv-id" 2>&1) || rc=$?
  [ "$rc" -ne 0 ] || fail "resume without --model should be refused"
  assert_contains "$out" "--model is required" "missing-model refusal lacked the expected diagnostic"
  pass "fm-agy-resume: refuses a resume with no --model rather than trust agy's silent default"
}

test_agy_resume_refuses_non_antigravity_task() {
  local home dir out rc id
  id="agy-resume-wrongharness-$$"
  dir="$TMP_ROOT/wrongharness-$id"
  home="$dir/home"
  mkdir -p "$home/state"
  printf 'window=fake:0\nharness=kimi\nbackend=tmux\n' > "$home/state/$id.meta"
  rc=0
  out=$(FM_HOME="$home" PATH="$BASE_PATH" "$RESUME" "$id" "some-conv-id" --model gemini-3.6-flash 2>&1) || rc=$?
  [ "$rc" -ne 0 ] || fail "resume on a non-antigravity task should be refused"
  assert_contains "$out" "not antigravity" "wrong-harness refusal lacked the expected diagnostic"
  pass "fm-agy-resume: refuses a task not recorded as harness=antigravity"
}

test_agy_resume_catches_silent_model_fallback() {
  local home dir out rc id fakebin captures
  id="agy-resume-fallback-$$"
  dir="$TMP_ROOT/fallback-$id"
  home="$dir/home"
  captures="$dir/captures"
  mkdir -p "$captures"
  make_task_meta "$home" "$id"
  {
    printf '%s\n' "$BANNER"
    printf '⚠ Warning\n'
    printf '  ⎿  "gemini-3.1-pro-high" is no longer available. Using "Gemini 3.6 Flash (High)".\n'
    printf '%s\n' "$FOOTER_READY"
  } > "$captures/0"
  fakebin=$(make_fakebin "$dir/fake" "$captures")

  rc=0
  out=$(FM_HOME="$home" PATH="$fakebin:$BASE_PATH" "$RESUME" "$id" "conv-1" --model gemini-3.1-pro --effort high 2>&1) || rc=$?
  [ "$rc" -ne 0 ] || fail "resume must fail when agy prints its own model-fallback warning"
  assert_contains "$out" "silently substituted a different model" "fallback detection lacked the expected diagnostic"
  assert_contains "$out" "is no longer available" "fallback diagnostic dropped agy's own warning text"
  pass "fm-agy-resume: catches agy's own silent model-substitution warning and refuses to trust the session"
}

test_agy_resume_ignores_stale_warning_before_fresh_banner() {
  local home dir out rc id fakebin captures
  id="agy-resume-stalewarning-$$"
  dir="$TMP_ROOT/stalewarning-$id"
  home="$dir/home"
  captures="$dir/captures"
  mkdir -p "$captures"
  make_task_meta "$home" "$id"
  # Regression fixture for a live-found bug: an EARLIER resume attempt's
  # fallback warning is still sitting in scrollback above THIS attempt's own
  # fresh banner and footer. The warning-scan must anchor on the latest
  # banner and never fail on stale content above it.
  {
    printf '%s\n' "$BANNER"
    printf '⚠ Warning\n'
    printf '  ⎿  "gemini-3.1-pro-high" is no longer available. Using "Gemini 3.6 Flash (High)".\n'
    printf '%s\n' "$FOOTER_READY"
    printf '%s\n' "$BANNER"
    printf '%s\n' "$FOOTER_READY"
  } > "$captures/0"
  fakebin=$(make_fakebin "$dir/fake" "$captures")

  out=$(FM_HOME="$home" PATH="$fakebin:$BASE_PATH" "$RESUME" "$id" "conv-2" --model claude-sonnet-4-6 2>&1)
  rc=$?
  expect_code 0 "$rc" "resume must succeed when the only fallback warning is stale scrollback from an earlier attempt"
  assert_contains "$out" "resumed $id" "successful resume output was missing its confirmation line"
  pass "fm-agy-resume: does not fail on a stale fallback warning left over from an earlier resume in the same pane"
}

test_agy_resume_waits_out_a_transitional_partial_footer() {
  local home dir out rc id fakebin captures
  id="agy-resume-partial-$$"
  dir="$TMP_ROOT/partial-$id"
  home="$dir/home"
  captures="$dir/captures"
  mkdir -p "$captures"
  make_task_meta "$home" "$id"
  # Regression fixture for a live-found bug: the idle footer's left half
  # ("? for shortcuts") can render one poll before its right-aligned
  # model/effort segment does. A readiness check keyed only on the left half
  # would accept this transitional frame and then read an empty/wrong model.
  {
    printf '%s\n' "$BANNER"
    printf '%s\n' "$FOOTER_PARTIAL"
  } > "$captures/0"
  {
    printf '%s\n' "$BANNER"
    printf '%s\n' "$FOOTER_PARTIAL"
  } > "$captures/1"
  {
    printf '%s\n' "$BANNER"
    printf '%s\n' "$FOOTER_READY"
  } > "$captures/2"
  fakebin=$(make_fakebin "$dir/fake" "$captures")

  out=$(FM_HOME="$home" FM_AGY_RESUME_POLL_INTERVAL=0 PATH="$fakebin:$BASE_PATH" \
    "$RESUME" "$id" "conv-3" --model claude-sonnet-4-6 2>&1)
  rc=$?
  expect_code 0 "$rc" "resume must wait out a transitional partial footer instead of accepting it early"
  assert_contains "$out" "Claude Sonnet 4.6" "resume did not wait for the fully-rendered footer before reporting success"
  pass "fm-agy-resume: waits for the fully-rendered footer instead of trusting a transitional partial render"
}

test_agy_resume_succeeds_on_matching_family() {
  local home dir out rc id fakebin captures
  id="agy-resume-success-$$"
  dir="$TMP_ROOT/success-$id"
  home="$dir/home"
  captures="$dir/captures"
  mkdir -p "$captures"
  make_task_meta "$home" "$id"
  {
    printf '%s\n' "$BANNER"
    printf '%s\n' "$FOOTER_READY"
  } > "$captures/0"
  fakebin=$(make_fakebin "$dir/fake" "$captures")

  out=$(FM_HOME="$home" PATH="$fakebin:$BASE_PATH" "$RESUME" "$id" "conv-4" --model claude-sonnet-4-6 2>&1)
  rc=$?
  expect_code 0 "$rc" "a clean resume with a matching model family should succeed"
  assert_contains "$out" "resumed $id conversation=conv-4 model=claude-sonnet-4-6" "success output lost the resume identity"
  pass "fm-agy-resume: succeeds and reports the footer when the requested model family matches"
}

test_agy_resume_requires_model
test_agy_resume_refuses_non_antigravity_task
test_agy_resume_catches_silent_model_fallback
test_agy_resume_ignores_stale_warning_before_fresh_banner
test_agy_resume_waits_out_a_transitional_partial_footer
test_agy_resume_succeeds_on_matching_family
