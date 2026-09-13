# Router V2

Router V2 is the canonical role, data-class, quota, effort, and RouteTarget decision layer.

The Router reads configuration and generated state from `FM_HOME` only.

The required static inputs are `config/model-registry.json`, `config/routing-policy.json`, `config/routing-priors.json`, and `config/data-policy.json`.

Provider catalogs, compiled RouteTargets, quota maps, learned routing, and telemetry are generated runtime state and are not source fixtures.

Run `FM_HOME=<home> node bin/fm-provider-discovery.mjs refresh` to refresh provider catalogs and compile RouteTargets from the provider-owned caches and live discovery commands.

Run `FM_HOME=<home> node bin/fm-router-v2.mjs validate` after refreshing to validate the static role and policy inputs.

Compiled catalogs and quota maps older than 24 hours are treated as stale, and missing or stale RouteTargets fail closed by producing no viable route rather than assuming abundance.

`bin/fm-quota-normalize.mjs` accepts quota-axi schema versions 3 and 5 and retains the source schema version in provenance.

OpenCode Go discovery uses a child process environment for the bearer key and never interpolates credentials into a shell command or error message.

Dispatch requires intake-provisioned task and brief state, invokes the existing `bin/fm-spawn.sh` lifecycle owner with `--backend herdr`, and appends routing receipts without taking ownership of backlog, lease, worktree, or continuity state.

The deterministic Router suites use the clearly synthetic fixtures under `tests/fixtures/router-v2` and do not access live credentials or private catalogs.
