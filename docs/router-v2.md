# Router V2

Router V2 is the canonical role, data-class, quota, effort, and RouteTarget decision layer.

The Router reads configuration and generated state from `FM_HOME` only.

The required static inputs are `config/model-registry.json`, `config/routing-policy.json`, `config/routing-priors.json`, and `config/data-policy.json`.

Provider catalogs, compiled RouteTargets, quota maps, learned routing, and telemetry are generated runtime state and are not source fixtures.

Run `FM_HOME=<home> node bin/fm-provider-discovery.mjs refresh` to refresh provider catalogs and compile RouteTargets from the provider-owned caches and live discovery commands.

Run `FM_HOME=<home> node bin/fm-router-v2.mjs validate` after refreshing to validate the static role and policy inputs.

## Context Broker

`bin/fm-context-broker.mjs` is the runtime context boundary used by Router dispatch.

It classifies reads, repository scans, grep/reference results, test/build output, logs, and generated boilerplate before a premium reasoner receives them.

Small targeted reads stay direct.

Oversized and multi-file inputs are deterministically reduced first, then may be sent to a context worker selected through the same Router capability and economics machinery as the primary route.

The context worker is checked with `evaluateDataGate` for the actual payload data class before any worker callback receives source content.

Each non-secret request emits a versioned `ContextPack` under the private `state/context-cache/` directory with source hashes, repository state, relevant files and ranges, findings, commands, unresolved questions, and token telemetry.

The cache key includes repository state, relevant source hashes, query, operation, and data-policy scope, so changing relevant input cannot reuse stale evidence.

`fm-spawn.sh --context-pack <path>` exports `FM_CONTEXT_PACK` and `FM_CONTEXT_BROKER` to the worker and adds the pack contract to its launch brief.

Premium workers can use the broker's targeted-slice operation to retrieve exact lines after validating the pack's source hash.

Generated boilerplate may be written directly to a repository artifact with the broker, leaving the premium worker the artifact path, hash, diff stat, and validation result.

Compiled catalogs and quota maps older than 24 hours are treated as stale, and missing or stale RouteTargets fail closed by producing no viable route rather than assuming abundance.

`bin/fm-quota-normalize.mjs` accepts quota-axi schema versions 3 and 5 and retains the source schema version in provenance.

OpenCode Go discovery uses a child process environment for the bearer key and never interpolates credentials into a shell command or error message.

Dispatch requires intake-provisioned task and brief state, invokes the existing `bin/fm-spawn.sh` lifecycle owner with `--backend herdr`, and appends routing receipts without taking ownership of backlog, lease, worktree, or continuity state.

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
