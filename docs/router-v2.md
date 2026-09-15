# Router V2

Router V2 is the canonical role, data-class, quota, effort, and RouteTarget decision layer.

The Router reads configuration and generated state from `FM_HOME` only.

The required static inputs are `config/model-registry.json`, `config/routing-policy.json`, `config/routing-priors.json`, and `config/data-policy.json`.

The optional knowledge inputs are `data/model-intelligence/model-intelligence.json` and `data/model-intelligence/route-validation.json`.

Provider catalogs, compiled RouteTargets, quota maps, learned routing, and telemetry are generated runtime state and are not source fixtures.

Run `FM_HOME=<home> node bin/fm-provider-discovery.mjs refresh` to refresh provider catalogs and compile RouteTargets from the provider-owned caches and live discovery commands.

Run `FM_HOME=<home> node bin/fm-router-v2.mjs validate` after refreshing to validate the static role and policy inputs.

## Context Broker

`bin/fm-context-broker.mjs` is the runtime context boundary used by Router dispatch.

It classifies reads, repository scans, grep/reference results, test/build output, logs, and generated boilerplate before a premium reasoner receives them.

Small targeted reads stay direct.

Oversized and multi-file inputs are deterministically reduced first, then may be sent to a context worker selected through the same Router capability and economics machinery as the primary route.

The context worker is checked with `evaluateDataGate` for the actual payload data class before any worker callback receives source content.

The broker validates the exact five-class taxonomy before reading any source and refuses a `SECRET` or unknown class as a whole operation: no pack, query echo, cache entry, targeted slice, or artifact write is produced.

Each request emits a versioned `ContextPack` under the private `state/context-cache/` directory with source hashes, repository state, relevant files and ranges, findings, commands, unresolved questions, and token telemetry.

The cache key includes repository state, relevant source hashes, query, operation, and data-policy scope, so changing relevant input cannot reuse stale evidence.

`fm-spawn.sh --context-pack <path>` exports `FM_CONTEXT_PACK` and `FM_CONTEXT_BROKER` to the worker and adds the pack contract to its launch brief.

Premium workers can use the broker's targeted-slice operation to retrieve exact lines after validating the pack's source hash.

Generated boilerplate may be written directly to a repository artifact with the broker, leaving the premium worker the artifact path, hash, diff stat, and validation result.

Current limits: Router dispatch builds one pack at dispatch and hands it to the worker, and the launch brief asks the worker to route bulk reads through the broker.
Nothing intercepts a worker's later tool reads, grep, test, build, or log output mid-task, so that use is instructed rather than enforced.
No production context-worker provider adapter exists yet: Router dispatch and the broker CLI construct the broker without `shuntWorker`, so a shunt-class request falls back to compact deterministic evidence (`fallback_to_direct_reasoner: true`) and counts no worker tokens as spent.
The shunt-worker callbacks in `tests/fm-context-broker.test.mjs` are fixtures, so their token-saving figures are lexical fixture measurements, not billed provider work.

## Task continuation

`bin/fm-task-state.mjs` owns the WP8 `TaskStateCapsule` stored at `data/<task>/task-state.json`.
When a dispatch launch fails, `dispatchThroughHerdr` classifies the failure (an explicit classification reported by the spawn runner, otherwise quota or data-policy wording, otherwise `HARD_RUNTIME_FAILURE`), creates or updates the capsule with the failed route, prior diff, modified files, and refuted hypotheses, and selects the retry through `selectContinuationRoute`, so the failure class can change the role, task class, and pool rather than only excluding the failed route.
The retry writes `data/<task>/continuation.md`, and `fm-spawn.sh` carries it in the launch brief as the worker's continuation state.
`saveTaskStateCapsule` refuses a `SECRET` capsule outright and redacts values under credential-shaped keys in any other class.
Current limits: only launch failures observed by Router dispatch feed a capsule; a worker that fails after launching, or a `fm-control.sh relaunch`, does not yet create one.
`tests/fm-router-v3-task-state.test.mjs` and `tests/fm-router-ingress.test.mjs` pin this path, the latter through a real `fm-spawn.sh` launch.

Compiled catalogs and quota maps older than 24 hours are treated as stale, and missing or stale RouteTargets fail closed by producing no viable route rather than assuming abundance.

`bin/fm-quota-normalize.mjs` accepts quota-axi schema versions 3 and 5 and retains the source schema version in provenance.

Live quota windows replace static quota-map windows; a provider that is omitted, stale, or not `known` leaves its pool `UNKNOWN` with no windows and no headroom, and an `auth_required` provider marks its pools `AUTH_REQUIRED` so Stage A refuses them.
Stage C never scores unmeasured headroom and flags such routes `quota_evidence: unknown_low_confidence`.
`USE_BEFORE_RESET` and expected unused quota at reset are bounded by the most binding window's surplus.
Burn learning in `bin/fm-routing-economics.mjs` ignores deltas across a window reset or overlapping same-pool dispatches, requires `MIN_BURN_CALIBRATION_SAMPLES` clean pool samples, bounds each observation to `BURN_RATIO_BOUND` times the catalog burn, and shrinks toward the catalog burn with `BURN_PRIOR_WEIGHT`.
An open execution holds a concurrency slot only while its task's `state/<task>.meta` exists, and a task holds at most one slot.
Evaluator writes to `data/learned-routing.json` serialize on `data/learned-routing.json.lock`.
For `HIGH_RISK_TASK_CLASSES` in `bin/fm-routing-capability.mjs`, Stage B keeps the floor on the posterior mean while Stage C ranks by the Beta posterior's conservative credible lower bound, so thin evidence cannot outrank deeper evidence on a marginally higher mean.
`tests/fm-router-v3-enforcement-readiness.test.mjs` pins these guarantees.

OpenCode Go discovery uses a child process environment for the bearer key and never interpolates credentials into a shell command or error message.

Dispatch requires intake-provisioned task and brief state, invokes the existing `bin/fm-spawn.sh` lifecycle owner with `--backend herdr`, and appends routing receipts without taking ownership of backlog, lease, worktree, or continuity state.

## Dispatch authority

`node bin/fm-router-v2.mjs dispatch --task-id <id> --project <dir> --data-class <class> --role <role> (--scout | --mode <mode> --yolo <on|off>)` is the normal crewmate and scout dispatch entrypoint; its usage line lists the optional task-class, effort, retry-tolerance, critical, and backend flags.
[`docs/configuration.md`](configuration.md) "Router dispatch authority" owns when `fm-spawn.sh` enforces it and how the audited manual override behaves.
Before selecting, dispatch regenerates a missing or stale compiled catalog once through `bin/fm-provider-discovery.mjs refresh` and refuses if the catalog is still not fresh; `node bin/fm-router-v2.mjs catalog-refresh-if-stale` runs the same check by hand.
A provider refresh that falls back to a snapshot older than 24 hours publishes that provider's routes as `stale_catalog`, so Stage A refuses them instead of reading the fresh file time as fresh evidence.
`verifyRouterProvenance`, `evaluateManualOverrideSpendGate`, and `evaluateManualOverrideDataGate` are the checks `fm-spawn.sh` calls through the `verify-provenance`, `override-spend-gate`, and `override-gate` subcommands.
Provenance binds the recorded data class and effort as well as the task, execution, route, harness, and model, and refuses `SECRET` even with a matching record.
The spend gate admits only a catalogued route in one of the five subscription pools that is not credit-gated; an uncatalogued model, a model catalogued in any other pool, a harness with no subscription route, and a custom command are refused.

Candidate generation admits every RouteTarget that no hard blocker excludes; lifecycle `routing_status`, `real_n`, and promotion criteria are audit history, not eligibility.
[`docs/router-v3-model-intelligence-schema.md`](router-v3-model-intelligence-schema.md) owns the route state dimensions, hard blockers, Model Intelligence and route validation schemas, Stage B quality rules, and failure attribution.
Without a Model Intelligence file, a `config/routing-priors.json` entry counts as seed-prior quality evidence only when it names the route's harness (a prior without a `harness` is not admitted) and lists the requested role in `recommended_roles`, and a task marked critical still requires real evidence.
`tests/fm-router-v3-single-authority.test.mjs` and `tests/fm-model-intelligence.test.mjs` pin these guarantees, and `tests/fm-router-ingress.test.mjs` exercises enforcement through real `fm-spawn.sh` launches.

The deterministic Router suites use the clearly synthetic fixtures under `tests/fixtures/router-v2` and do not access live credentials or private catalogs.

## Data classification

`config/data-policy.json` defines exactly five data classes: `PUBLIC`, `SANITIZED`, `PRIVATE_CODE`, `PERSONAL_SENSITIVE`, `SECRET`.
There is no `WORK_CORPORATE` class - corporate work is deliberately performed outside FirstMate.
`SECRET` is unconditionally refused by `evaluateDataGate` regardless of route profile.
No secret, API key, password, SSH key, bearer token, or seed phrase may enter model context under any provider.

Classify the actual payload being sent, never the repository or task it came from.
A code-only task in a personal repository is `PRIVATE_CODE` (or even `PUBLIC`/`SANITIZED` for genuinely generic code with no personal data in it), not `PERSONAL_SENSITIVE` by default.
Living in a personal repo does not by itself make a payload personal-sensitive.

## Per-model privacy metadata

A single route profile can front many unrelated model vendors, e.g. `opencode_go`, which proxies OpenAI, xAI, Zhipu, Moonshot, Meta, Alibaba, and DeepSeek models behind one gateway.
One blanket privacy claim for a profile like that is unreliable, because real per-model policies differ.
Profiles that set `"per_model_privacy_required": true` in `config/data-policy.json` (currently `opencode_go`) additionally gate `PERSONAL_SENSITIVE` per concrete model, using `config/provider-privacy-metadata.json` (optional; a missing entry fails closed).

Each entry is keyed by the route's `resolved_runtime_model` (e.g. `opencode-go/qwen3.7-max`) and carries:

- `provider` / `gateway`: which vendor and which gateway serves this route.
- `model_family`: the exact model.
- `training_use`: `"used"` or `"not_used"`.
  `PERSONAL_SENSITIVE` is refused when a provider may train on prompts/completions.
- `retention_days`: how long the route owner retains data.
  `PERSONAL_SENSITIVE` is refused when this is non-zero.
- `zdr`: whether a zero-data-retention agreement applies, if the route owner publishes one.
- `source`: the route-owner's own published policy URL.
  First-party documentation from the **route owner** (e.g. OpenCode's own gateway policy for `opencode-go/*`) is the accepted evidence bar, not the underlying model vendor's direct API policy, which can differ.
  OpenCode Go, for example, publishes 0-day retention and no training for most models it proxies, but 30-day retention for Grok 4.6 and GPT-5.6 Luna, and explicit training-enablement for Muse Spark models, none of which match those vendors' own direct-API defaults.
- `retrieved_at`: when this entry was last verified against the source.
- `valid_until`: optional, only when the route owner publishes an explicit expiry.

`isPrivacyMetadataStale` in `bin/fm-router-v2.mjs` owns staleness and revalidation.
An entry is trusted until its own `valid_until` if the route owner publishes one.
Otherwise it expires `revalidation_cadence_days` (top-level field in `config/provider-privacy-metadata.json`, default 30) after `retrieved_at`.
A stale or missing entry fails closed: `PERSONAL_SENSITIVE` is refused, not silently allowed.
Revalidate by re-fetching the route owner's published policy and updating `retrieved_at` (and `valid_until` if given); there is no automatic re-fetch.

Example: Muse Spark models are not blanket-disabled.
They remain reachable for `PUBLIC`/`SANITIZED`/genuinely-non-sensitive `PRIVATE_CODE` payloads.
They are refused only for `PERSONAL_SENSITIVE` (and always `SECRET`), driven by their real `training_use: "used"` metadata rather than a hand-written model-name special case.
