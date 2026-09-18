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

---

# Correction addendum (2026-09-19, commit 5ca33311 on this branch)

**Method note:** everything below is re-derived from the current code in this branch; every
behavior item below is backed by a regression test in `tests/` or live evidence in
`evidence/router/` produced during this pass. Nothing in the addendum reuses a prior report's
wording without re-verification.

## 1. OpenCode Go capacity is now dollar/token denominated (correction item 1)

The "estimated requests" table is no longer quota data. Capacity accounting now reads
`OPENCODE_GO_MODEL_PRICING` (`bin/fm-provider-discovery.mjs:498`), the per-model USD token
prices plus monthly USD allowances from https://opencode.ai/docs/go/ (retrieved **2026-09-19**;
the doc states: "Usage limits are defined as monthly dollar amounts. Each model has the
following usage limits: 5-hour — 20% of the monthly limit; weekly — 50%; and monthly — 100%").
For each model the Router now carries: input/output/cached-read/cached-write price per 1M
tokens, the model's monthly USD allowance, and rolling-5h (20%) / weekly (50%) USD windows.
Pre-dispatch burn is estimated from the docs' typical-request token composition in USD
(verified: MiMo's composition yields ~$0.0004/typical request ≈ the published only-as-an-estimate
150,400 requests/month); post-dispatch actual usage is folded in when the runtime supplies
token splits. The aggregate `/zen/go/v1/usage` percent table stays the conservative pool-level
fallback (`bin/fm-opencode-quota.mjs`) and routes with dollar windows report
`basis: published_dollar_windows` (`bin/fm-routing-economics.mjs` `routeAllowanceWindows`).
Peak/off-peak DeepSeek windows are timed off the published 01:00-04:00 & 06:00-10:00 UTC
Mon-Fri windows. No request-count counter appears anywhere in the allowance path anymore.

Verified: `tests/fm-router-v3-full-pool.test.mjs` (dollar windows 5h=$12/$30/$60 for MiMo,
promo expiry flips 4x monthly USD, near-exhausted dollar window gates an ABUNDANT pool) and
`tests/fm-dynamic-discovery-acceptance.test.mjs` (dollar-derived burn replaces the 12.5/
33.8 request-share numbers; qwen3.7-max = (420×2.50 + 66000×0.50 + 200×7.50)/1e6 = $0.03555
per request over a $6 5h window = 0.5925 normalized burn).

## 2. Free providers are actually spawnable (correction item 2)

Research first: OpenCode's existing custom-provider mechanism
(https://opencode.ai/docs/providers/, "Custom provider"; `npm: "@ai-sdk/openai-compatible"`,
`options.baseURL` + `options.apiKey`, and `{env:VAR}` apiKey interpolation, all live-documented)
hosts any OpenAI-compatible endpoint. So every previously completion-only free provider is now
an OpenCode agent-session route: `bin/fm-provider-discovery.mjs` compiles them with
`harness: 'opencode'`, `route_kind: 'agent_session'`, `provider_path: 'opencode_custom_provider'`,
and `resolved_runtime_model: '<provider>/<model>'`; `bin/fm-provider-discovery.mjs refresh` also
writes `data/provider-catalogs/opencode-custom-providers.json` (no secret values anywhere in it —
apiKey fields are `{env:<VAR>}` references; the spawn launcher sources
`~/.config/firstmate/free-provider-keys.env` locally). `bin/fm-spawn.sh`'s opencode launch now
builds `OPENCODE_CONFIG_CONTENT` via `bin/fm-opencode-provider-config.mjs`, which fails closed
(exit 2) when the requested model is no longer in the discovered provider catalog.

Verified live end-to-end through the REAL dispatch path
(`fm-router-v2.mjs dispatchThroughHerdr` → real `fm-spawn` → real opencode worker in an isolated
worktree; no spawn simulation), with the OpenCode session DB recording providerID + token usage:

| Route | fm-spawn proof | Session evidence |
|---|---|---|
| Groq | `groq/openai/gpt-oss-120b` worker completed | ses in opencode.db, providerID `groq`, 3074 input / 114 output tokens, attestation MATCH |
| Kilo free | `kilo/deepseek/deepseek-v4-flash-0731:free` | 4415 input tokens, MATCH |
| OpenRouter free | same model route | 4469 input tokens, MATCH |
| Mistral `codestral-2508` | | 26793 input / 3584 cache-read, MATCH |
| Cloudflare Workers AI | `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | 3054 input / 418 output, MATCH |

All five are live user-work requests on free routes; no PAYG route was enabled anywhere and
`requireSpawnable` still refuses any `route_kind: 'api_completion'` remainder (no such route is
left in the compiled pool). A tool-calling capability gate was added: probe-free now sends a
one-request tools probe per provider (`probeFreeProviders`), Stage A refuses a route whose
provider model rejected tools (`supports_tools === false`) — that is exactly what killed the
first Groq attempt (`groq/compound` "tool calling is not supported"), found live during this
proof pass. Requires the home's `config/data-policy.json` to carry the documented free-pool
profiles (`docs/examples/free-provider-data-policy.json` merge) — noted as an operational step
for firstmate, since the local data policy is firstmate-owned.

## 3. Union Alpha Free: not satisfiable — the offer is gone

Queried the LIVE catalogs on 2026-09-19: `GET /zen/go/v1/models` returns **37** models and `GET
/zen/v1/models` **70**, and no id containing `union` in either. Compiled routes contain 0 union
routes (fixture home refresh, 309 targets). The automatic-withdrawal property that item 3
demanded is in place structurally: compiled targets are regenerated from the live catalog each
refresh, so a withdrawn offer leaves the pool with no code change — regression-tested
(`tests/fm-router-v3-full-pool.test.mjs` "Catalog drift"). Reported per the brief's fallback
clause rather than registering a stale id.

## 4. Requested → actual model attestation is enforced at runtime

New `bin/fm-model-attestation.mjs` reads the ACTUAL model from the OpenCode client's own session
storage (`~/.local/share/opencode/opencode.db` `session` rows carry the served
providerID/modelID per worktree directory), and `recordTaskCompletion`
(`bin/fm-router-v2.mjs`) consumes it:

- explicit route + actual ≠ requested → completion is FORCED to `FAILED` with attribution
  `MODEL_SUBSTITUTION` (not in `ROUTE_EXCUSED_ATTRIBUTIONS`, so it is a real reliability-data
  failure for that route), and the success is never recorded against the requested model;
- auto routes (`kilo-auto/free`) → `AUTO_ROUTE_RESOLVED` attestation plus an
  `attribution_route_id` re-key so quality/outcome evidence lands on the model that actually ran
  (`collectRoutingObservations` re-keys the observation through `autoRouteAttribution`);
- runtime without an observable model record → `NO_RUNTIME_RECORD`/`UNATTESTED`, uncertainty
  recorded, never invented.

Live: on the real e2e above, every completion record carries `model_attestation: MATCH` with the
attested actual model. The mismatch gate is tested against a fixture session DB
(`tests/fm-router-v3-attestation.test.mjs`), and a live MATCH was recorded end-to-end through
`fm-router-v2.mjs complete`.

AGY re-test (decision item untouched): `agy --model gemini-3.7-flash-low -p "Reply PONG"` →
PONG (gemini selector accepted and answered; observable-substitution not reproduced in one
shot) and `agy --model claude-sonnet-4-6 -p` hung past 90 s under `-p`. The CLI records no
actual-model surface we can attest, so the `agy-effort-silent-substitution` behavior retest is
bounded to that observation and the backlog decision stays with the captain.

## 5. Provider status is route-specific, re-probed fresh (2026-09-19)

`evidence/router/full-pool-probes.json` was regenerated this pass with the tool-calling probe
added (`probe-free`, both availability and `supports_tools` per model). Corrections that the
fresh evidence requires, replacing any provider-global reading:

- **Google AI Studio: AUTH_FAILED route-level** — fresh probes got HTTP 401 for every model
  (`auth_failed`); Google has NO fresh successful completion in this mission's evidence. Not
  "working".
- **NVIDIA NIM: per-model MODEL_UNAVAILABLE** — fresh direct probes returned 404s on the probed
  models (route-level EOL/deprecation, matching the earlier per-model finding); no fresh
  successful completion either; catalog/auth still work (200 earlier). Not "provider working".
- Kilo: explicit free models answered with per-model 429 upstream (`rate_limited`) on some ids
  and 200 on others; `kilo-auto/free` (upstream id before this pass) previously attested actual
  model `inclusionai/ling-3.0-flash-vl:free` — attribution rule holds. Kilo auto/free remains
  the only route whose actual model differs by design.
- Groq: live per-model split confirmed again — `openai/gpt-oss-120b` and `openai/gpt-oss-20b`
  support tools (200 + tool probe 200), `groq/compound*` and `allam-2-7b` reject tool calling
  (400) and are filtered out of agent dispatch.
- Cloudflare: fresh chat/completions 200 with tool support on `@cf/openai/gpt-oss-120b`.
- The characterization of the data report lives in firstmate's own `data/` copy of
  `data/task-report-free-capacity/report.md`; this addendum records the corrected
  route-specific statuses, and firstmate should mirror them there (that file is outside this
  worker's writable scope).

## 6. Replay rerun + real e2e (correction item 6)

`evidence/router/full_pool_replay.mjs` is now a committed, deterministic runner (30 real tasks
from the b5/b7 task set, same snapshot overrides, `requireSpawnable=false`), so before/after is
reproducible instead of living in a one-off script. Its inputs:
`evidence/router/replay-task-set.json`; outputs this pass:
`evidence/router/c9_before_full_pool_replay.json` (commit `3562dfa1` code in a scratch worktree
at `/tmp/opencode/before-wt`) and `c9_after_full_pool_replay.json` (this branch), same runner,
same FM_HOME, same quota snapshots:

| Snapshot | prior pass (b8) | before (same runner, 3562dfa1) | after (this pass) |
|---|---|---|---|
| 1 current real | 27/30, burn 13.12, opencode 21 | 27/30, burn 13.118, opencode 21/agy-3p 6 | 27/30, burn 14.905, opencode 20, agy-3p 7 |
| 2 claude+codex dead | 27/30, burn 13.12 | 27/30, burn 14.89, opencode 20 | 27/30, burn 16.678, opencode 19, agy-3p 8 |
| 3 balanced | 27/30, burn 12.24 | 27/30, burn 17.132, codex 11 / opencode 14 | 27/30, burn 18.905, codex 11 / opencode 13 |

Reading, no target percentage:

- Routeability is unchanged at 27/30 with the same three critical/SECRET rejects; quality floors
  held identical. The dollar-burn basis shifted one low-risk task (snapshot 1) from MiMo to the
  agy-3p claude route — the new dollar economics honestly price MiMo's composition (its typical
  request is ~71K cache-dominant tokens; $0.0004 is genuinely cheap, and remaining scoring
  differences now come from headroom/effort terms, not a request-count fiction).
- Model concentration remains high (mimo ×19-20). It is still the correct score arithmetic
  ("quality-satisfied, lowest USD burn, huge own window"); it needs real outcomes and burn
  learning to soften, which flows from the exploration/probe traffic now wired in.
- Free-provider share in the deterministic pass is 0 because proven-quality routes satisfy every
  floor here; free routes are reachable and DID carry real spawn tasks (section 2), and
  exploration dispatch remains armed at the same bounded rate.
- Real fm-spawn e2e: five providers dispatched, five live completions, five MATCH attestations
  (section 2's table). No PAYG anywhere.
- Pre-existing (not this branch's) suite failures: `tests/fm-quota-failover-auto-resume-e2e*`
  and the three supervisor-continuity tests fail identically on commit `3562dfa1`'s base (run
  with the corrections stashed and re-run after restore) — environment-level, out of this pass's
  scope; everything previously green is still green plus the new suite.

## Not satisfiable / left over in this pass

- Union Alpha Free: gone from the live catalogs (fallback clause above).
- Union Alpha's temporary/unmetered classification needs no code because the auto-withdrawal
  test covers the same mechanism (catalog-driven registration only).
- The captain-home `config/data-policy.json` free-pool profile merge is an operational step for
  firstmate; without it the Stage-A data gate still (correctly) rejects free routes there even
  though the pool now hosts them.
- AGY actual-model attestation has no observable source; backlog `agy-effort-silent-substitution`
  untouched.
