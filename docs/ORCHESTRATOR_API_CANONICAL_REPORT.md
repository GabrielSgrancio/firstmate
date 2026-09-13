# Orchestrator API Canonical Report

The recovered overnight implementation came from commits `9186aac1` and `c270d22e` on `overnight/arch-evolution`.

Its actual eight-verb surface is `get_backlog`, `get_task`, `dispatch`, `list_workers`, `send`, `status`, `cancel`, and `needs_attention`.

There is no `followup` verb in the recovered source.

The API was ported to `bin/fm-orchestrator-api.mjs` with its MCP stdio surface and direct read-only calls to `fm-fleet-snapshot.sh`, `fm-crew-state.sh`, `fm-send.sh`, and `fm-cancel.sh` preserved.

Dispatch was adapted to call the landed `dispatchThroughHerdr` export from `bin/fm-router-v2.mjs`, which remains the only authority for concrete RouteTarget, harness, model, effort, quota, and data-policy selection.

The caller supplies a requested profile consisting of `role`, optional `effort`, and required `dataClass` plus task intent.

Router V2 resolves that request into the concrete RouteTarget and then invokes the existing `fm-spawn.sh` lifecycle owner with the Herdr backend.

The API does not default or reinterpret `dataClass`, and it rejects direct `harness` or `model` overrides so callers cannot bypass Router V2 authority.

The API does not create or mutate task intake, backlog, lease, worktree, hold, or continuity state.

Deterministic tests reuse `tests/fixtures/router-v2/` through `makeRouterFixtureHome()` and cover the MCP surface, read-only verbs, fail-closed data classification, Router-selected dispatch, Herdr arguments, and rejection of concrete-target overrides.

The implementation was committed on branch `fm/orchestrator-api-governed-dispatch` at `66141211`, followed by the evidence-only documentation commit at `a6046a9b`.

Validation passed in a fresh `git clone --no-local --branch fm/orchestrator-api-governed-dispatch` at branch tip `a6046a9b506ef7e8a08a368c91740a289337c794` with:

`node tests/fm-router-v2-enforcement.test.mjs`

`node tests/fm-orchestrator-api.test.mjs`

The clean clone reported `tracked_router_fixture_files=10` from `git ls-files 'tests/fixtures/router-v2/**'` and both suites passed.

The branch is local-only and was not pushed or merged.
