# Router V3 WP5 and WP6 Economics Scheduler Report

Date: 2026-09-15.

Branch: `fm/router-v3-wp5-wp6-economics-scheduler`.

The implementation replaces the flat `qualityScore + quotaBonus + effortFitScore` selection with an explicit Stage A, Stage B, and Stage C pipeline.

## Design

`bin/fm-routing-economics.mjs` owns pure resource-economics calculations and telemetry aggregation.

`bin/fm-router-v2.mjs` keeps WP3/WP4 candidate generation intact and invokes the scheduler after candidate generation.

Stage A applies exclusions, lifecycle status, availability, explicit effort requirements, data policy, quota exhaustion, unavailable pool status, and full-pool concurrency checks.

Stage B computes a task-class quality floor from the WP4 concrete capability posterior, then removes candidates below that floor.

The default floors are `0.84` for targeted edits, `0.82` for mechanical tool work, `0.84` for test generation, `0.70` for refactors, `0.80` for multi-file features, `0.93` for brownfield debugging, `0.78` for large-context retrieval, `0.90` for long-horizon engineering, `0.93` for architecture reasoning, and `0.96` for critical audits.

The floor is task-class-specific, can be explicitly supplied by the caller, and is never a fixed `0.90` fallback.

Stage C ranks only the sufficiently good survivors by expected successful quota burn, headroom, budget surplus, pressure, projected exhaustion, reset horizon, expected unused quota at reset, latency, concurrency, retry probability, exploration value, route health, and effort compatibility.

Stage C does not add raw quality to the economic score, so a higher-quality survivor does not win indefinitely when a sufficiently good pool is underutilized.

## Expected successful quota burn

For a route with capability success probability `p`, the implementation uses `p = clamp(posterior_mean, 0.01, 0.999)` when a WP4 capability record is present.

The exact implemented formula is `expected_successful_quota_burn = expected_quota_burn_per_attempt / p`.

`expected_quota_burn_per_attempt` is learned from real quota snapshots when available.

For each completed execution, the observed raw burn is the largest positive percentage-point drop across matching before and after quota windows.

The pool calibration scale is the median of `observed_percentage_drop / route.expected_normalized_burn` across real observations in that pool.

When the selected route has observations, its attempt burn is `observed_route_percentage_drop / pool_calibration_scale`.

When the selected route has no observation but its pool has observations, its attempt burn is `route.expected_normalized_burn * pool_calibration_scale`.

When neither exists, the route's `expected_normalized_burn` is the explicit fallback.

The expected retries metric is `(1 - p) / p`.

The scheduler exposes the route pairing fields `task_success_probability`, `expected_retries`, `expected_token_usage`, `actual_token_usage`, `observed_normalized_quota_consumption`, `rolling_headroom_percent`, `weekly_headroom_percent`, `monthly_headroom_percent`, reset times, `recent_burn_velocity`, `current_concurrency`, `latency_seconds`, and `cache_efficiency`.

### Concrete formula examples

The WP4 fixture's concrete `codex:gpt-5.6-terra:medium` record uses `p=0.96` and route burn `1.0`, producing `1.0 / 0.96 = 1.041667` expected successful quota burn.

The WP4 fixture's concrete `agy-3p:claude-sonnet-4-6` record uses `p=0.93` and route burn `1.0`, producing `1.0 / 0.93 = 1.075269` expected successful quota burn.

The WP4 fixture's concrete `opencode:qwen3.7-max` strong-worker record uses `p=0.96` and route burn `12.5`, producing `12.5 / 0.96 = 13.020833` expected successful quota burn.

The real-quota-delta test captures OpenCode Go at `90%` weekly remaining before dispatch and `85%` after dispatch, learning a `5` percentage-point observed delta and retaining the normalized route burn for the shared pool.

The same observed-delta path records `1,200` actual tokens and verifies the expected-successful-burn formula directly.

## Budget pacing and USE_BEFORE_RESET

For each rolling, weekly, and monthly window, `target_remaining(t)` is the remaining fraction of the window horizon at the current time.

The implementation computes `surplus = actual_remaining - target_remaining` and `pressure = recent_burn_velocity / sustainable_burn_velocity`.

`USE_BEFORE_RESET` fires only when a window has less than two hours to reset, more than thirty percent remaining, positive expiring surplus, and pressure below `1.25`.

The controlled-consumption effect is bounded by the expiring surplus and capped at `0.15`, rather than being a flat large bonus.

The pacing fixture uses an `80%` rolling window with one hour remaining, yielding `target_remaining=20`, `surplus=60`, and a positive pressure calculation.

## Quality-floor evidence

The regression fixture constructs an old-flat case where a `0.79` route in `USE_BEFORE_RESET` would score `0.79 + 0.15 + 0.05 = 0.99`, while a `0.90` route under `CONSERVE` would score `0.90 - 0.10 + 0.05 = 0.85`.

With an explicit `0.88` quality floor, Stage B rejects the old-flat winner and retains the `0.90` route for Stage C.

## Underutilized pool evidence

The realistic scheduler fixture gives native Codex a `0.96` success posterior and `60%` remaining headroom.

It gives AGY 3P a marginally lower `0.93` success posterior and `100%` remaining headroom while native Claude remains at `80%`, well above the `25%` threshold.

The old raw-quality ordering would prefer the `0.96` route.

Stage B retains both routes, and Stage C selects `agy-3p:claude-sonnet-4-6` because its underutilized `antigravity_3p` pool has better headroom and capacity economics.

This proves AGY 3P participates in normal economic routing before native Claude reaches emergency scarcity.

## OpenCode Go shared-meter guarantee

The quota map's five first-class resource pools are `claude_pro`, `codex_plus`, `antigravity_gemini`, `antigravity_3p`, and `opencode_go`.

Every OpenCode Go route resolves to the single `opencode_go` account pool.

Model-specific burn multipliers remain route parameters, such as `qwen3.7-max=12.5`, and are never converted into independent model wallets.

The scheduler emits exactly one OpenCode Go pool economics record, marks it `shared_meter=true`, and retains the route's `model_burn_multiplier` separately.

The regression test asserts that no `opencode_go_<model>` pool is created.

## Live quota observation

A read-only live refresh on 2026-09-15 returned OpenCode Go headroom of `99%` rolling, `100%` weekly, and `84%` monthly.

The same refresh returned Codex `100%` on its reported five-hour and weekly windows.

Claude and AGY quota semantics were reported as unknown by the current live quota adapter, so the scheduler preserved unknown health instead of treating those pools as abundant.

## Verification

`node tests/fm-routing-eval.test.mjs` passed with `Routing evaluation lifecycle, promotion gate, deterministic evidence, and exploration policy passed`.

`node tests/fm-router-v2-enforcement.test.mjs` passed with `Router V2 enforcement and ten-role regression fixtures passed`.

`node tests/fm-router-ingress.test.mjs` passed with `All Router V3 WP1A Ingress Tests Passed Successfully`.

`node tests/fm-dynamic-discovery-acceptance.test.mjs` passed with `Dynamic discovery and generated-state lifecycle fixtures passed`.

`bin/fm-lint.sh` passed with ShellCheck `0.11.0`, actionlint `1.7.12`, and three valid workflow files.

`node --check bin/fm-router-v2.mjs`, `node --check bin/fm-routing-economics.mjs`, and `git diff --check` passed.

No remote was contacted for delivery, no PR was opened, and no merge was performed.
