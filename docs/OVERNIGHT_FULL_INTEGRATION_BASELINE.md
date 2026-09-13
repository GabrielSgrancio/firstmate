# Overnight Full Integration Baseline

This document describes the disposable but durable integration oracle and is not a production or canonical-main merge decision.

## References

- Integration branch: `integration/overnight-full-2026-09-13`.
- Integration HEAD: `712b08c9`.
- Canonical baseline before the merge: `65904c3f` on local `main`.
- Preserved overnight source: `overnight/arch-evolution` at `c270d22e`.
- The source branch and archive ref `archive/overnight-arch-evolution-2026-09-13` were not rewritten.
- The merge was local-only and nothing was pushed or opened as a pull request.

## Merge conflict record

- `bin/fm-host-checkpoint.sh` had an add/add conflict, and the main version was retained because its `FM_HOME`, `FM_STATE_OVERRIDE`, and `FM_DATA_OVERRIDE` routing matches the current home contract while overnight hard-coded the repository state directory.
- `bin/fm-host-monitor.sh` had an add/add conflict, and the main version was retained for the same home-routing reason.
- `bin/fm-host-resume.sh` had an add/add conflict, and the main version was retained for the same home-routing reason.
- `bin/fm-mission.sh` had a full-file add/add conflict, and the main version was retained because the landed mission capsule and session schema are the current implementation while overnight supplied a redundant superseded mission-envelope implementation.
- `docs/documentation-audiences.json` had two content conflicts, and the resolution retained the main entries for stale-base and supervisor continuity documents while adding overnight architecture entries and the overnight secondmate-parent-channel entry.
- `tests/fm-cancel.test.sh` had an add/add conflict, and the main version was retained because it contains the landed captain-hold teardown protection regression.
- `tests/fm-host-resilience.test.sh` had an add/add conflict, and the main version was retained because its fixture exercises the current `FM_HOME` contract and quota stub instead of the overnight repository-root-only setup.
- `tests/fm-supervisor-failover-e2e.test.mjs` had an add/add conflict, and the main version was retained because it exercises the real supervisor-continuity process lifecycle while the overnight version only exercised the watchdog function path.

## Validation

### Passed

- `tests/fm-cancel.test.sh` passed through `bin/fm-test-run.sh` with exit 0.
- `tests/fm-host-resilience.test.sh` passed through `bin/fm-test-run.sh` with exit 0.
- `tests/fm-supervisor-failover-e2e.test.mjs` passed when run directly with `timeout 30s node`, with one test passing in 3.0 seconds.
- `tests/fm-opencode-go-acceptance.test.sh` passed through `bin/fm-test-run.sh` with all six checks passing in 33.836 seconds.
- `tests/fm-research-gate.test.sh` passed through `bin/fm-test-run.sh` with exit 0.
- `tests/fm-delegation-quality.test.sh` passed through `bin/fm-test-run.sh` with exit 0.
- `tests/fm-orchestrator-api.test.mjs` passed directly with all eight verb checks passing.
- `tests/gabriel-tui-chat.test.mjs` passed directly.
- `tests/gabriel-tui-persistence.test.mjs` passed directly.
- Bash syntax, Node syntax, and JSON parsing validation passed for the changed scripts and merged audience registry.

### Failed or incomplete

- `tests/fm-router-v2-enforcement.test.mjs` could not start because `config/model-registry.json` is missing, and the complete private routing catalog is absent from this worktree.
- `tests/fm-router-herdr-dispatch-e2e.test.mjs` had six route failures caused by missing `config/model-registry.json`, and its telemetry check also lacks `data/routing-executions.jsonl`.
- `tests/fm-dynamic-discovery-acceptance.test.mjs` passed its first five checks and then failed because `data/provider-catalogs/codex.json` is missing.
- `tests/fm-quota-failover-auto-resume-e2e.test.mjs` passed four checks and failed its simulated failover step because `config/model-registry.json` is missing during route selection.
- `tests/gabriel-soak-harden.test.mjs` passed only its quota-resilience check, while the doctor check reports missing OpenClaw workspace and `context-mcp.mjs`, and the dispatch lifecycle cannot satisfy the current required `dataClass` fail-closed parameter.
- `tests/gabriel-tui-dispatch.test.mjs` failed because its fixture omits the now-required `dataClass`; the direct diagnostic was `Missing or invalid required parameter: dataClass (fail-closed policy)`.
- The explicit `.mjs` list passed to `bin/fm-test-run.sh` was invoked through `bash` and hung on the supervisor test; direct `node` execution is the authoritative result for those JavaScript tests in this run.
- `bin/fm-test-run.sh --list --changed --base main` could not select a changed suite because `.agents/hooks.json` has no changed-test mapping.
- `bin/fm-doc-audience-check.sh` failed on numerous unclassified overnight documents that arrived with the preserved branch, although this baseline document itself is classified in the registry.
- `bin/fm-lint.sh` failed on ShellCheck warning SC2155 at `bin/fm-supervisor-watchdog.sh:113`, and workflow validation still reported three valid workflow files.
- `git diff --check main...HEAD` failed on trailing whitespace present in multiple preserved overnight scripts and documents.

The private routing files confirmed absent during this run were `config/model-registry.json`, `config/routing-policy.json`, `config/routing-priors.json`, `config/crew-dispatch.json`, `config/data-policy.json`, `data/learned-routing.json`, `data/quota-pool-map.json`, `data/provider-catalogs/codex.json`, and `data/routing-executions.jsonl`.

## Whole-stack observations

- The complete routing capability is only observable as one chain when provider discovery, quota normalization, learned-routing data, Router V2 selection, `fm-spawn.sh`, backend dispatch, and telemetry storage are present together; this chain is only partially observable here because its private config and catalog inputs are absent.
- The supervisor continuity capability is observable across the merged mission capsule, supervisor continuity service, watcher lifecycle, replacement launch, and durable mission records; the direct real-process E2E passed that integrated path.
- The Gabriel front door capability spans TUI input, orchestrator API dispatch, Router V2 data classification, worker launch, and cancellation; only the read-only orchestrator API and TUI chat/persistence portions were observable here because dispatch fixtures lack the current data-classification input and private routing catalogs.
- Dynamic discovery fallback is a whole-stack behavior because the provider probe, last-known-good snapshot, stale marker, and route consumer must agree; it was not observable because `data/provider-catalogs/codex.json` is absent.

This branch is an oracle and integration laboratory only, and it must not be merged into real `main` as a production decision.
