# Landing plan

## captain-workspace reconciliation — 2026-09-13

The local canonical target used is `main` at `d57a9471705718a4205e84284441aa722e79a2f7`. The recorded `origin/main` (`b182d0f9...`) is stale relative to this local delivery target and was not used as the reconciliation base.

| Order | Branch | Tip | Classification | Required decision |
| --- | --- | --- | --- | --- |
| 1 | `reconcile/security-fixes` | `29694ada` | `READY_FOR_CAPTAIN_MERGE` | Approve a guarded local fast-forward after independently reviewing the additive security extraction. |
| 2 | `reconcile/supervisor-continuity` | `c67646c0` | `READY_FOR_CAPTAIN_MERGE` | Approve a guarded local fast-forward after the security branch decision. |
| 3 | `fm/reconciliation-stale-base-bug` | `59645017` | `READY_FOR_CAPTAIN_MERGE` | Approve a guarded local fast-forward; this is the guard that would have caught tonight's stale-base incident automatically. |

`reconcile/security-fixes` (755 additions, 3 deletions vs current main) ports the worker/worktree structural-separation refusals in `fm-teardown.sh`/`fm-pr-merge.sh`, the captain-hold protection in `fm-cancel.sh`, and the safe stdin handoff fix in `fm-host-monitor.sh`, all sourced from `overnight/arch-evolution` commit `c270d22e` (provenance in the commit trailer). Full test suites for teardown, PR-merge, cancel, and host-resilience pass.

`reconcile/supervisor-continuity` is the existing clean additive commit `c67646c0`, reused without duplication (its parent is exactly current local main). The competing overnight v1 `fm-mission.sh` capsule fields (`completed`/`pending`/`in_flight`/`preserved_worktrees`) were deliberately NOT folded into the v2 schema - flagged as a possible future `NEEDS_REWORK` follow-up rather than an unreviewed merge.

`fm/reconciliation-stale-base-bug` adds the `base_sha`/`target_branch` provenance and delivery-time drift guard; root cause independently confirmed twice tonight plus a live reproduction. `fm-base-reconciliation.test.sh` and the full `fm-spawn-pool-base-freshen.test.sh` suite pass.

Deliberately excluded from reconciliation: Router V2, TUI, orchestrator API, OpenCode integration, and Work Package A material from `overnight/arch-evolution` - the decomposition report marked this mixed, dependent on untracked configuration/catalog files, or historical/archive-only. The original `overnight/arch-evolution` branch remains untouched as evidence; it must not be merged as a unit.

## Gabriel OS reconciliation — 2026-09-13

The current committed Gabriel OS target verified for this work was local
`main` at `6f26a1dcb9fa8b45a1e3dccc518ab0c752b1272e`. The primary checkout was
dirty (7 modified tracked files and 7 untracked files) and was left untouched.
The three original worker branches were also left unchanged.

Three local-only reconciliation branches were created from that committed
target. They were never pushed or merged:

| Branch | Reconciled source | Result | Classification |
| --- | --- | --- | --- |
| `reconcile/ufd-gateway` | `fm/ufd-gateway-repair` / `b926d706519170293cb8d0a81d7e45db3cbf435c` | `c38922c`; clean `-x` cherry-pick, 6 expected files, 227 additions / 120 deletions | `READY_FOR_CAPTAIN_MERGE` |
| `reconcile/mcp-probe-fix` | `fm/ufd-mcp-probe-fix` / `5df04f4fffea25922dd3795e5c8b8c1183dbebd6` | `94e368a`; source parent confirmed as current `main`, distinct named branch created for consistency, 6 expected files, 128 additions / 11 deletions | `READY_FOR_CAPTAIN_MERGE` |
| `reconcile/openclaw-integration` | `fm/openclaw-tui-fm-integration-hardening` / `b9286e2fb162ce14d4272cfea7d14d0fc63b58c` | `60da5e9`; clean `-x` cherry-pick, one expected documentation file, 123 additions / 0 deletions | `READY_FOR_CAPTAIN_MERGE` |

All three branches have current `main` as their direct parent, retain source
provenance in a `cherry picked from commit` trailer, and have patch IDs equal to
their source commits. No branch shows the stale-base ~29,000-line deletion
anomaly. The relevant tests and the full build/test suite passed; see the
companion report at
`data/reconciliation-branch-extraction-gabriel-os/report.md`.

Captain review is still required before any merge to canonical `main`. If
`main` advances before landing, re-run the diff-size and focused-test checks
against the new target first.
