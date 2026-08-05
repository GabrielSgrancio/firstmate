#!/usr/bin/env bash
# Resume an existing antigravity (agy) conversation with its model/effort
# explicitly reasserted, and verify the resumed session actually landed on the
# expected model family before trusting it.
#
# Usage: fm-agy-resume.sh <task-id> <conversation-id> --model <slug> [--effort <level>]
#
# Live-verified 2026-08-05: a bare `agy -c` / `--conversation=<id>` resume with
# no --model silently continues on a DIFFERENT model than the one the
# conversation started on (observed switching gemini-3.6-flash/low to Gemini
# 3.1 Pro, the account's own apparent default). Passing --model (and --effort,
# for a model that supports it) explicitly on the SAME --conversation=<id> call
# was confirmed to genuinely change the active model - including across
# providers, Gemini to Claude, while still correctly recalling prior
# conversation content - so this script refuses to resume without an explicit
# --model rather than silently trusting agy's own default.
#
# Precondition: the task's recorded pane is a live bare shell (the previous agy
# process already exited or crashed) inside the task's own worktree. This
# script does not create a window, pane, or worktree, and does not know how to
# recover a fully torn-down endpoint - see stuck-crewmate-recovery for that.
#
# Verification is deliberately loose: it checks that the family keyword of the
# requested slug (its leading letters-only token, e.g. "gemini", "claude",
# "gpt") appears in the post-resume idle footer. That catches the dangerous
# case actually observed live - a silent cross-provider switch - without
# hardcoding a slug-to-display-name table anywhere; agy's own model catalog
# (`agy models`, and the harness-adapters skill "Model support discovery") stays
# the only source of truth for exact model identity. A family match is
# necessary but not sufficient proof of the exact requested tier, so the full
# footer is always printed for a human to also judge directly.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

usage() {
  awk '
    NR == 1 { next }
    /^#/ { sub(/^# ?/, ""); print; next }
    { exit }
  ' "$0"
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac

# shellcheck source=bin/fm-backend.sh
. "$SCRIPT_DIR/fm-backend.sh"

ID=${1:-}
CONV=${2:-}
if [ -z "$ID" ] || [ -z "$CONV" ]; then
  usage >&2
  exit 1
fi
shift 2 || true

MODEL=
EFFORT=
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL=${2:-}; shift 2 || true ;;
    --effort) EFFORT=${2:-}; shift 2 || true ;;
    *) echo "error: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

if [ -z "$MODEL" ]; then
  echo "error: --model is required; a bare antigravity resume was live-verified to silently switch models (see this script's header)" >&2
  exit 1
fi

META="$STATE/$ID.meta"
if [ ! -f "$META" ]; then
  echo "error: no meta for task $ID at $META" >&2
  exit 1
fi
HARNESS=$(sed -n 's/^harness=//p' "$META" | head -n 1)
if [ "$HARNESS" != antigravity ]; then
  echo "error: task $ID is recorded as harness=$HARNESS, not antigravity; fm-agy-resume.sh is antigravity-only" >&2
  exit 1
fi

T=$(fm_backend_resolve_selector "$ID" "$STATE")
BACKEND=$(fm_backend_of_selector "$ID" "$T" "$STATE")
EXPECTED_LABEL=$(fm_backend_expected_label_of_selector "$ID" "$STATE")

RESUME_CMD="agy --conversation=$CONV --model $MODEL"
[ -z "$EFFORT" ] || RESUME_CMD="$RESUME_CMD --effort $EFFORT"
RESUME_CMD="$RESUME_CMD --dangerously-skip-permissions"

# The resume command is typed into a BARE SHELL prompt (the previous agy
# process already exited), the same situation fm-spawn.sh's own launch step
# handles with direct literal+key sends rather than fm-send.sh's
# composer-aware submit verification. Reusing fm-send.sh here was
# live-verified to misfire: its agent-composer-tuned retry logic reported
# "delivery unconfirmed" for this long, UUID-bearing command line even when
# the shell had genuinely accepted and run it, which would have masked the
# real model-fallback failure below with a wrong diagnostic. Mirroring
# fm-spawn.sh's own launch sequence (literal text, settle, Enter, settle)
# avoids that false negative.
agy_resume_send_literal() {  # <backend> <target> <text>
  fm_backend_source "$1" || return 1
  case "$1" in
    tmux) fm_backend_tmux_send_literal "$2" "$3" ;;
    herdr) fm_backend_herdr_send_literal "$2" "$3" ;;
    zellij) fm_backend_zellij_send_literal "$2" "$3" "$EXPECTED_LABEL" ;;
    orca) fm_backend_orca_send_literal "$2" "$3" ;;
    cmux) fm_backend_cmux_send_literal "$2" "$3" "$EXPECTED_LABEL" ;;
    *) return 1 ;;
  esac
}
agy_resume_send_key() {  # <backend> <target> <key>
  fm_backend_source "$1" || return 1
  case "$1" in
    tmux) fm_backend_tmux_send_key "$2" "$3" ;;
    herdr) fm_backend_herdr_send_key "$2" "$3" ;;
    zellij) fm_backend_zellij_send_key "$2" "$3" "$EXPECTED_LABEL" ;;
    orca) fm_backend_orca_send_key "$2" "$3" ;;
    cmux) fm_backend_cmux_send_key "$2" "$3" "$EXPECTED_LABEL" ;;
    *) return 1 ;;
  esac
}

if ! agy_resume_send_literal "$BACKEND" "$T" "$RESUME_CMD"; then
  echo "error: could not type the resume command into $ID" >&2
  exit 1
fi
sleep 0.3
if ! agy_resume_send_key "$BACKEND" "$T" Enter; then
  echo "error: could not submit the resume command to $ID" >&2
  exit 1
fi
sleep 0.3

# The idle footer's left half ("? for shortcuts") and its right-aligned
# model/effort segment were observed to NOT always land in the same render
# pass: a poll can see "? for shortcuts" with nothing after it yet, one beat
# before the model text catches up. Requiring a minimum line length (well
# above the bare 16-character left half, well below any real padded footer)
# rejects that transitional render without hardcoding any model name.
FOOTER_READY_MIN_LEN=${FM_AGY_RESUME_FOOTER_MIN_LEN:-40}
READY_POLLS=${FM_AGY_RESUME_READY_POLLS:-60}
INTERVAL=${FM_AGY_RESUME_POLL_INTERVAL:-0.5}
i=0
pane=
FOOTER=
while [ "$i" -lt "$READY_POLLS" ]; do
  pane=$(fm_backend_capture "$BACKEND" "$T" 20 "$EXPECTED_LABEL" 2>/dev/null || true)
  FOOTER=$(printf '%s\n' "$pane" | grep -F '? for shortcuts' | tail -n 1)
  if [ -n "$FOOTER" ] && [ "${#FOOTER}" -ge "$FOOTER_READY_MIN_LEN" ]; then
    break
  fi
  FOOTER=
  i=$((i + 1))
  [ "$i" -ge "$READY_POLLS" ] || sleep "$INTERVAL"
done
if [ -z "$FOOTER" ]; then
  echo "error: agy did not show a fully-rendered ready idle footer after the resume command; inspect task $ID" >&2
  exit 1
fi

# agy itself can silently substitute a different model when the exact
# requested tier has become unavailable, printing an explicit "is no longer
# available... Using ..." warning rather than refusing - live-verified
# 2026-08-05 when a model available hours earlier in the same investigation
# (gemini-3.1-pro-high) had already disappeared from the account's catalog.
# That warning is the most reliable fallback signal available (far more
# precise than a family-only footer check, which cannot tell two Gemini
# tiers apart), so it is checked first and treated as an unconditional
# failure regardless of what the footer shows.
# Scoped to content from THIS resume attempt's own fresh launch banner
# onward - a longer capture depth alone would also catch a stale warning
# still sitting in the pane's scrollback from an earlier resume attempt in
# the same pane, which was live-observed to cause a false failure here.
# "Antigravity CLI" is agy's own fixed banner line, printed once per fresh
# process launch, so anchoring on its last occurrence reliably excludes
# older scrollback without needing to match the (long, UUID-bearing, possibly
# line-wrapped) resume command text itself.
WARNING_SCAN=$(fm_backend_capture "$BACKEND" "$T" 200 "$EXPECTED_LABEL" 2>/dev/null || true)
BANNER_LINE_NO=$(printf '%s\n' "$WARNING_SCAN" | grep -n 'Antigravity CLI' | tail -n 1 | cut -d: -f1)
if [ -n "$BANNER_LINE_NO" ]; then
  WARNING_SCAN=$(printf '%s\n' "$WARNING_SCAN" | tail -n "+$BANNER_LINE_NO")
fi
if printf '%s\n' "$WARNING_SCAN" | grep -qi 'is no longer available'; then
  WARNING_LINE=$(printf '%s\n' "$WARNING_SCAN" | grep -i 'is no longer available' | tail -n 1)
  echo "error: resume verification failed for $ID - agy silently substituted a different model: $WARNING_LINE" >&2
  echo "error: refusing to trust this session rather than continuing on an unrequested model" >&2
  exit 1
fi

FAMILY=$(printf '%s' "$MODEL" | grep -oE '^[A-Za-z]+' | tr '[:upper:]' '[:lower:]')
FOOTER_LOWER=$(printf '%s' "$FOOTER" | tr '[:upper:]' '[:lower:]')
case "$FOOTER_LOWER" in
  *"$FAMILY"*) : ;;
  *)
    echo "error: resume verification failed for $ID - requested model family '$FAMILY' (from --model $MODEL) was not found in the post-resume footer: $FOOTER" >&2
    echo "error: a bare antigravity resume is known to silently switch models; refusing to trust this session rather than continuing on an unexpected model" >&2
    exit 1
    ;;
esac

echo "resumed $ID conversation=$CONV model=$MODEL${EFFORT:+ effort=$EFFORT} footer: $FOOTER"
echo "note: family-level match only ('$FAMILY') - this does not prove the exact requested tier was used; agy's own catalog (agy models) is the source of truth for exact identity" >&2
