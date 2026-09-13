# This is the Router V2 the captain was actually using

Recovery date: 2026-09-13.

This is an evidence report, not a redesign, canonicalization, merge, or
promotion. It reconstructs the Router V2 that existed on the live FirstMate
home on 2026-09-12/13 and the source that produced it.

## Executive finding

Router V2 was a real, runnable chain, but it was not a clean-checkout
artifact. Its executable source was committed on the preserved overnight
branch; its registries, policies, catalogs, quota map, learned state, and
telemetry were private ignored files on the live host. The exact live bundle
validated and produced route decisions when run with `FM_HOME` pointing at
that home. The same source on the clean integration oracle could not run its
normal suites because those private inputs were absent.

The exact source is recoverable. It is not safe to land unchanged because of
the private-state gap, root-versus-`FM_HOME` path seams, provider-discovery
bearer-key shell interpolation, quota truth/schema divergence, and incomplete
clean-checkout/integration evidence. Those are adaptation and fix tasks for a
follow-on; this document does not perform them.

## 1. Exact source and provenance

The preserved source refs were checked directly:

| Ref | Exact tip | Meaning |
| --- | --- | --- |
| `archive/overnight-arch-evolution-2026-09-13` | `c270d22e5d624804210fb9c236fd087a562122c2` | Pinned untouched source archive |
| `overnight/arch-evolution` | `c270d22e5d624804210fb9c236fd087a562122c2` | Same overnight source tip |
| `integration/overnight-full-2026-09-13` | `cc13f8907a4163ebd7bde3ae6bcb0c621e371d25` | Integration oracle tip; Router files unchanged from source |
| integration merge parent | `712b08c921dcc4ea6dadeec1024b9617459d8080` | The actual overnight-to-main merge recorded by the oracle |

`git diff --name-status archive/overnight-arch-evolution-2026-09-13
integration/overnight-full-2026-09-13` contains no Router, discovery, quota, or
Router-test file. Blob checksums confirm the following are identical in the
archive and integration refs:

| File | Blob SHA-1 at both refs |
| --- | --- |
| `bin/fm-router-v2.mjs` | `af6d6755e48c146a42df89a4e8e09cd02c6d1606` |
| `bin/fm-provider-discovery.mjs` | `e56ffc1d4b5c0470db1d33db28a9fc516112e256` |
| `bin/fm-opencode-quota.mjs` | `be0af2124b889317de79aa233228fec14e2c5bea` |
| `tests/fm-router-v2-enforcement.test.mjs` | `c0a7f29be769274c7fd970993a26854ad3ac4adb` |
| `tests/fm-router-herdr-dispatch-e2e.test.mjs` | `e9815fe4022990b29524a9c4a80754e597fdb0f9` |
| `tests/fm-dynamic-discovery-acceptance.test.mjs` | `5de878f113b55c7ba38ce0af88999c9445cdad37` |
| `tests/fm-quota-failover-auto-resume-e2e.test.mjs` | `320d8d83f7859020b70d7d0977d86b5fa424a733` |

The complete `git log --follow -- bin/fm-router-v2.mjs` on
`overnight/arch-evolution` is:

1. `3369c60347882454058b621af1c7aa8f48255073` — first Router V2 implementation: integrity, canonical roles, Bayesian posteriors, and data gates.
2. `613dbde3377b9bac40689ab85d3e06580dfc050d` — provider discovery, 83 RouteTargets, AGY 3P, and OpenCode economics.
3. `ef2e8b03204bee48fce8d3a6920ba9c730726991` — discovery integrity, honest cache parsing, shared OpenCode capacity, and effort.
4. `2c46873413b411ef66718a931a0b7c0a839d8a6b` — authoritative OpenCode usage, subscription windows, and burn correction.
5. `5644821f6f35352b9779807be1bb955104367c24` — quota truth, failover, mission capsule, and launcher wiring.

There are no later Router-file edits through `c270d22e`. `e4499f26` is the
preceding routing-architecture/data-policy documentation commit. `b6202a5a`
is the preceding OpenCode Go harness acceptance dependency. The twelve-commit
overnight stack is recorded in the integration baseline; the other commits
are surrounding Gabriel/TUI, harness, mission, and recovery work rather than
additional Router-file edits.

## 2. Literal runtime bundle

### Source files

| Component | Exact source | Provenance | Classification | Recommendation |
| --- | --- | --- | --- | --- |
| Router engine | `bin/fm-router-v2.mjs` (885 lines) | `3369c603`, `613dbde3`, `ef2e8b03`, `2c468734`, `5644821f`; final file at `c270d22e` | `COMMITTED_SOURCE` | `ADAPT` |
| Discovery adapters/compiler | `bin/fm-provider-discovery.mjs` (619 lines) | `613dbde3`, `ef2e8b03`; final file at `c270d22e` | `COMMITTED_SOURCE` | `FIX` |
| OpenCode Go quota adapter | `bin/fm-opencode-quota.mjs` (210 lines) | `2c468734`; final file at `c270d22e` | `COMMITTED_SOURCE` | `ADAPT` |
| Existing quota compatibility/parser | `bin/fm-quota-axi-lib.sh`, `bin/fm-quota-choose.sh`, `bin/fm-procevent-quota.sh` | Earlier current-main commits; `fm-procevent-quota.sh` also changed at `c270d22e` | `COMMITTED_SOURCE` | `ADAPT` |
| Herdr/worker seam | `bin/fm-spawn.sh` plus `bin/backends/herdr.sh` | Long-lived current FirstMate source; Router calls `fm-spawn.sh` at Router lines 616-632 | `COMMITTED_SOURCE` | `ADAPT` at Router seam; `KEEP_AS_IS` for existing lifecycle guards |
| Failover coordinator | `bin/fm-failover.sh` | `5644821f` | `COMMITTED_SOURCE` | `ADAPT` |
| Orchestrator integration | `bin/fm-orchestrator-api.mjs` | `9186aac1` and later overnight state | `COMMITTED_SOURCE` | `ADAPT` |
| Supervisor route probe | `bin/fm-supervisor-watchdog.sh` | `d7f254b0`/overnight state | `COMMITTED_SOURCE` | `ADAPT` |

`fm-router-v2.mjs` loads the registry, policy, priors, data policy, quota map,
optional learned state, and optional compiled routes at lines 15-33. It does
not actually consume `DISPATCH_PATH` after declaring it at line 18; ordinary
crew-dispatch consultation remains a separate bootstrap/spawn concern.

The engine behavior is:

- `validateConfigs()` checks canonical roles, champion/challenger model IDs,
  policy role references, prior role references, and the two fail-closed data
  classes (lines 36-82).
- `evaluateDataGate()` unconditionally rejects `SECRET` and `WORK_CORPORATE`,
  then checks a route profile's `allowed_data_classes` (lines 84-105).
- `planContextShunting()` switches at 50,000 raw tokens to a
  `fast_context`/`gemini-3.8-flash` bulk-reader plan and leaves smaller inputs
  direct (lines 107-123).
- `scoreAndSelectRoute()` requires a nonempty non-`UNKNOWN` data class,
  filters by role capability family, lifecycle, data policy, quota exhaustion,
  and optional exclusions, then scores learned posterior quality, scarcity,
  normalized burn, effort fit, and the AGY-3P arbitrage rule (lines 280-493).
- `dispatchThroughHerdr()` scores first, prepares/reopens a task and brief,
  writes a `started` receipt, invokes `fm-spawn.sh` with selected harness,
  model, and effort, recursively excludes a launch-failed route, then writes a
  dispatched receipt and reads task metadata (lines 505-777).
- `recordTaskCompletion()` writes a completion receipt using task metadata and
  an optional report (lines 779-811). The CLI exposes `validate`, `route`,
  `dispatch`, `complete`, and `teardown` (lines 824-885).

### Role registry and policy state

These exact files existed in the live home at
`/home/gabrielsgrancio/agents/captain-workspace`, were ignored by the
repository, and were absent from the clean integration oracle. SHA-256 values
are included to identify the recovered state without committing it:

| File | Version/shape | SHA-256 | Classification | Recommendation |
| --- | --- | --- | --- | --- |
| `config/model-registry.json` | v3; 10 roles, 16 models | `4ab3ea75920a3645b41ea48fc89fa57aaffc0b92ce2a0b0d5e4338f4e1f4ca49` | `UNCOMMITTED_BUT_REQUIRED_CONFIG` | `PORT` |
| `config/routing-policy.json` | v3; 10 canonical roles plus scarcity/economics policy | `eba26ad3b8537ce5d2c1e0dd030fe3ca1de205d859536e3207564dc27b414f63` | `UNCOMMITTED_BUT_REQUIRED_CONFIG` | `PORT` |
| `config/routing-priors.json` | v3; 13 prior entries | `e71e2014faa726b3f5219f28ad9ed78b76e28f89d5f7080dea0c5b9decd3d10c` | `UNCOMMITTED_BUT_REQUIRED_CONFIG` | `PORT` |
| `config/data-policy.json` | v2; 7 data classes and 5 live profiles | `fe5682485518e8d13ebda65f10d77eb0d5a7c39749db7c4d412febc14fef25cd` | `UNCOMMITTED_BUT_REQUIRED_CONFIG` | `PORT` |
| `config/crew-dispatch.json` | rules/default profile arrays; not read by Router scoring | `28ccacb8f9e535f83670cc3a30833bd01dba3927f74d4a1e2235d82bfa82ba3f` | `UNCOMMITTED_BUT_REQUIRED_CONFIG` | `ADAPT` |

The ten canonical roles and exact champion/challenger mapping were:

| Role | Champion | Challenger(s) | Default effort in final Router |
| --- | --- | --- | --- |
| `fast_precise` | `gpt-5.6-luna` | `qwen3.8-flash` | low |
| `cheap_tool_worker` | `qwen3.8-flash` | `gpt-5.6-luna` | low |
| `strong_cheap_worker` | `qwen3.7-max` | `muse-spark-1.3-contributor` | medium |
| `general_engineer` | `gpt-5.6-terra` | `qwen3.7-max` | medium |
| `fast_context` | `gemini-3.8-flash` | `gemini-3.1-pro` | low |
| `deep_context` | `kimi-k3` | `kimi-k2.7-code` | high |
| `autonomous_engineer` | `claude-sonnet-5` | `gpt-5.6-terra` | medium |
| `deep_engineer` | `gpt-5.6-sol` | `claude-opus-5` | high |
| `architect_synthesizer` | `claude-opus-5` | `gpt-5.6-sol`, `claude-fable-5-1` | high |
| `critical_auditor` | `claude-opus-5` | `gpt-5.6-sol` | high |

The live model registry marks `claude-fable-5-1` unavailable and
`credits_required_org_disabled`; it must not be treated as a normal live
champion. The learned file had ten role buckets, two or three candidates per
bucket, and every observed `promotion_eligible_real_n` was false.

The data policy allows `PUBLIC`, `SYNTHETIC`, and `SANITIZED` on all five
profiles; allows `PERSONAL_PRIVATE` and `SHARED_TRAMPOLIM` only on the Claude
and Codex consumer profiles; and allows neither corporate nor secret data on
any live profile. `WORK_CORPORATE.fail_closed` and `SECRET.fail_closed` are
true in the recovered file.

### Quota truth and economics

`bin/fm-router-v2.mjs` directly invokes `quota-axi --json` with
`execFileSync` at lines 152-163. It maps fresh/known provider evidence to
`codex_plus`, `claude_pro`, `antigravity_gemini`, and `antigravity_3p`, and
sets all pools to `UNKNOWN` on command/parse failure (lines 166-277). The
scoring path treats `UNKNOWN` conservatively and rejects `EXHAUSTED` (lines
339-379); an unknown state receives a negative quota bonus rather than an
abundance bonus (lines 400-418).

The recovered quota map was:

| Pool | Recovered state | Window summary |
| --- | --- | --- |
| `codex_plus` | `ABUNDANT`, `HEALTHY` | 100% remaining 5h and weekly |
| `claude_pro` | `ABUNDANT`, `HEALTHY` | 100% 5h; 72% 7-day |
| `antigravity_gemini` | `ABUNDANT`, `HEALTHY` | 95% 5h; 82% weekly |
| `antigravity_3p` | `ABUNDANT`, `HEALTHY` | 100% 5h and weekly |
| `opencode_go` | `ABUNDANT`, `HEALTHY` | 100% 5h; 99% weekly; 100% monthly |
| `opencode_go_qwen38_flash` | `ABUNDANT` alias | metered allowance, cash marginal cost 0.0 |

`data/quota-pool-map.json` was v5, SHA-256
`0e0915d894c5b18c6666c2a46853118783c3db92ef4f3372255d0c8b7b84d0aac`.
The recovered OpenCode economics were `quota_cost: metered_allowance`,
`cash_marginal_cost: 0.0`, and a medium-confidence observed effective burn
ratio of 12.48x for `qwen3.7-max` versus `qwen3.8-flash`; intrinsic burn was
explicitly `UNKNOWN`.

`bin/fm-opencode-quota.mjs` uses HTTPS rather than a shell for the usage
endpoint (lines 69-126), normalizes rolling 5h, weekly, and monthly windows
(lines 128-166), persists a last-known-good snapshot, and returns `UNKNOWN`
when no credential or cache exists (lines 168-195). The separate
`fm-quota-axi-lib.sh` requires a quota-axi JSON schema version 5 in its
validator, while the observed installed `quota-axi 0.1.29 --json` emitted
`schemaVersion: 3`. This is a concrete truth-layer seam, not evidence that
either source should be rewritten wholesale.

### Provider catalogs and compiled RouteTargets

The recovered generated catalogs were captured at approximately 17:07 BRT on
2026-09-12:

| File | Source/shape | Count | SHA-256 | Classification |
| --- | --- | ---: | --- | --- |
| `data/provider-catalogs/codex.json` | `~/.codex/models_cache.json`; 6 models | 6 | `f0d715da495c47181db1a8060d332beccdd51a554002fdf8c41c7e5374aa026` | `GENERATED_RUNTIME_STATE` |
| `data/provider-catalogs/claude.json` | `~/.claude.json` cache slots; 4 models | 4 | `4a1a5f65bc8f60dcd8dcda12837bec0ec49ca78f993cd55a989754b45dc681e3` | `GENERATED_RUNTIME_STATE` |
| `data/provider-catalogs/antigravity.json` | `agy models`; 11 native + 3 3P | 14 | `ea6b2bca2aa62899bae6da18b08da722fb7cd8545a98e0c5d698fd93149f8f2a` | `GENERATED_RUNTIME_STATE` |
| `data/provider-catalogs/opencode-go.json` | authenticated models endpoint; 37 models | 37 | `056e6ade59d712921dc435e3864a54515472e9975da2eaafa84c920e615f7373` | `GENERATED_RUNTIME_STATE` |
| `data/provider-catalogs/compiled-route-targets.json` | compiler output | 83 routes | `287e2d5d3c4b8f0af47612858c853a08d0d8052ef023807c6655ae986f1d63db` | `GENERATED_RUNTIME_STATE` |

The compiled set had 52 `ROUTING_ELIGIBLE`, 28 `BENCHMARK_ONLY`, and 3
`CREDIT_GATED` routes: 21 Codex, 11 Claude, 14 Antigravity, and 37
OpenCode. Route profiles were `codex_consumer` (21), `claude_consumer`
(11), `gemini_consumer` (14), `opencode_go` (28), and `opencode_go_cn` (9).

The discovery implementation produces this shape:

```text
{ harness, stale, refresh_failed, discovered_at, source, models[] }
```

Claude additionally exposes `observed_slot_models`; Antigravity exposes
`gemini_native[]` and `third_party[]`. Each model carries provenance,
availability, smoke-test state, lifecycle state, and model identity. The
compiler expands supported reasoning efforts into independent RouteTargets
for Codex/Claude and assigns provider path, quota pool, data profile,
normalized burn, and timestamps (discovery lines 359-499).

OpenCode discovery is the one confirmed security defect: lines 280-291 build a
shell `curl` command by interpolating the bearer key read from
`~/.local/share/opencode/auth.json`. The source documentation says the key is
never exposed, but this implementation does not enforce that claim. The
recommendation is `FIX` the adapter before reuse, while preserving its output
shape and economics semantics.

### Learned state, telemetry, and cache

| File/state | Observed evidence | Classification | Recommendation |
| --- | --- | --- | --- |
| `data/learned-routing.json` | v3; 10 roles; 20 candidate statistics; all promotion gates false; SHA-256 `078b8d90d570143b1127cfcb6fa1cc1b2b93407dd01a0fff4b8235efe2ec0242` | `GENERATED_RUNTIME_STATE` | `ADAPT` |
| `data/routing-executions.jsonl` | 463 records: 220 started, 62 dispatched, 157 launch-failed, 8 completed, 16 legacy records without dispatch status; SHA-256 `ba0eb0eb85d01a158332697ccf995b12c9882ab6ff2423d18e66ed02ce1be693` | `GENERATED_RUNTIME_STATE` | `ADAPT` |
| `data/routing-benchmark.json` | v1 benchmark evidence; 8 roles and 9 benchmark records; SHA-256 `435d8b7f5de6379869629d1c41412681ba7334775fdb5d13822786a2fc72491e` | `GENERATED_RUNTIME_STATE` | `ADAPT` |
| `data/opencode-go-usage-snapshot.json` | Last-known-good normalized OpenCode snapshot; SHA-256 `557cf0371dc3ebd1213663f431f2e1bd0e7cb74a50d3468eeb15d31df00b4694` | `CACHE` | `ADAPT` |
| `~/.codex/models_cache.json` | Input to Codex discovery | `CACHE` | `KEEP_AS_IS` as provider-owned cache |
| `~/.claude.json#clientDataCacheSlots` and `additionalModelOptionsCache` | Input to Claude discovery | `CACHE` | `KEEP_AS_IS` as provider-owned cache |
| `~/.local/share/opencode/auth.json` | OpenCode credential source; value intentionally not recorded | `SECRET` | `KEEP_AS_IS` outside repository; fix handling |
| `/home/gabrielsgrancio/.local/bin/agy models` | Live Antigravity catalog probe | `OPTIONAL_RUNTIME_DISCOVERY` | `ADAPT` |
| `quota-axi --json` | Live quota probe; installed version observed as 0.1.29 | `OPTIONAL_RUNTIME_DISCOVERY` | `ADAPT` at schema/normalization seam |
| native `codex`, `claude`, `opencode`, and `agy` CLIs | Harness execution dependencies | `OPTIONAL_RUNTIME_DISCOVERY` | `KEEP_AS_IS` subject to bootstrap/version gates |

No credential, API key, token, or auth-file content is reproduced here.

## 3. Integration points and exact operational path

The intended direct path was:

```text
fm-orchestrator-api.mjs dispatch
  -> require dataClass
  -> dispatchThroughHerdr()
  -> Router V2 role/data/quota/lifecycle/effort decision
  -> tasks-axi reopen/add and fm-brief.sh if needed
  -> fm-spawn.sh --harness <selected> --model <selected> --effort <selected>
  -> read state/<task>.meta
  -> routing-executions.jsonl started/dispatched receipt
```

The orchestrator declares `dataClass` required and calls
`dispatchThroughHerdr()` at `bin/fm-orchestrator-api.mjs:51-66` and
`:254-280`. The Router-to-Herdr name is historical: Router lines 616-632 do
not pass `--backend herdr`; the result depends on ambient backend detection or
configuration. `docs/UNIVERSAL_FRONT_DOOR_DISCOVERY.md` on the overnight ref
records this exact seam. The failover coordinator calls Router from
`bin/fm-failover.sh:137-157`, and the supervisor watchdog probes Router at
`bin/fm-supervisor-watchdog.sh:78-103`.

The failover design preserves the same worktree, writes a checkpoint, releases
the old lease, excludes the failed route, updates harness/model metadata, and
adds resumption guidance (`bin/fm-failover.sh:84-126`, `:130-157`,
`:173-245`). The source should be reconciled with current-main mission,
lease, worktree, and continuity owners before promotion; the integration
oracle explicitly retained current-main versions for overlapping mission and
host-continuity files.

## 4. Behavioral fixtures and observed results

The probes used the exact committed source from
`overnight/arch-evolution` through a Node module import and the recovered
host-local bundle via `FM_HOME=/home/gabrielsgrancio/agents/captain-workspace`.
No private file was copied into this disposable worktree. Inputs such as
`PUBLIC`, quota overrides, route exclusions, and role samples were synthetic
representative inputs; they do not claim to be historical task payloads.

### Validation and ten-role sample

`validateConfigs()` returned `{ valid: true, canonicalRolesCount: 10,
modelsCount: 16 }`. With `useLiveAxi: false` (the recovered map as a
deterministic fixture), the exact winners were:

| Role | RouteTarget | Model | Harness | Effort | Candidate/viable |
| --- | --- | --- | --- | --- | ---: |
| `fast_precise` | `codex:gpt-5.6-luna:low` | `gpt-5.6-luna` | codex | low | 11/11 |
| `cheap_tool_worker` | `codex:gpt-5.6-luna:low` | `gpt-5.6-luna` | codex | low | 11/11 |
| `strong_cheap_worker` | `opencode:qwen3.7-max` | `opencode-go/qwen3.7-max` | opencode | null | 3/2 |
| `general_engineer` | `codex:gpt-5.6-terra:medium` | `gpt-5.6-terra` | codex | medium | 12/12 |
| `fast_context` | `agy:gemini-3.8-flash-low` | `gemini-3.8-flash-low` | antigravity | low | 9/9 |
| `deep_context` | `agy:gemini-3.1-pro-high` | `gemini-3.1-pro-high` | antigravity | high | 4/3 |
| `autonomous_engineer` | `claude:claude-sonnet-5:medium` | `claude-sonnet-5` | claude | medium | 11/11 |
| `deep_engineer` | `claude:claude-opus-5:high` | `claude-opus-5` | claude | high | 11/10 |
| `architect_synthesizer` | `claude:claude-opus-5:high` | `claude-opus-5` | claude | high | 13/10 |
| `critical_auditor` | `claude:claude-opus-5:high` | `claude-opus-5` | claude | high | 9/9 |

This is the recovered behavior, not a claim that each champion mapping in the
private registry is what wins under every quota state.

### Effort, quota, data, and fallback fixtures

Observed deterministic fixtures:

- `general_engineer` with target effort `low` selected
  `codex:gpt-5.6-terra:low`; target `high` selected
  `codex:gpt-5.6-terra:high`. Effort is a real RouteTarget axis.
- With every pool overridden to `UNKNOWN`, `general_engineer` still selected
  `codex:gpt-5.6-terra:medium`, returned `scarcityState: UNKNOWN`, and applied
  a conservative score/bonus. It did not convert unknown to abundant.
- With Codex exhausted and Claude unknown, `general_engineer` selected
  `agy-3p:claude-sonnet-4-6` and rejected all Codex Terra routes as
  `Quota Pool Exhausted`. This is the representative unavailable-provider
  fallback at the selection layer.
- With every candidate pool exhausted, routing failed closed with `No viable
  RouteTargets` and every candidate was rejected as quota exhausted.
- Excluding the normal `autonomous_engineer` winner
  `claude:claude-sonnet-5:medium` selected
  `codex:gpt-5.6-terra:medium` and emitted the rejection reason `Excluded by
  fallback re-routing policy`.
- `PUBLIC`, `SYNTHETIC`, and `SANITIZED` were allowed on Claude and the CN
  profile. `PERSONAL_PRIVATE` was allowed on `claude_consumer` and rejected
  on `opencode_go_cn`; `SHARED_TRAMPOLIM` was likewise rejected on the CN
  profile. `WORK_CORPORATE` returned the exact fail-closed reason
  `no enterprise ZDR tenant verified`; `SECRET` returned `SECRET data is
  strictly excluded from all model context`.
- Missing or `UNKNOWN` `dataClass` throws before route selection and before
  dispatch, matching the enforcement test's fail-closed contract.

### Provider-discovery fixtures

Calling the exact discovery functions against the live provider caches/CLI
returned:

| Adapter | Output shape | Result |
| --- | --- | --- |
| `discoverCodex()` | `harness, stale, refresh_failed, discovered_at, source, models` | codex, fresh, 6 models |
| `discoverClaude()` | prior shape plus `observed_slot_models` | claude, fresh, 4 models |
| `discoverAntigravity()` | `harness, stale, refresh_failed, discovered_at, source, gemini_native, third_party` | antigravity, fresh, 11 + 3 |
| `discoverOpenCodeGo()` | normal shape or fallback shape | not run against the live credential because its implementation invokes a shell command with the bearer key; static source inspection and the recovered catalog establish its normal shape |

The safe no-`curl` fallback probe returned `harness: opencode-go`,
`stale: true`, `refresh_failed: true`, `source: none`, and `models: []`.
The fallback reason is intentionally not reproduced because the live-home
credential could be present in the shell-built error text. This itself is
evidence for the required discovery fix.

### Existing test evidence

The integration oracle's recorded run is the authoritative clean-checkout
evidence (`integration/overnight-full-2026-09-13:docs/OVERNIGHT_FULL_INTEGRATION_BASELINE.md:25-61`):

- `tests/fm-router-v2-enforcement.test.mjs` could not start: missing
  `config/model-registry.json` and private routing catalog.
- `tests/fm-router-herdr-dispatch-e2e.test.mjs` had six route failures from the
  missing registry and lacked routing telemetry.
- `tests/fm-dynamic-discovery-acceptance.test.mjs` passed five checks, then
  failed because `data/provider-catalogs/codex.json` was absent.
- `tests/fm-quota-failover-auto-resume-e2e.test.mjs` passed four checks, then
  failed at route selection because the registry was absent.
- `tests/fm-opencode-go-acceptance.test.sh`, the Orchestrator read/API tests,
  chat/persistence tests, host resilience, and supervisor continuity evidence
  passed in the oracle; these do not prove the complete Router chain.

Other Router/discovery/quota-touching tests present on the overnight ref are
`tests/fm-opencode-go-acceptance.test.sh`,
`tests/fm-opencode-primary-live-e2e.test.sh`,
`tests/fm-quota-choose.test.sh`,
`tests/fm-quota-array-dispatch-live-e2e.test.sh`,
`tests/fm-procevent-quota.test.sh`, and the four Router-specific suites named
above. The generic quota helpers predate Router V2 and are not substitutes for
the missing private fixture bundle.

## 5. State provenance search

For every requested private path, `git log --all -- <path>` returned zero
commits. The paths are ignored by `.gitignore` (`config/` and `data/`), and
all requested private files were absent from the archive and integration
trees. The recovered live-home mtimes cluster on 2026-09-12:

- Registry/policy files: 13:17-13:19 BRT.
- Catalogs: 14:07 BRT (discovery at 17:07 UTC).
- Quota map: 16:53 BRT; learned state: 13:18 BRT.
- Routing telemetry: through 22:54 BRT.

That establishes that the files existed as host-local state, not as commits in
any searched branch. It does not establish which earlier uncommitted command
first created each file; no such historical claim is made here. Their exact
classification is:

| Requested state | Classification |
| --- | --- |
| Five `config/*.json` files | `UNCOMMITTED_BUT_REQUIRED_CONFIG` |
| `data/quota-pool-map.json` | `GENERATED_RUNTIME_STATE` (required input snapshot) |
| `data/learned-routing.json` | `GENERATED_RUNTIME_STATE` |
| Four provider catalogs and `compiled-route-targets.json` | `GENERATED_RUNTIME_STATE` |
| `data/routing-executions.jsonl` | `GENERATED_RUNTIME_STATE` |
| `data/opencode-go-usage-snapshot.json` | `CACHE` |
| Provider auth material | `SECRET` |
| Native provider caches and live discovery commands | `CACHE` / `OPTIONAL_RUNTIME_DISCOVERY` as listed above |

No runtime cache or secret has been added to this worktree or either requested
deliverable.

## 6. Direct answers and promotion assessment

### (1) Exact Router V2 version used yesterday

The executable was the final `bin/fm-router-v2.mjs` file at overnight tip
`c270d22e`, whose content was last changed by `5644821f`. Its final Router blob
is `af6d6755...`; the exact full blob and source ref are listed above. It ran
against the recovered v3/v2 private registries, v5 quota map, generated
catalogs, learned state, and telemetry in the live home.

### (2) Exact source branch/commits

The source branch was `overnight/arch-evolution`, identically preserved as
`archive/overnight-arch-evolution-2026-09-13`, at `c270d22e`. The complete
Router edit chain was `3369c603 -> 613dbde3 -> ef2e8b03 -> 2c468734 ->
5644821f`; `e4499f26` supplied the architecture/data-policy predecessor and
`b6202a5a` supplied the OpenCode harness dependency. The integration oracle
merged the branch at `712b08c9` and retained the Router files byte-for-byte.

### (3) What required state was uncommitted

All five config files, quota map, learned routing, provider catalogs,
compiled routes, and routing telemetry were uncommitted ignored host state.
The OpenCode usage snapshot was a last-known-good cache. Native provider
caches, live discovery CLIs, quota-axi, and auth material were external
runtime dependencies; auth is `SECRET` and was not copied or printed.

### (4) What concretely prevents that exact implementation from being landed as-is today

1. A clean checkout has no required private state; the oracle recorded the
   four Router-suite failures above.
2. Router config resolution checks the process root before `FM_HOME`
   (`fm-router-v2.mjs:6-23`), while dispatch/telemetry and discovery write
   directly under the process root (`fm-router-v2.mjs:540-596`, `:683-809`,
   and `fm-provider-discovery.mjs:6-8`, `:564-570`). This cannot safely serve
   the home layout as-is.
3. Provider discovery interpolates the OpenCode bearer key into a shell
   command (`fm-provider-discovery.mjs:280-291`). This is a concrete credential
   handling vulnerability.
4. Quota layers disagree on the observed `quota-axi` schema (helper validator
   requires v5; installed 0.1.29 emitted v3), and malformed/missing upstream
   fields need a single unknown-safe contract.
5. Router dispatch does not explicitly select Herdr and independently mutates
   task/brief state; it must be reconciled with current-main task, lease,
   `FM_HOME`, supervisor-continuity, and stale-base contracts.
6. The recovered catalogs are provider snapshots, not portable source; their
   provenance and refresh policy are private and time-bound. Tests need
   deterministic checked-in synthetic fixtures without checking in secrets or
   live caches.

### (5) Which portions can be promoted unchanged

The ten-role vocabulary, fail-closed `SECRET`/`WORK_CORPORATE` intent,
unknown-is-not-abundant principle, effort as a RouteTarget dimension, learned
state separation of real observations from priors, OpenCode no-PAYG semantic,
append-only receipt fields, and current FirstMate/Herdr lifecycle guards can be
preserved unchanged in meaning. The existing current-main Herdr, worktree,
lease, watcher, hold, and supervisor-continuity guards are safer owners than
the overnight duplicates.

### (6) Which portions require adaptation and why

The Router adapter needs one authoritative home-path resolver and an explicit
backend/dispatch receipt contract. Provider discovery needs non-shell HTTP
and secret-safe failure handling. Quota normalization needs one schema-aware,
provenance-bearing layer shared by Router, worker quota selection, and
failover; stale, unknown, and missing values must never become abundant.
Catalogs and learned/telemetry artifacts need generated-state lifecycle and
deterministic fixture policy. Orchestrator/Gateway callers need to route
through the same data-class, role, and task-authority seam. The tests need
portable synthetic fixtures and a clean-checkout acceptance lane. The
overnight mission/failover overlaps need reconciliation against current-main,
not wholesale adoption.

### (7) Is the eight-phase rebuild still necessary?

No, not as a rebuild-from-scratch plan. Recovery shows a substantial working
implementation and a concrete live bundle: the next work is smaller
canonicalization plus targeted fixes/adapters and deterministic fixture
packaging. The eight capability areas remain useful as follow-on workstreams
(state packaging, discovery security, quota unification, Router seam,
telemetry, and integration tests), but their implementation should preserve
the recovered Router semantics and use the archived source as the baseline.

## Recommendation matrix

| Component | Recommendation | Evidence |
| --- | --- | --- |
| Router V2 scoring/data gate/effort semantics | `ADAPT` | Direct ten-role and fail-closed probes passed with the recovered bundle |
| Canonical role registry and static policy intent | `PORT` | `validateConfigs()` passed 10 roles/16 models; only packaging/provenance is missing |
| Provider discovery output/compiler | `FIX` | Output and 83-route compiler are recoverable; bearer-key shell interpolation is unsafe |
| OpenCode quota adapter | `ADAPT` | HTTPS and LKG/UNKNOWN structure exists; it must join the authoritative quota contract |
| Generic quota helper seam | `ADAPT` | Useful fail-closed helper, but schema v5 versus observed schema v3 and primary-provider limitation |
| Quota map, catalogs, compiled routes | `ADAPT` | Real generated state exists, but is private/time-bound and absent in clean checkout |
| Learned routing and telemetry | `ADAPT` | Real receipt/state formats exist; lifecycle correlation and deterministic provenance are incomplete |
| Router-to-Herdr/Orchestrator seam | `ADAPT` | Direct path exists, but backend is ambient and task authority is duplicated |
| Existing Herdr/worktree/lease/continuity owners | `KEEP_AS_IS` | Current-main integration oracle retained them and passed continuity/resilience evidence |
| Overnight duplicate mission implementation | `SUPERSEDE` | Integration oracle retained current-main mission schema because overnight version was redundant |
| Router/discovery/quota test suites | `ADAPT` | Assertions are valuable, but clean execution requires portable synthetic fixtures |
