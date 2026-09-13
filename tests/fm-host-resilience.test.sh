#!/usr/bin/env bash
# Unit tests for host resilience and failover scripts.
set -euo pipefail

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TMP_DIR=$(fm_test_tmproot fm-host-resilience)

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Setup mock environment
mkdir -p "$TMP_DIR/bin" "$TMP_DIR/fakebin" "$TMP_DIR/state" "$TMP_DIR/data"
cp "$ROOT/bin/fm-host-checkpoint.sh" "$TMP_DIR/bin/"
cp "$ROOT/bin/fm-host-resume.sh" "$TMP_DIR/bin/"
cp "$ROOT/bin/fm-host-monitor.sh" "$TMP_DIR/bin/"

cat > "$TMP_DIR/fakebin/quota-axi" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"providers":[{"provider":"antigravity","state":{"status":"fresh"},"quotaSemantics":{"status":"known","effectiveAvailability":[{"scope":"gemini","effectivePercentRemaining":50,"limitingWindowIds":["gemini-5h"]}]}}]}'
SH
chmod +x "$TMP_DIR/fakebin/quota-axi"

pushd "$TMP_DIR" >/dev/null
export PATH="$TMP_DIR/fakebin:$PATH"
export FM_HOME="$TMP_DIR"

# 1. Test checkpoint creation
out_cp=$(bin/fm-host-checkpoint.sh --note "test_checkpoint")
[[ "$out_cp" =~ Host\ orchestration\ checkpoint\ created\ successfully ]]
[[ -f "state/host-checkpoint.json" ]]
[[ -f "state/host-checkpoint.md" ]]

# Verify JSON schema
has_ts=$(jq -r '.timestamp // empty' state/host-checkpoint.json)
[[ -n "$has_ts" ]]

# 2. Test resume script
out_res=$(bin/fm-host-resume.sh --host codex)
[[ "$out_res" =~ FirstMate\ Orchestration\ Host\ Resumption ]]
[[ "$out_res" =~ Incoming\ Host:\ codex ]]

# 3. Test monitor script
out_mon=$(bin/fm-host-monitor.sh)
[[ "$out_mon" =~ Host: ]]

popd >/dev/null
echo "tests/fm-host-resilience.test.sh: ok"
