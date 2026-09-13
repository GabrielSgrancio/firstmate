# Material Conservation Ledger

Tracks every unique valuable change discovered during the 2026-09-13 canonicalization
campaign, from its overnight/AGY origin through to final disposition. Companion
machine-readable file: `data/reconciliation/material-conservation.json`.

No item disappears from this graph without an explicit classification below.

## Landed on `captain-workspace` local `main`

| Item | Source | Landed commit | Verification |
| --- | --- | --- | --- |
| P0-4 security fixes (teardown/PR-merge worker refusal, cancel captain-hold protection, host-monitor stdin fix) | `overnight/arch-evolution:c270d22e` (curated subset) | `a1917fbc` (via `29694ada` + test fix) | `tests/fm-cancel.test.sh`, `tests/fm-host-resilience.test.sh`, `tests/fm-pr-merge.test.sh`, `tests/fm-teardown.test.sh` all pass |
| Supervisor continuity (`systemd --user` outer watchdog, real kill-and-recover E2E) | `fm/supervisor-failover-hardening:c67646c0` (built fresh by Codex against current main, not from overnight) | `b3a1aed4` | `tests/fm-supervisor-failover-e2e.test.mjs` passes |
| Stale-base guard (`base_sha`/`target_branch` provenance, delivery-time drift check) | Built fresh by Codex, independently confirming the same root cause the inventory scout found | `c1e3e283` | `tests/fm-base-reconciliation.test.sh`, `tests/fm-spawn-pool-base-freshen.test.sh` pass |
| Reconciliation sprint documentation (source-control reality, stale-base root cause, landing/cleanup plans, operational-state architecture docs) | This campaign's own scout output | `65904c3f` | N/A (docs only) |
| Router V2 canonical port (10 roles, data gates, quota truth, effort dimension; security/path/backend/schema fixes; 4 deterministic test suites) | `overnight/arch-evolution:c270d22e` (`bin/fm-router-v2.mjs` blob `af6d6755`) | `8a00835c` — **VERIFIED_LANDED**, confirmed from an independent fresh clone before landing and re-verified in place on `main` afterward | `tests/fm-router-v2-enforcement.test.mjs`, `tests/fm-router-herdr-dispatch-e2e.test.mjs`, `tests/fm-dynamic-discovery-acceptance.test.mjs`, `tests/fm-quota-failover-auto-resume-e2e.test.mjs`, all 4/4 from a clean clone |

## Landed on `gabriel-os` local `main`

| Item | Source | Landed commit | Verification |
| --- | --- | --- | --- |
| Gateway dispatch routed through governed orchestrator | `fm/ufd-gateway-repair:b926d706` | `c38922c` | `node --test tests/firstmate-bridge.test.mjs` 2/2 |
| OpenClaw MCP child cwd fix | `fm/ufd-mcp-probe-fix:5df04f4f` (already healthy, rebased pre-existing) | `0dfe189` | `node --test tests/openclaw-terminal-home.test.mjs` 5/5 |
| OpenClaw brain-swap evidence report | `fm/openclaw-tui-fm-integration-hardening:b9286e2f` (curated to the doc only) | `c7a04ab` | Full `npm test` 200/200 after all three landings |

## Preserved, not landed

| Item | Where | Disposition |
| --- | --- | --- |
| `overnight/arch-evolution` (full 12-commit historical stack) | Untouched original branch; pinned by `archive/overnight-arch-evolution-2026-09-13`; merged (not squashed) into `integration/overnight-full-2026-09-13` for reference | `PRESERVED_FOR_FUTURE_RECONCILIATION` — Router V2, Orchestrator API, provider discovery, quota economics, TUI/`gabriel` launcher, worker failover, context compiler, research gate still to extract per `docs/OVERNIGHT_CAPABILITY_MAP.md` |
| gabriel-os dirty main (ChatGPT/context-MCP integration, 14 files, +1934/-163) | `checkpoint/gabriel-os-dirty-main-2026-09-13`, commit `3f26594` | `PRESERVED_FOR_FUTURE_RECONCILIATION` — captain decision 2026-09-13: `KEEP_FOR_FUTURE_REVIEW`, separate campaign after control plane stabilizes |
| Overnight `fm-mission.sh` v1 (501-line "Mission Envelope & Resume Capsule" schema) | `overnight/arch-evolution:c270d22e:bin/fm-mission.sh` | `SUPERSEDED_BY b3a1aed4` (the landed v2 continuity-branch implementation) — v1's richer capsule inventory fields (`completed`/`pending`/`in_flight`/`preserved_worktrees`) remain a documented, not-yet-actioned possible follow-on, flagged in `docs/SUPERVISOR_CONTINUITY_DESIGN.md`, not silently dropped |
| Overnight `fm-supervisor-watchdog.sh` + its original E2E test | `overnight/arch-evolution:c270d22e` | `SUPERSEDED_BY b3a1aed4` (`bin/fm-supervisor-continuity.sh` + the real-process E2E test) |
| Overnight Router V2 lineage commits `e4499f26`, `3369c603`, `613dbde3`, `ef2e8b03`, `2c468734`, `5644821f` themselves (as individual commits) | `overnight/arch-evolution`, pinned by the archive ref | `SUPERSEDED_BY` the single canonical port commit once landed — the commits remain reachable as historical provenance, never rewritten |

## Archived, intentionally not extracted

| Item | Reason |
| --- | --- |
| Work Package A (Second Brain archaeology synthesis: Hindsight/GBrain/World Model reconciliation) | `ARCHIVED_INTENTIONALLY` — captain decision 2026-09-13: `CLOSED_WITH_KNOWN_RESIDUALS`, M-03/M-08 accepted as sufficient, no further remediation |
| Second-brain archaeology docs, OpenClaw/TUI/token-overhead evidence from the overnight branch | `ARCHIVED_INTENTIONALLY` per `docs/OVERNIGHT_CAPABILITY_MAP.md` — no FirstMate implementation target, or claims need refreshing before any reuse |

## Not yet reconciled (open follow-on scope)

| Capability | Status |
| --- | --- |
| Provider discovery, quota normalization/economics beyond what Router V2 canonicalization ported | `PRESERVED_FOR_FUTURE_RECONCILIATION` — `ADAPT` per capability map, next phase |
| Orchestrator API / governed Router→Herdr dispatch | `PRESERVED_FOR_FUTURE_RECONCILIATION` — next phase after Router V2 lands |
| Worker quota failover rebuild around current lease/checkpoint owners | `PRESERVED_FOR_FUTURE_RECONCILIATION` |
| Gabriel/FirstMate TUI, `gabriel` launcher/doctor | `PRESERVED_FOR_FUTURE_RECONCILIATION` — `ADAPT`, after routing is stable per capability map's recommended order |
| Mission event store (`ADAPT_TO_EVENT_STORE` per the accepted ADR) | `PRESERVED_FOR_FUTURE_RECONCILIATION` — design complete (`docs/FIRSTMATE_OPERATIONAL_STATE_ADR.md`), implementation not started |
| Supervisor rehydration E2E | `PRESERVED_FOR_FUTURE_RECONCILIATION` — contract designed (`docs/SUPERVISOR_REHYDRATION_CONTRACT.md`), not implemented or tested |

No item in this ledger is `UNKNOWN_DO_NOT_TOUCH`; every discovered unique change has a
named disposition.
