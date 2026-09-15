# Router V3 Model Intelligence

Model Intelligence is the Router's source of semantic model capability and task fit.
It is knowledge, not Router code: the Router reads it from `FM_HOME` data files, and updating it needs no source edit.
`bin/fm-model-intelligence.mjs` owns the loader, the class anchors, the task-class mappings, failure attribution, and anomaly detection; this page owns the file schemas and the routing rules that consume them.

## Separate questions, separate owners

- Provider discovery (`bin/fm-provider-discovery.mjs`) answers what exists now and writes only `data/provider-catalogs/`.
- Model Intelligence (`data/model-intelligence/model-intelligence.json`) answers what a model is generally good at.
- Route validation (`data/model-intelligence/route-validation.json`) answers whether one concrete model, provider, harness, and effort path delivers a capability.
- Operating state (live quota, execution telemetry in `data/routing-executions.jsonl`) answers whether a route is healthy and economical right now.

A provider refresh never writes Model Intelligence, route validation, capability anomalies, learned routing, or telemetry; `tests/fm-model-intelligence.test.mjs` pins that.

## RouteTarget state dimensions

`routeStateDimensions` in `bin/fm-router-v2.mjs` derives four independent dimensions for each RouteTarget.

| Dimension | Values | Source |
|---|---|---|
| `availability` | `AVAILABLE`, `UNAVAILABLE`, `STALE`, `AUTH_REQUIRED` | catalog `availability` and `broken` |
| `spend_policy` | `BASELINE_SUBSCRIPTION`, `CREDIT_GATED`, `PAYG`, `FORBIDDEN` | explicit `spend_policy`, credit-gated markers, else one of the five subscription pools; an unrecognized pool is `FORBIDDEN` |
| `validation` | `UNKNOWN`, `VALIDATED`, `WARNING`, `FAILED` | route validation, worst-of over the capabilities the task class exercises |
| `operational_health` | `HEALTHY`, `DEGRADED`, `UNHEALTHY`, `UNKNOWN` | route validation `operational_health` |

Candidate generation rejects a route only for a hard blocker: availability other than `AVAILABLE`, spend policy other than `BASELINE_SUBSCRIPTION`, `MANUAL_ONLY` captain policy, validation `FAILED` for a capability this task class needs, or `UNHEALTHY` health.
Data policy and live pool status remain Stage A hard requirements.
Lifecycle `routing_status` stages (`BENCHMARK_ONLY` through `ROUTING_ELIGIBLE`), `real_n`, and the promotion criteria never block a route; they stay in the data as audit history.
`DEGRADED` health caps the route's Stage C health term at 0.5; `UNKNOWN` validation and health are uncertainty, never a block.

## `model-intelligence.json`

```json
{
  "schema_version": 1,
  "generated_at": "2026-09-15T00:00:00Z",
  "models": {
    "<model key>": {
      "model_version": "<string>",
      "aliases": ["<requested model or runtime slug that resolves to this backing model>"],
      "capabilities": {
        "<dimension>": {
          "class": "UNKNOWN | WEAK | ADEQUATE | STRONG | VERY_STRONG | FRONTIER",
          "confidence": "HIGH | MEDIUM | LOW",
          "provenance": [{
            "source": "<URL or citation>",
            "source_type": "<first_party_model_card | first_party_docs | benchmark_project | independent_evaluation | community | ...>",
            "retrieved_at": "<ISO date>",
            "model_version": "<string or null>",
            "benchmark": "<string or null>",
            "benchmark_harness": "<string or null>",
            "confidence": "HIGH | MEDIUM | LOW",
            "notes": "<string or null>",
            "effective_from": "<ISO date>",
            "valid_until": "<ISO date or null>"
          }]
        }
      }
    }
  }
}
```

Dimensions are `CAPABILITY_DIMENSIONS` in `bin/fm-model-intelligence.mjs`; `TASK_CLASS_DIMENSION` names the one Stage B reads for each router task class.
Every provenance entry carries all ten fields; `source`, `source_type`, `retrieved_at`, `confidence`, and `effective_from` must be non-empty.
An assertion is usable only with a known class other than `UNKNOWN`, a known confidence, and at least one complete provenance entry that is already effective and not past `valid_until`.
An unusable assertion, a missing dimension, or a model the file does not cover reads as `UNKNOWN`, and `node bin/fm-model-intelligence.mjs validate` prints why.

A route resolves to a model entry by the most specific identity first: `route_id`, `resolved_backing_model`, `resolved_runtime_model`, the runtime slug without `opencode-go/`, the Antigravity slug without its effort suffix, `raw_id`, `model_family`, `logical_alias`, and then any entry whose `aliases` list names one of those.
Aliases that currently hit one backing model therefore share one dataset, and an effort-specific key such as `gemini-3.8-flash-high` wins over the model key.

## `route-validation.json`

```json
{
  "schema_version": 1,
  "routes": {
    "<route_id>": {
      "operational_health": "HEALTHY | DEGRADED | UNHEALTHY | UNKNOWN",
      "capabilities": {
        "<capability>": { "status": "UNKNOWN | VALIDATED | WARNING | FAILED", "method": "<string>", "validated_at": "<ISO date>" }
      }
    }
  }
}
```

Validation is keyed by concrete `route_id` and is capability-specific; `TASK_CLASS_ROUTE_CAPABILITIES` lists the capabilities each task class exercises (`text_generation`, `tool_use`, `file_edit`, `long_context`).
A capability that is not validated does not disable the route for task classes that do not need it.

## Stage B quality

With a Model Intelligence file present, it is the only semantic quality source.
A usable assertion's class anchor is the Stage B quality, and its confidence sets the width of the existing Beta credible interval (`capabilityCredibleInterval`) with no real outcomes added.
Production outcomes never raise or lower that judgment.
Without the file, the legacy chain (capability record, family prior, seed prior) still applies so a home keeps routing until Model Intelligence is populated.

| Class | Quality anchor | Floors it clears |
|---|---|---|
| `FRONTIER` | 0.97 | every task-class floor, including critical audit 0.96 |
| `VERY_STRONG` | 0.94 | everything below critical audit, including brownfield and architecture 0.93 |
| `STRONG` | 0.88 | ordinary engineering floors up to targeted edit and test generation 0.84 |
| `ADEQUATE` | 0.80 | multi-file 0.80, retrieval 0.78, refactor 0.70 |
| `WEAK` | 0.60 | none |
| `UNKNOWN` | 0.50 | none without uncertainty tolerance |

The anchors are ordinal positions against `TASK_CLASS_QUALITY_FLOORS`, not benchmark conversions; a benchmark score is provenance for a class, never a probability.
Confidence pseudo-counts are HIGH 20, MEDIUM 10, and LOW 4.

Uncertainty tolerance belongs to the task.
A retry-tolerant, non-critical task outside the high-risk classes also admits a route with no semantic judgment (unknown, untested, or LOW-confidence intelligence) when the credible upper bound reaches the floor; Stage C still prices its mean.
High-risk classes rank Stage C by the credible lower bound.
A task marked critical needs real capability evidence (legacy chain) or HIGH-confidence intelligence on a route whose task capabilities are `VALIDATED`.

`node bin/fm-model-intelligence.mjs derive-priors` prints a `config/routing-priors.json`-shaped document derived from Model Intelligence and the compiled catalog, so seed priors can be regenerated instead of maintained as a second semantic source.

## Stage C

Stage C ranks routes that already cleared Stage B by economics; quality is not an additive score term.
`expected_successful_quota_burn` divides expected burn by the Stage B success probability, which is a class anchor, a credible bound, or a legacy posterior, never a raw benchmark percentage.
The route retry probability is shrunk toward the Stage B failure expectation with `RETRY_PRIOR_WEIGHT` pseudo-attempts in `bin/fm-routing-economics.mjs`, so one completed task cannot swing it to 0 or 1.

## Failure attribution

Every production outcome carries one attribution: `PROVIDER`, `HARNESS`, `TOOLING`, `CONTEXT`, `QUOTA`, `INFRASTRUCTURE`, `POLICY`, `EVALUATOR`, `TASK_SPEC`, `PROMPT`, `MODEL_BEHAVIOR`, or `AMBIGUOUS`, defaulting to `AMBIGUOUS`.
`recordTaskCompletion` stores it as `failure_attribution`, and `bin/fm-routing-eval.mjs real-traffic --attribution` records it on evaluation events.

- Only `MODEL_BEHAVIOR` with an evidence kind from `MODEL_BEHAVIOR_EVIDENCE` changes a legacy capability record; every other outcome is telemetry.
- `QUOTA`, `POLICY`, `EVALUATOR`, `TASK_SPEC`, `PROMPT`, and `CONTEXT` failures leave the route's retry reliability sample.
- `PROVIDER`, `TOOLING`, `INFRASTRUCTURE`, and `AMBIGUOUS` failures count as operational retry reliability.
- `HARNESS` with `--capability <name>` marks that route capability `WARNING` in route validation; production evidence never writes `FAILED`.

## Capability anomalies

When Model Intelligence declares `STRONG` or better for a task class and at least three of the last five semantically unexplained outcomes (`AMBIGUOUS` or `MODEL_BEHAVIOR`) for that route and task class failed, the evaluator appends a `CAPABILITY_ANOMALY` record to `data/model-intelligence/capability-anomalies.jsonl`.
The record lists the diagnostics to run and never changes Model Intelligence, route validation, or capability evidence; a person or a controlled evaluation decides what changes.
