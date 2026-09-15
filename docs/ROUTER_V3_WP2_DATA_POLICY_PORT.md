# Router V3 WP2 - data policy port

Task `router-v3-wp2-data-policy`, 2026-09-15.
Implements the captain's WP2 decision: remove `WORK_CORPORATE`, replace provider-family blanket policy with payload plus route-specific privacy metadata, adopt five simplified data classes, and keep Muse Spark reachable but gated on its real training-enabled metadata.

## Why this is a doc, not a committed config change

`config/data-policy.json`, `config/provider-privacy-metadata.json` (new), and `data/provider-catalogs/compiled-route-targets.json` are private, gitignored, per-`FM_HOME` files.
See `docs/ROUTER_V2_EXACT_RECOVERY.md`'s `UNCOMMITTED_BUT_REQUIRED_CONFIG` / `PORT` classification for the same files under the prior version.
This task ran in an isolated disposable worktree that never had these files checked out and must not write outside itself, so the real, live-verified content below is captured here for firstmate or the captain to port into the live home (`/home/gabrielsgrancio/agents/captain-workspace/config/`), the same pattern that recovery doc already established.
Everything that is trackable in git - the router code, the deterministic `tests/fixtures/router-v2/` fixtures, and this documentation - is committed on this task's branch.

## What changed in code (committed)

- `bin/fm-router-v2.mjs`: `WORK_CORPORATE` removed from `validateConfigs` and `evaluateDataGate`.
  It now fails loudly as `Unknown data class: WORK_CORPORATE`, not a silent no-op.
  `SECRET`'s logic is untouched.
  `evaluateDataGate` gained a third `routeContext` argument and a per-model privacy gate for any profile that sets `per_model_privacy_required: true`.
  `PERSONAL_SENSITIVE` on such a profile additionally requires a fresh `config/provider-privacy-metadata.json` entry for the route's `resolved_runtime_model` showing `training_use !== "used"` and `retention_days === 0`; a missing or stale entry fails closed.
  `isPrivacyMetadataStale` implements the revalidation semantics: an entry is trusted until its own `valid_until` if the source publishes one, otherwise it expires `revalidation_cadence_days` (default 30) after `retrieved_at`.
- `tests/fixtures/router-v2/config/data-policy.json`: five classes (`PUBLIC`/`SANITIZED`/`PRIVATE_CODE`/`PERSONAL_SENSITIVE`/`SECRET`), `opencode_go` marked `per_model_privacy_required`.
- `tests/fixtures/router-v2/config/provider-privacy-metadata.json` (new): synthetic per-model entries for the fixture's opencode routes.
- `tests/fixtures/router-v2/data/provider-catalogs/compiled-route-targets.json`: added a `grok-4.6` fixture route to exercise the 30-day-retention case end to end.
- `tests/fm-router-v2-enforcement.test.mjs`: regression coverage for every item in the brief's Verification section (see below).
- `docs/router-v2.md`: new "Data classification" and "Per-model privacy metadata" sections documenting the five classes, the payload-not-repo rule, the metadata schema, and the revalidation mechanism.

## Data-class taxonomy migration

The captain's instruction was literal and exhaustive: move to exactly five classes.
The v2 taxonomy had seven (`PUBLIC`, `SYNTHETIC`, `SANITIZED`, `PERSONAL_PRIVATE`, `SHARED_TRAMPOLIM`, `WORK_CORPORATE`, `SECRET`, read live from `config/data-policy.json` for this task).
Nothing in `bin/` hardcodes any of these class names as a literal call-site string; every caller passes `dataClass` through as an opaque, caller-supplied value, so no functional call site needed literal-string updates beyond the router itself.

- `PUBLIC`, `SANITIZED`, `SECRET`: unchanged, same meaning.
- `WORK_CORPORATE`: removed per explicit captain instruction.
- `PERSONAL_PRIVATE`: renamed to `PERSONAL_SENSITIVE`; same concept, no semantic change.
- `SYNTHETIC`: retired, not merged.
  It described machine-generated or fabricated data with no real sensitive content by construction, `sensitivity: "none"`, allowed on every route already.
  That is the same practical treatment `PUBLIC` gives it, and no call site references it by name.
- `SHARED_TRAMPOLIM`: retired, not merged.
  It described "Trampolim project" multi-stakeholder material at `sensitivity: "medium-high"`, gated like `PERSONAL_PRIVATE` (`requires_disallow_training`) but allowed on more routes (also `gemini_consumer`, `opencode_go`).
  Folding it under the new `PERSONAL_SENSITIVE` is the conservative direction: it tightens its route allowance rather than loosening it, and preserves its sensitivity level.
  No call site references it by name.
- New: `PRIVATE_CODE`.
  This is the gap the captain explicitly flagged: the v2 taxonomy had no class for unpublished or proprietary code with no personal-sensitive payload, which is exactly why a Gabriel OS code-only task risked being classified `PERSONAL_PRIVATE` on repo location alone.
  `PRIVATE_CODE` is allowed everywhere `PUBLIC`/`SANITIZED` already were.

None of these four historical classes had any production caller passing them by name, so this is a config-shape migration, not a behavior change to any live call site.
`docs/ROUTER_V2_EXACT_RECOVERY.md` is left untouched: it is a dated forensic snapshot of 2026-09-13 state, not a functional reference.

## Live re-fetch: OpenCode Go policy, source and evidence

Source: <https://opencode.ai/docs/go/>, OpenCode's own published gateway policy.
That is the route owner, per the captain's explicit verification bar, not the underlying model vendors' direct APIs, which differ for at least three of the families below.

Retrieved: `2026-09-15T00:15:56Z`, this task, via `WebFetch`.
chrome-devtools-axi's browser bridge had no reachable Chrome instance in this sandbox (`CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222` refused connection, even after unsetting it for the call), so live retrieval used `WebFetch` instead, which fetches and renders the same published page.

Summary confirmed live, matching and sharpening `data/router-v3-research/report.md` section 1.4/3, itself a 2026-09-14 snapshot:

| Family | Retention | Training use | Note |
|---|---|---|---|
| Grok 4.6 | 30 days | Not used | ZDR unavailable, disables stateful features the gateway needs |
| GPT-5.6 Luna | 30 days | Not used | Abuse-monitoring logs retained up to 30 days |
| GLM 5.1/5.2/5.3/5.3-Flash | 0 days | Not used | |
| Kimi K2.6/K2.7 Code/K3 | 0 days | Not used | |
| LongCat-2.0 | 0 days | Not used | |
| MiMo V2.5 / V2.5-Pro | 0 days | Not used | |
| MiniMax M2.5/M2.7/M3 | 0 days | Not used | |
| Muse Spark 1.2/1.3 Contributor | Non-zero, unpublished exact days | Used | Discounted pricing in exchange for training permission; not ZDR; Meta Geographic Use Policy restrictions apply |
| DeepSeek V4/V4.1 Flash, V4 Pro, V4 Flash Vision Exp | 0 days | Not used | ZDR agreement, renewed monthly, valid through 2026-09-30 |
| Hy3 / Hy4-preview | 0 days | Not used | |
| Qwen 3.6-Plus/3.7-Max/3.7-Plus/3.8-Flash/3.8-Max | 0 days | Not used | |

Not confirmed on this page: `grok-4.5`, `glm-5` (base tier), `deepseek-flash`, `hy3-preview`, `kimi-k2.5`, `mimo-v2-omni`, `mimo-v2-pro`, `omen-alpha`, `qwen3.5-plus`.
These are present in the live `data/provider-catalogs/compiled-route-targets.json` catalog as of this task, 37 unique `opencode-go/*` routes total, read read-only for evidence purposes only; nothing under the primary checkout was written.
These nine are deliberately absent from the populated metadata rather than guessed.
The gate fails closed on a missing entry, so `PERSONAL_SENSITIVE` is correctly refused for these nine until someone revalidates them against a source that names them explicitly, such as OpenCode's pricing page, a support ticket, or a newer docs revision.

## Files to port into the live FM_HOME

Both are validated JSON, ready to copy as-is once the captain reviews them.

- `docs/router-v3-wp2-data-policy.json` to `config/data-policy.json`.
- `docs/router-v3-wp2-provider-privacy-metadata.json` to `config/provider-privacy-metadata.json` (new file; 28 of 37 live OpenCode Go routes populated with real sourced metadata, 9 intentionally absent per above).

After porting, run `FM_HOME=<home> node bin/fm-router-v2.mjs validate` to confirm the router still accepts the ported config.
Then spot-check with `FM_HOME=<home> node bin/fm-router-v2.mjs route strong_cheap_worker PERSONAL_SENSITIVE` to see Muse Spark and the unconfirmed models excluded while zero-retention models remain selectable.

## Verification evidence

Regression tests live in `tests/fm-router-v2-enforcement.test.mjs`.
Run with `node tests/fm-router-v2-enforcement.test.mjs`.
Also exercised via `tests/fm-router-herdr-dispatch-e2e.test.mjs`, `tests/fm-orchestrator-api.test.mjs`, `tests/fm-dynamic-discovery-acceptance.test.mjs`, and `tests/fm-quota-failover-auto-resume-e2e.test.mjs`, all passing unmodified against the new taxonomy.

- `WORK_CORPORATE` is fully gone: `evaluateDataGate('WORK_CORPORATE', ...)` now throws `Unknown data class: WORK_CORPORATE` instead of silently returning a refusal.
- `SECRET` is unchanged and still absolute on every profile.
- `PUBLIC`/`SANITIZED`/`PRIVATE_CODE` reach a Muse Spark route (`opencode_go`, per-model-gated profile) successfully.
- `PERSONAL_SENSITIVE` to the same Muse Spark route is refused, citing its real training-enabled metadata in the reason string.
- `PERSONAL_SENSITIVE` to a `grok-4.6` route is refused citing its real 30-day retention.
- `PERSONAL_SENSITIVE` to a verified zero-retention, non-training model (`qwen3.7-max`) is allowed.
- `PERSONAL_SENSITIVE` to a route with no metadata entry at all fails closed rather than defaulting to allowed.
- Full-pipeline `scoreAndSelectRoute` for `strong_cheap_worker`/`PERSONAL_SENSITIVE` skips `muse-spark` (rejection reason cites training) and still lands on `qwen3.7-max`.

## Explicitly out of scope

No changes to WP1A (dispatch-path unification) or WP9 (eval infrastructure) scope, per the brief's own boundary.
No Context Capsule work beyond expressing the five data classes at dispatch time; a full Context Capsule implementation is separate, larger scope per the brief, not attempted here.
