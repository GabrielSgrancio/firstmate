# ROUTER-V3-FULL-POOL.md — Full Compute Pool Activation

**Worker:** firstmate crewmate (`fm/router-v3-full-pool-activation`, local-only)
**Date:** 2026-09-18
**Method:** every claim below was re-derived against the current code in this branch before acting; the mission's own framing and the prior AGY reports were treated as leads, not facts. Live provider evidence: `evidence/router/full-pool-probes.json`. Replay evidence: `evidence/router/b7_full_pool_replay_before.json` and `b8_full_pool_replay_after.json` (method inside each file; runner documented there).

---

## 1. Outcome in one paragraph

The Router now considers, prices, and (where a transport exists) can dispatch across the entire usable compute pool in one RouteTarget model: 309 routes (89 subscription + 220 free/zero-marginal-cost) instead of 89, capacity for OpenCode Go is modeled at its documented per-model enforcement granularity instead of one shared scalar, route-level availability came out of mission section 4's demanded states, exploration actually assigns real low-risk work to untested routes, and the shadow replay flips from "everything goes to Antigravity, 0 to OpenCode" to OpenCode carrying bulk work at 60% lower total expected burn while the strongest-scarce evidence still takes the high-floor tasks. Zero PAYG enforced throughout.

## 2. Before/after (same 30 real tasks, same quota snapshots as `04-ROUTER-V3-REPLAY-V2.md`)

Read-only shadow replay, `useLiveAxi=false`, snapshot overrides copied from `evidence/router/b5_shadow_replay_v2.json`, no state mutation, no API spend. Deterministic (exploration assignment pinned off for the comparison pass).

| Snapshot 1 (current real quota) | BEFORE | AFTER |
|---|---|---|
| Routed | 27/30 | 27/30 |
| Pools | agy 27 (gemini 21, 3P 6), opencode 0 | opencode 21, agy_3p 6 |
| Top model | gemini-3.6-flash-medium ×11 | opencode-go/mimo-v2.5 ×21 |
| Sum normalized burn | 32.71 | 13.12 (−60%) |
| Mean P(success) | 0.856 | 0.856 (unchanged — same MI floor) |

Snapshot 2 (claude+codex exhausted): same shape — 27/30, burn 32.71 → 13.12. Snapshot 3 (balanced): burn 27.98 → 12.24, pools agy 13/codex 11/claude 3 → opencode 21/codex 5/agy_3p 1. The 3 permanent rejects in both directions are the `critical_auditor` tasks (SECRET fail-closed ×1, critical-gate ×2) — critical behavior did not change.

**Honest reading, per mission 12 ("do not optimize toward a target percentage"):**
- OpenCode winning bulk work is quality-first arithmetic, not "OpenCode first": MiMo V2.5 and qwen3.8-flash carry Model Intelligence classes equal or above the Gemini entries they displaced (STRONG VERY_STRONG vs STRONG), so Stage C ranks the least-scarce sufficient route first. Where DeepSeek V4.1 Flash's MI was alias-fixed earlier, its route is eligible with its published 4x promo window (valid until 2026-09-20).
- Model concentration is extreme (mimo ×21). That is the correct score for "quality-satisfied, lowest burn, huge own allowance" and the mission names concentration only as a metric, not a target; but the practical mitigation is real outcomes and burn learning, which accumulate from exactly the exploration/probe traffic this mission wired in.
- Free-pool share is 0 in this deterministic comparison pass because proven-quality routes satisfy every floor in this task set. Free routes are admitted on low-risk uncertainty tolerance (upper Beta bound 0.975 ≥ floor) but price at P=0.5 until evidence exists; with exploration armed they do receive real assignments (see §8), and occasional task classes lost to them when subscription economics were worse (observed cloudflare/google wins in the non-pinned pass: 1–2 of 27).
- Quality floors held identical throughout; critical/SECRET behavior identical; fail-closed behavior identical.

## 3. Stage C term-by-term diagnosis (mission section 8) — what actually biased AGY

Decomposition of task-01 (fast_precise, snapshot 1): `agy:gemini-3.6-flash-low` 1.601409 vs `opencode:mimo-v2.5` 1.375182, gap 0.2262, despite MiMo's 5× cheaper expected burn (0.2 vs 1.0 per attempt):

1. **Aggregate-pool headroom distortion, +0.1035 to AGY.** OpenCode Go's 54% *weekly aggregate* was applied to every opencode model, while MiMo's own pitch was ~30,100 req/5h (its allowance), not a shared scalar. Fixed by per-route allowance windows (mission section 3).
2. **Effort-fit structural penalty, +0.25 to AGY.** `effortFitScore` returned 0 for `reasoning_effort: null` routes (every OpenCode model), versus 1 for an effort-matched AGY variant — a harness-shape bias, not a quality signal (capability is priced separately by Model Intelligence). Fixed: null-effort routes are effort-compatible (`bin/fm-router-v2.mjs` `effortFitScore`).
3. **Cost term already correct, −0.1273 in MiMo's favor.** Confirms the existing `expected_successful_quota_burn = burn/P(success)` term is the right backbone — no change needed.

Neither "Claude/Codex subscriptions over-preferred" nor "Antigravity free bonus" nor "route alias collisions overriding Stage C" was in the equation itself; the two real causes were capacity modeling and a hard-coded effort-shape penalty. All other suspects audited: exploration bonus is a small bounded +0.06 (kept); concurrency/reset/pacing terms stayed evidence-driven; latency/cache terms only bite with real observations (compatible with "where relevant").

## 4. What changed (verified, exact)

- `bin/fm-router-v2.mjs`
  - `ROUTE_AVAILABILITY_STATES`: `AVAILABLE, RATE_LIMITED, RATE_LIMITED_ZERO, QUOTA_EXHAUSTED, TIER_BLOCKED, AUTH_FAILED, MODEL_UNAVAILABLE, STALE, UNKNOWN`; `RATE_LIMITED` (nonzero limit) passes and is priced, everything else blocks; unknown catalogs still `unknown → AVAILABLE` (priced).
  - `spend_policy: FREE_RATE_LIMITED` passes; **PAYG stays a hard blocker everywhere** (zero-PAYG by construction, tested).
  - Per-route allowance gating in Stage A: a route whose own published windows are spent is refused even while its pool reads abundant (rejection string `Route allowance exhausted (per-model window)`); falls back to pool state until that route has telemetry.
  - `evaluateDataGate` gained an optional preloaded-configs parameter so the 306-route pool no longer re-reads all config files per route (1.79s → 34ms per selection); a misconfigured/unknown profile now rejects only its own routes instead of crashing the dispatch.
  - `effortFitScore`: no effort knob → compatible (1); explicit tiers keep ±1/−0.5 semantics.
  - Exploration assignment in `scoreAndSelectRoute` (`explorationRandom` injectable): best-ranked Stage-B-survivor that is still exploration-eligible receives the task at its policy rate (bootstrap 0.18 / steady 0.05) for retry-tolerant non-critical non-high-risk PUBLIC/`SANITIZED`/`PRIVATE_CODE` work; `explorationDispatch` records rate, phase, and the displaced economic winner. Critical work never explores (tested).
  - `requireSpawnable`: agent dispatch (`dispatchThroughHerdr`, continuation selection, context-broker worker selection) refuses `route_kind: api_completion` and harness-less routes; the plain `route`/eval surfaces still see the full pool.
- `bin/fm-routing-economics.mjs`
  - `routeAllowanceWindows` / `routeAllowanceState`: per-route windows from published limits × telemetry attempt counts; `buildRouteEconomics` prices route-owned windows ahead of the pool fallback and reports `capacity_evidence: route_allowance` with per-window audit data.
  - `daily` window kind (24h horizon) for rate-limited pools; pools beyond the five subscription pools get pool economics from the quota map.
  - A quota-axi failure no longer erases probe-based free-pool auth/availability state.
- `bin/fm-provider-discovery.mjs`
  - `OPENCODE_GO_MODEL_ALLOWANCES`: per-model published windows (5h=20%/weekly=50%/monthly=100% of each model's own monthly limit), source https://opencode.ai/docs/go/ retrieved 2026-09-18, with the provider-advertised DeepSeek V4.1 Flash 4x promo encoded as an expiring override (ends 2026-09-20, tested both before and after expiry).
  - Free-provider adapters (parallel, bounded timeouts): Groq, OpenRouter (`:free` only), NVIDIA NIM, Mistral, Kilo (`isFree` explicit models + auto-routing `kilo-auto/free` with `mayTrainOnYourPrompts` recorded), Google AI Studio, Cloudflare Workers AI, OpenCode Zen free models (the six documented-free ids, agent-session routes on the `opencode` harness). Async `refreshFreeProviderCatalogs()` compiles 220 free RouteTargets and seeds free pools into `data/quota-pool-map.json` (subscription pools untouched).
  - `probe-free` subcommand: up to four minimal PUBLIC completions per provider, mapping HTTP status → per-model availability back into the catalog (429/403/401/404 probes burn nothing; 5xx/timeouts leave `unknown`).
- `bin/fm-task-state.mjs`: continuation retries are spawnable-gated (same hard rule as fresh dispatch).
- Fixtures/docs: free-pool profiles fixture + `docs/examples/free-provider-data-policy.json` (merge into a home's `config/data-policy.json`); `docs/router-v2.md` "OpenCode Go per-model capacity", "Free compute pool", "Exploration"; `docs/router-v3-model-intelligence-schema.md` route-state table extended (one-owner file for those dimensions).
- Tests: `tests/fm-router-v3-full-pool.test.mjs` (availability mapping incl. `RATE_LIMITED`-passes/`RATE_LIMITED_ZERO`-blocks per-model split; completion-routes-never-dispatch; FREE/PAYG spend gates; per-model allowance math + promo expiry; route allowance exhaustion gating an abundant pool; exploration determinism + critical-never-explores; null-effort fit; pool seeding). Existing suites: enforcement test's pool-key assertion updated to the multi-pool contract; all other existing behavior pinned and passing (9 router suites + context broker + task state + ingress + herdr dispatch e2e = green).

## 5. Live verification (no secrets, zero PAYG)

`evidence/router/full-pool-probes.json` — one tiny PUBLIC microtask per provider; requested vs actual model captured from responses:
- Groq (2 models 200 correct, rate-limit headers expose per-request/token windows), Cloudflare Workers AI (200), Mistral `codestral-2508` (200, correct code — the per-model split stands), OpenRouter (one free model 200; another 429 transient upstream), Kilo (explicit free 429 upstream — same upstream text as OpenRouter for that id; `kilo-auto/free` 200 with actual_model `inclusionai/ling-3.0-flash-vl:free`, proving auto-route attribution must come from the response), OpenCode Go + Zen free (via `opencode run`, correct outputs), Google (2.5-flash 404 model-unavailable-for-new-users; 3.6-flash 503 high-demand transient, later attempts timed out), NVIDIA NIM (catalog 200 but completions hang >60s on `deepseek-v4-flash-0731`, 404 for nemotron-70b on this account, 410 EOL for llama-3.1-8b — registered MODEL_UNAVAILABLE/unknown, not provider-wide).
- OpenCode Go capacity semantics: `/zen/go/v1/usage` exposes **only** aggregate rolling/weekly/monthly; docs define per-model windows with per-model dollar limits; one 262-token MiMo completion (HTTP 200, requested==actual) moved nothing measurable. **Per-model enforcement was not verified by a depletion experiment** (weekly already 48% used; exhausting a model risks real usage) — recorded as the named residual uncertainty; the code treats per-model as primary with the aggregate as conservative fallback, so a future live contradiction only requires flipping that precedence.

## 6. Reliability items from mission section 13 — re-checked against current code

- **`qwen-max` logical-alias collision** (`config/model-registry.json`, `qwen3.7-max` and `qwen3.8-max` both `logical_alias: "qwen-max"` — real): verified **inert** in current code — `logical_alias` is only a lookup key into Model Intelligence (`findModelEntry`) and routing-priors (`priorForRoute`); no MI entry or prior declares `qwen-max`, and compiled-route/capability matching uses `model_family`/`resolved_runtime_model` (distinct: `opencode-go/qwen3.7-max` vs `opencode-go/qwen3.8-max`). No code change made; champion config stays the open captain decision.
- **Stale catalog 24h cliff:** still intentional and correct (fail closed on fallback snapshots older than 24h; dispatch-time one-shot refresh covers staleness). Not changed.
- **Route/model substitution:** requested→actual model identity has no live runtime gate (provenance records it; the `agy-effort-silent-substitution` decision owns tightening it). Left untouched deliberately.
- **Static/default paths bypassing Router V3:** the manual-override spend gate remains subscription-pool-only and `verifyRouterProvenance` binds the recorded dispatch — no widening; the capture in `agy` was fixed earlier at `170d600e` (verified: hooks + harness registry in this base).
- **Provider-wide failure blocking healthy models:** structurally addressed by per-model availability (section 4) — a Mistral-shaped split can no longer zero an entire provider.
- **Prior reports' citations:** nothing was landed on their word; the `CAPABILITY_INDEX` fabrication stays confirmed-fabricated (no such symbol).

## 7. Architecture / portability (mission section 14)

Kept deliberately thin: one allowance mechanism for per-model capacity (OpenCode Go docs table + free rate limits), one availability enum, one exploration gate reusing the existing policy constants; new adapters are separate functions behind one compile step; no new framework, no sub-router. Free-route capacity is telemetry-derived and portable; replacing Stage B/C with an upstream router later remains a matter of reimplementing the two scoring functions — the RouteTarget schema is where all new state lives.

## 8. Captain decisions deliberately not taken here

- Champion config (`qwen3.7-max` demotion) and AGY `--effort` stripping (`agy-effort-silent-substitution`) are untouched; where this work's economics naturally change winning routes for a task class, that is a scoring consequence, not a config edit.
- Genuinely verifying per-model enforcement of OpenCode Go (depletion experiment) — needs a window where capacity can be safely spent.
- Free providers' per-data-class privacy verification beyond PUBLIC/SANITIZED (retention/training per provider is recorded where the provider states it, e.g. Kilo `mayTrainOnYourPrompts`, Zen free-period training, Muse Spark contributor terms; PERSONAL_SENSITIVE/PRIVATE_CODE stay off free pools).

## 9. How to verify this branch

```bash
FM_REPO_ROOT=<worktree> node --test tests/fm-router-v3-full-pool.test.mjs tests/fm-router-v2-enforcement.test.mjs \
  tests/fm-router-v3-enforcement-readiness.test.mjs tests/fm-router-v3-single-authority.test.mjs \
  tests/fm-router-v3-task-state.test.mjs tests/fm-model-intelligence.test.mjs tests/fm-routing-eval.test.mjs \
  tests/fm-dynamic-discovery-acceptance.test.mjs tests/fm-router-herdr-dispatch-e2e.test.mjs   # 9/9 green
FM_HOME=<fixture-home> node bin/fm-provider-discovery.mjs refresh   # 89 subscription + 220 free routes
FM_HOME=<fixture-home> node bin/fm-provider-discovery.mjs probe-free   # optional live availability probes
FM_HOME=<fixture-home> node bin/fm-router-v2.mjs route fast_precise PUBLIC low
```
