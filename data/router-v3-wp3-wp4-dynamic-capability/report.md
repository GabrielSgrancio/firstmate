# Router V3 WP3 and WP4 dynamic capability report

Date: 2026-09-14.

Branch: `fm/router-v3-wp3-wp4-dynamic-capability` from `cdfc7b25b27ddd8c8178d6af96db6b28c54a980c`.

## Gate replacement

`CAPABILITY_INDEX` was removed after a repository-wide search confirmed that `bin/fm-router-v2.mjs` was its only production consumer.

`queryCapabilityCandidates` in `bin/fm-router-v2.mjs` now scans every compiled RouteTarget and admits a route when its concrete `(route_id, task_class)` capability record satisfies the WP9 promotion criteria or when the same record is eligible for WP9 exploration.

Exploration calls the shared WP9 policy with the concrete route profile and runtime model, and therefore requires a retry-tolerant, non-critical task, an allowed `PUBLIC`, `SANITIZED`, or `PRIVATE_CODE` data class, and a passing `evaluateDataGate` result.

Broken, manual-only, and credit-gated catalog routes remain blocked independently of capability evidence.

Canonical roles remain vocabulary through the role-to-task-class mapping in `bin/fm-routing-capability.mjs`; no role-to-model or model-family allow-list remains in candidate generation.

## Capability record schema

`data/learned-routing.json` is now version 4 and stores `route_capabilities[route_id].capabilities[task_class]` records.

Each route bucket records `route_id`, `route`, `model_family`, and `harness`.

Each task-class record records `route_id`, `task_class`, `role`, `model_family`, `model`, `harness`, `provider`, `real_n`, `real_successes`, `deterministic_evaluations`, `deterministic_failures`, `prior_mean`, `prior_effective_n`, `posterior_mean`, `promotion_eligible_real_n`, and task-class `routing_status`.

Each record also stores explicit uncertainty with `real_n`, effective sample count, binomial standard error, and `untested` versus `measured` status.

Promotion transitions update only the capability record for the evaluated RouteTarget and task class, while the compiled catalog's route-level status remains unchanged.

The old `role_statistics` shape is read once for migration, with concrete route IDs retaining route evidence and ambiguous model-family keys treated as prior-only information.

## Model-family priors

`model_family_priors[model_family][task_class]` is a read-only aggregate derived from real evidence in multiple concrete route records.

The aggregate stores its prior mean, effective sample count, source real count, source route count, and uncertainty.

A new RouteTarget may initialize its task-class prior from this aggregate, but its own `real_n` remains zero and the aggregate cannot promote or grant eligibility to that route.

Family aggregation uses the exact catalog `model_family` identity and excludes `deepseek-v4*` families because the current catalog exposes DeepSeek V4 alias variants without temporal backing-model proof.

The requested `data/router-v3-research/provider-model-research-addendum-2026-09-14.md` file was absent from this isolated checkout, so the DeepSeek safeguard was based conservatively on the existing provider-discovery and WP2 catalog entries rather than claiming addendum contents that were not available.

## Executable candidate evidence

The fixture-backed public candidate query was run for three role/task-class combinations.

`fast_precise / targeted_edit` returned `codex:gpt-5.6-luna:low` and `codex:gpt-5.6-luna:medium` with `basis=real_evidence` and `real_n=15`.

`strong_cheap_worker / test_generation` returned `opencode:qwen3.7-max` and `opencode:muse-spark` with `basis=real_evidence` and `real_n=15`.

`general_engineer / refactor` returned the empirically proven Terra routes plus `opencode:qwen3.8-flash` with `model=opencode-go/qwen3.8-flash`, `basis=exploration`, `real_n=0`, and `exploration_phase=bootstrap`.

The OpenCode Go route is present in the discovered catalog but has no refactor capability record, demonstrating that candidate visibility is no longer controlled by the former role model list.

## Verification

The task-class and RouteTarget isolation suite passed:

```text
node tests/fm-routing-eval.test.mjs
--- Adversarial promotion and RouteTarget isolation ---
Routing evaluation lifecycle, promotion gate, deterministic evidence, and exploration policy passed
```

The Router V2 enforcement suite passed, including dynamic candidate generation, zero-sample exploration, task-class scoping, data gating, and the existing ten-role selections:

```text
node tests/fm-router-v2-enforcement.test.mjs
Router V2 enforcement and ten-role regression fixtures passed
```

The Router ingress suite passed end to end:

```text
node tests/fm-router-ingress.test.mjs
--- All Router V3 WP1A Ingress Tests Passed Successfully ---
```

The dynamic discovery acceptance suite passed:

```text
node tests/fm-dynamic-discovery-acceptance.test.mjs
Dynamic discovery and generated-state lifecycle fixtures passed
```

Additional syntax and whitespace checks passed:

```text
node --check bin/fm-routing-capability.mjs && node --check bin/fm-routing-eval.mjs && node --check bin/fm-router-v2.mjs && git diff --check
```

The focused tests retain Wave 1 promotion safety, concrete RouteTarget isolation, exploration data-class gating, and ingress lifecycle coverage after `CAPABILITY_INDEX` removal.
