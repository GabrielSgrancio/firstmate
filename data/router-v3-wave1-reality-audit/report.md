# Router V3 Wave 1 reality audit

## Gate result

`ROUTER_V3_WAVE1_GREEN=true`

The audit covered the merged Wave 1 runtime at `bb84e488` and the live primary
`FM_HOME=/home/gabrielsgrancio/agents/captain-workspace`. The fixes in this
branch are the audit changes; no WP3/WP4 work was started.

## Fixes applied

- WP9 promotion now reads the routing policy promotion criteria and requires
  minimum real traffic, minimum successful outcomes, acceptable success rate,
  and complete deterministic evidence. With the live policy's `min_real_n=15`
  and the conservative default absolute threshold of `12/15` and `0.8`, 0/15
  and 1/15 candidates remain non-eligible. `task_completed=true` is not a
  success override when a task class has deterministic signals; missing or
  failed required signals fail the outcome.
- Evaluation state, evidence, and status reporting are keyed to the concrete
  `RouteTarget.route_id`. Updating one route no longer updates every route in
  the same model family; ambiguous model-family selectors now require an
  explicit route ID.
- Automatic challenger exploration now requires retry tolerance, a
  non-critical task, one of `PUBLIC`, `SANITIZED`, or `PRIVATE_CODE`, and a
  successful `evaluateDataGate` check against the concrete route and resolved
  runtime model. `PERSONAL_SENSITIVE` remains excluded from automatic
  exploration.
- Telemetry now represents unclassified legacy ingress as
  `data_class: null` and `classification_status: UNCLASSIFIED_LEGACY`.
  `LAUNCHING` and `RUNNING` events were added at the actual launch handoff and
  post-dispatch boundaries for Router and legacy/manual ingress.
- Legacy/manual `fm-spawn` ingress now carries the canonical classification
  fields and emits the additional lifecycle records without changing selected
  harness/model arguments.

## 1. P0 quota reality

`bin/fm-opencode-quota.mjs` is tracked, executable, and present in commit
`8a00835c1c8b2a3b95a04a87869086e455d21d74` (mode `100755`). A read-only live
run against the authenticated OpenCode Go account exited 0 and produced:

```json
{
  "provider": "opencode_go",
  "pool": "opencode_go",
  "rolling_5h": {"percent_used": 1, "percent_remaining": 99, "status": "ok"},
  "weekly": {"percent_used": 0, "percent_remaining": 100, "status": "ok"},
  "monthly": {"percent_used": 16, "percent_remaining": 84, "status": "ok"},
  "source": "opencode_go_usage_api",
  "stale": false,
  "confidence": "high",
  "scarcity_state": "ABUNDANT"
}
```

The snapshot was materialized at
`data/opencode-go-usage-snapshot.json`. Router telemetry received the same
rolling/weekly/monthly windows and `source=opencode_go_usage_api`.

The enforcement regression injected a stale/unavailable helper result and
verified that Router exposed `opencode_go.scarcity_state=UNKNOWN` and
`status=UNKNOWN`, rather than treating stale last-known-good windows as live.

## 2. WP2 live port and active taxonomy

The live primary files match the reviewed artifacts byte-for-byte:

- `config/data-policy.json` matches `docs/router-v3-wp2-data-policy.json`
  (SHA-256 `1d3d551a57224ec4fa6bdcf53a98b3eac8a0621e6a02d7f1e7af1dd2c39a48e7`).
- `config/provider-privacy-metadata.json` matches
  `docs/router-v3-wp2-provider-privacy-metadata.json` (SHA-256
  `a6854fc3f0dd4bc183804aee8fa930ba4394c6feb0798696f66ccd070f13c10d`).

`node bin/fm-router-v2.mjs validate` passed with 10 canonical roles and 16
models. The live authority exposes exactly:
`PUBLIC`, `SANITIZED`, `PRIVATE_CODE`, `PERSONAL_SENSITIVE`, and `SECRET`.

Live gate checks:

- `WORK_CORPORATE` throws `Unknown data class: WORK_CORPORATE`.
- `SECRET` is absolutely refused.
- Muse (`opencode-go/muse-spark-1.3-contributor`) accepts `PUBLIC`,
  `SANITIZED`, and `PRIVATE_CODE`, and refuses `PERSONAL_SENSITIVE` because
  its verified metadata permits training on prompts/completions.
- Grok 4.6 is refused for `PERSONAL_SENSITIVE` because live metadata records
  30-day retention.
- Verified zero-retention `opencode-go/qwen3.7-max` accepts
  `PERSONAL_SENSITIVE`.
- Missing or unverified per-model metadata refuses `PERSONAL_SENSITIVE`.
- A live `strong_cheap_worker PERSONAL_SENSITIVE` route selected
  `opencode:qwen3.7-max`; Muse was rejected by the data gate.

`LEGACY_UNCLASSIFIED` remains only as an input compatibility value; telemetry
normalizes it to null data class plus `UNCLASSIFIED_LEGACY`. No active runtime
or test path uses `PERSONAL_PRIVATE`, `SHARED_TRAMPOLIM`, or `SYNTHETIC`.

## 3. Promotion and RouteTarget adversarial evidence

The regression suite proves:

- A targeted-edit candidate at 0/15 real successes does not promote.
- A targeted-edit candidate at 1/15 real successes does not promote.
- `task_completed=true` with `tests_pass=false` records a failed deterministic
  outcome and zero success count.
- A 15/15 candidate promotes only with all required deterministic signals
  passing.
- Promoting `codex:shared-luna` leaves `opencode:shared-luna` at
  `BENCHMARK_ONLY`, creates statistics only under
  `role_statistics.fast_precise['codex:shared-luna']`, and status lookup for
  the second route remains empty.

## 4. Real Path A / Path B smoke

Both paths used real post-merge `fm-spawn.sh`/tmux/Codex launches and were
completed successfully. Each record below is from the unified live telemetry
file and each path retained its one `route_execution_id` through terminal
completion.

| Path | route_execution_id | decision marker | actual harness/model | lifecycle | quota after |
|---|---|---|---|---|---|
| A Router/Orchestrator | `rex-1789438157502-176` | `router_v2`; selected `codex:gpt-5.6-terra:medium` | `codex` / `gpt-5.6-terra` | `SELECTED → LAUNCHING → DISPATCHED → RUNNING → COMPLETED` | present; OpenCode Go 99% rolling, 100% weekly, 84% monthly remaining |
| B legacy/manual | `rex-1789438113977-220` | `legacy_manual`; no selected route | `codex` / `gpt-5.6-terra` | `SELECTED → LAUNCHING → DISPATCHED → RUNNING → COMPLETED` | present; OpenCode Go 99% rolling, 100% weekly, 84% monthly remaining |

Path A records `data_class=PUBLIC` and `route_decision.decision_type=router_v2`.
Path B records `data_class=null`,
`classification_status=UNCLASSIFIED_LEGACY`, and
`route_decision.decision_type=legacy_manual`. The live Path B launch preserved
the explicit `codex` / `gpt-5.6-terra` selection.

## 5. Exact validation run

Successful commands run after reconciliation:

```text
node tests/fm-routing-eval.test.mjs
node tests/fm-router-v2-enforcement.test.mjs
node tests/fm-router-ingress.test.mjs
node tests/fm-router-herdr-dispatch-e2e.test.mjs
node tests/fm-dynamic-discovery-acceptance.test.mjs
bin/fm-test-run.sh tests/fm-spawn-dispatch-profile.test.sh
bin/fm-test-run.sh tests/fm-spawn-batch.test.sh
node --check bin/fm-router-v2.mjs
node --check bin/fm-routing-eval.mjs
bash -n bin/fm-spawn.sh
bin/fm-lint.sh
git diff --check
```

The focused Router V3 suites all passed, the spawn dispatch suite reported
all tests passed, ShellCheck and actionlint passed, and the worktree diff is
whitespace-clean.

## Remaining blockers and recommendation

No Wave 1 blocker remains from this ten-item audit. `ROUTER_V3_WAVE1_GREEN`
is true. The next dispatch may proceed with WP3 + WP4; those waves should
consume the now-route-scoped evidence and treat model-family priors as a
separate later aggregation rather than reintroducing family-wide lifecycle
mutation.
