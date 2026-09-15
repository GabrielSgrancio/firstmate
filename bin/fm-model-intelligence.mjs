#!/usr/bin/env node
// Usage: fm-model-intelligence.mjs <validate|derive-priors> [--home <dir>]
//
// Model Intelligence consumer for Router V3.
//
// Knowledge lives in FM_HOME data files, never in Router source:
//   data/model-intelligence/model-intelligence.json  what a model is generally good at
//   data/model-intelligence/route-validation.json    whether one concrete route delivers a capability
//   data/model-intelligence/capability-anomalies.jsonl  append-only production/intelligence contradictions
// docs/router-v3-model-intelligence-schema.md owns the file schemas.
//
// validate       prints the loader's view (models, usable assertions, errors) as JSON.
// derive-priors  prints a config/routing-priors.json-compatible document derived from
//                Model Intelligence and the compiled RouteTargets, so seed priors are a
//                generated artifact rather than a second semantic source of truth.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const currentFmHome = () => path.resolve(process.env.FM_HOME || ROOT);

export const MODEL_INTELLIGENCE_RELATIVE_PATH = 'data/model-intelligence/model-intelligence.json';
export const ROUTE_VALIDATION_RELATIVE_PATH = 'data/model-intelligence/route-validation.json';
export const CAPABILITY_ANOMALIES_RELATIVE_PATH = 'data/model-intelligence/capability-anomalies.jsonl';

export const CAPABILITY_CLASSES = Object.freeze(['UNKNOWN', 'WEAK', 'ADEQUATE', 'STRONG', 'VERY_STRONG', 'FRONTIER']);

// Ordinal quality anchors used by Stage B.  They are placed against the task-class
// quality floor ladder in fm-router-v2.mjs (refactor 0.70, retrieval 0.78,
// multi-file 0.80, mechanical 0.82, targeted/test 0.84, long-horizon 0.90,
// brownfield/architecture 0.93, critical audit 0.96), so each class clears a
// deliberate tier of floors: FRONTIER clears every floor, VERY_STRONG every floor
// below critical audit, STRONG the ordinary engineering floors up to 0.84, ADEQUATE
// the floors up to 0.80, WEAK none, and UNKNOWN is the uninformative midpoint.
// They are not benchmark conversions and carry no precision beyond that ordering.
export const CLASS_QUALITY_PRIOR = Object.freeze({
  FRONTIER: 0.97,
  VERY_STRONG: 0.94,
  STRONG: 0.88,
  ADEQUATE: 0.8,
  WEAK: 0.6,
  UNKNOWN: 0.5
});

// Confidence sets only the width of the uncertainty around a class anchor
// (pseudo-observations in the existing Beta credible interval); it never moves the anchor.
export const CONFIDENCE_PSEUDO_N = Object.freeze({ HIGH: 20, MEDIUM: 10, LOW: 4 });

export const CAPABILITY_DIMENSIONS = Object.freeze([
  'targeted_edit', 'mechanical_tool_work', 'test_generation', 'refactor', 'general_engineering',
  'multi_file_feature', 'brownfield_debugging', 'concurrency_debugging', 'backend', 'frontend',
  'infra', 'systems', 'security', 'autonomous_engineering', 'long_horizon', 'architecture',
  'critical_review', 'tool_use', 'repo_retrieval', 'long_context', 'multimodal'
]);

// Router task class -> the Model Intelligence dimension that answers task fit.
export const TASK_CLASS_DIMENSION = Object.freeze({
  targeted_edit: 'targeted_edit',
  mechanical_tool_work: 'mechanical_tool_work',
  test_generation: 'test_generation',
  refactor: 'refactor',
  multi_file_feature: 'multi_file_feature',
  brownfield_debugging: 'brownfield_debugging',
  large_context_repository_retrieval: 'repo_retrieval',
  long_horizon_autonomous_engineering: 'long_horizon',
  architecture_reasoning: 'architecture',
  critical_audit: 'critical_review'
});

// Route capabilities a task class exercises.  Route validation is looked up per
// capability; an unlisted or UNKNOWN capability is uncertainty, not a block.
export const TASK_CLASS_ROUTE_CAPABILITIES = Object.freeze({
  targeted_edit: ['tool_use', 'file_edit'],
  mechanical_tool_work: ['tool_use'],
  test_generation: ['tool_use', 'file_edit'],
  refactor: ['tool_use', 'file_edit'],
  multi_file_feature: ['tool_use', 'file_edit'],
  brownfield_debugging: ['tool_use', 'file_edit'],
  large_context_repository_retrieval: ['tool_use', 'long_context'],
  long_horizon_autonomous_engineering: ['tool_use', 'file_edit'],
  architecture_reasoning: ['text_generation'],
  critical_audit: ['text_generation', 'tool_use']
});

export const VALIDATION_STATES = Object.freeze(['UNKNOWN', 'VALIDATED', 'WARNING', 'FAILED']);
export const OPERATIONAL_HEALTH_STATES = Object.freeze(['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN']);

export const PROVENANCE_REQUIRED_KEYS = Object.freeze([
  'source', 'source_type', 'retrieved_at', 'model_version', 'benchmark', 'benchmark_harness',
  'confidence', 'notes', 'effective_from', 'valid_until'
]);
const PROVENANCE_NON_NULL_KEYS = Object.freeze(['source', 'source_type', 'retrieved_at', 'confidence', 'effective_from']);

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return { present: false, value: null, error: null };
  try {
    return { present: true, value: JSON.parse(fs.readFileSync(filePath, 'utf8')), error: null };
  } catch (error) {
    return { present: true, value: null, error: `${filePath}: ${error.message}` };
  }
}

function timeMs(value) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function provenanceProblems(entry, nowMs) {
  if (!entry || typeof entry !== 'object') return ['provenance entry is not an object'];
  const problems = [];
  for (const key of PROVENANCE_REQUIRED_KEYS) {
    if (!(key in entry)) problems.push(`missing provenance field ${key}`);
  }
  for (const key of PROVENANCE_NON_NULL_KEYS) {
    if (key in entry && (entry[key] === null || entry[key] === '')) problems.push(`provenance field ${key} must not be empty`);
  }
  if (entry.confidence && !CONFIDENCE_PSEUDO_N[entry.confidence]) problems.push(`unknown provenance confidence ${entry.confidence}`);
  const from = timeMs(entry.effective_from);
  if (entry.effective_from && from === null) problems.push('effective_from is not a date');
  if (from !== null && from > nowMs) problems.push('assertion is not yet effective');
  const until = timeMs(entry.valid_until);
  if (entry.valid_until && until === null) problems.push('valid_until is not a date');
  if (until !== null && until < nowMs) problems.push('assertion expired (valid_until passed)');
  return problems;
}

// An assertion is usable only with a known class, a known confidence, and at
// least one complete, currently effective provenance entry.  Anything else is
// reported and read as UNKNOWN: missing knowledge is uncertainty, never a block.
export function normalizeAssertion(assertion, nowMs = Date.now()) {
  if (!assertion || typeof assertion !== 'object') return { usable: false, problems: ['assertion is not an object'] };
  const problems = [];
  if (!CAPABILITY_CLASSES.includes(assertion.class)) problems.push(`unknown capability class ${assertion.class}`);
  if (assertion.class === 'UNKNOWN') problems.push('class UNKNOWN carries no capability prior');
  if (!CONFIDENCE_PSEUDO_N[assertion.confidence]) problems.push(`unknown confidence ${assertion.confidence}`);
  const provenance = Array.isArray(assertion.provenance) ? assertion.provenance : [];
  if (!provenance.length) problems.push('no provenance');
  const valid = provenance.filter((entry) => provenanceProblems(entry, nowMs).length === 0);
  if (provenance.length && !valid.length) {
    problems.push(...provenance.flatMap((entry) => provenanceProblems(entry, nowMs)));
  }
  if (problems.length) return { usable: false, problems };
  return {
    usable: true,
    class: assertion.class,
    confidence: assertion.confidence,
    quality_prior: CLASS_QUALITY_PRIOR[assertion.class],
    pseudo_n: CONFIDENCE_PSEUDO_N[assertion.confidence],
    provenance: valid,
    problems: []
  };
}

export function loadModelIntelligence({ home = currentFmHome(), filePath = null } = {}) {
  const target = filePath || path.join(home, MODEL_INTELLIGENCE_RELATIVE_PATH);
  const read = readJsonIfPresent(target);
  const errors = read.error ? [read.error] : [];
  const value = read.value;
  if (value && (typeof value.models !== 'object' || value.models === null || Array.isArray(value.models))) {
    errors.push(`${target}: models must be an object`);
  }
  const models = value && !errors.length ? value.models : {};
  return {
    present: read.present && errors.length === 0 && Object.keys(models).length > 0,
    path: target,
    schema_version: value?.schema_version ?? null,
    generated_at: value?.generated_at ?? null,
    models,
    errors
  };
}

export function loadRouteValidation({ home = currentFmHome(), filePath = null } = {}) {
  const target = filePath || path.join(home, ROUTE_VALIDATION_RELATIVE_PATH);
  const read = readJsonIfPresent(target);
  const errors = read.error ? [read.error] : [];
  const routes = read.value?.routes && typeof read.value.routes === 'object' && !Array.isArray(read.value.routes)
    ? read.value.routes
    : {};
  if (read.value && read.value.routes !== undefined && routes !== read.value.routes) errors.push(`${target}: routes must be an object`);
  return { present: read.present && errors.length === 0, path: target, routes, errors };
}

// Most specific identity first, so an effort-specific entry (gemini-3.8-flash-high)
// wins over the model entry, and a resolved backing model shares one dataset
// across every alias that currently hits it.
export function modelKeysForRoute(route) {
  const runtime = route?.resolved_runtime_model || null;
  const stripped = runtime?.replace(/^opencode-go\//, '') || null;
  return [...new Set([
    route?.route_id,
    route?.resolved_backing_model,
    runtime,
    stripped,
    route?.harness === 'antigravity' ? stripped?.replace(/-(low|medium|high)$/, '') : null,
    route?.raw_id,
    route?.model_family,
    route?.logical_alias
  ].filter(Boolean))];
}

export function findModelEntry(intelligence, route) {
  const models = intelligence?.models || {};
  const keys = modelKeysForRoute(route);
  for (const key of keys) {
    if (models[key]) return { key, entry: models[key] };
  }
  for (const [key, entry] of Object.entries(models)) {
    const aliases = Array.isArray(entry?.aliases) ? entry.aliases : [];
    if (keys.some((candidate) => aliases.includes(candidate))) return { key, entry };
  }
  return null;
}

export function resolveTaskFit(intelligence, route, taskClass, now = new Date()) {
  const dimension = TASK_CLASS_DIMENSION[taskClass] || null;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const found = findModelEntry(intelligence, route);
  if (!found || !dimension) {
    return { usable: false, model_key: found?.key || null, dimension, class: 'UNKNOWN', problems: [found ? 'no dimension for task class' : 'model not in Model Intelligence'] };
  }
  const assertion = found.entry?.capabilities?.[dimension];
  if (!assertion) {
    return { usable: false, model_key: found.key, dimension, class: 'UNKNOWN', problems: [`no ${dimension} assertion`] };
  }
  const normalized = normalizeAssertion(assertion, nowMs);
  return { ...normalized, model_key: found.key, dimension, class: normalized.usable ? normalized.class : 'UNKNOWN' };
}

// Worst-of over the capabilities the task class exercises.  FAILED is a known
// hard incompatibility for this task class only; WARNING and UNKNOWN never block.
export function routeValidationSummary(validation, route, taskClass) {
  const record = validation?.routes?.[route?.route_id] || {};
  const required = TASK_CLASS_ROUTE_CAPABILITIES[taskClass] || [];
  const capabilities = {};
  for (const capability of required) {
    const status = record.capabilities?.[capability]?.status;
    capabilities[capability] = VALIDATION_STATES.includes(status) ? status : 'UNKNOWN';
  }
  const statuses = Object.values(capabilities);
  const overall = statuses.includes('FAILED') ? 'FAILED'
    : statuses.includes('WARNING') ? 'WARNING'
      : statuses.length && statuses.every((status) => status === 'VALIDATED') ? 'VALIDATED'
        : 'UNKNOWN';
  const health = OPERATIONAL_HEALTH_STATES.includes(record.operational_health) ? record.operational_health : 'UNKNOWN';
  return { validation: overall, capabilities, operational_health: health };
}

// Failure attribution.  Only MODEL_BEHAVIOR backed by one of the listed evidence
// kinds may touch capability evidence; every other attribution is telemetry
// routed to the store named in ATTRIBUTION_EFFECT.
export const FAILURE_ATTRIBUTIONS = Object.freeze([
  'PROVIDER', 'HARNESS', 'TOOLING', 'CONTEXT', 'QUOTA', 'INFRASTRUCTURE', 'POLICY',
  'EVALUATOR', 'TASK_SPEC', 'PROMPT', 'MODEL_BEHAVIOR', 'AMBIGUOUS'
]);

export const MODEL_BEHAVIOR_EVIDENCE = Object.freeze([
  'controlled_reproduction', 'repeated_deterministic_failure', 'known_good_prompt_fixture',
  'malformed_tool_use_validated_harness', 'controlled_evaluation', 'independent_review'
]);

export const ATTRIBUTION_EFFECT = Object.freeze({
  PROVIDER: 'operational_reliability',
  HARNESS: 'route_validation',
  TOOLING: 'operational_reliability',
  CONTEXT: 'telemetry_only',
  QUOTA: 'economics',
  INFRASTRUCTURE: 'operational_reliability',
  POLICY: 'telemetry_only',
  EVALUATOR: 'telemetry_only',
  TASK_SPEC: 'telemetry_only',
  PROMPT: 'telemetry_only',
  MODEL_BEHAVIOR: 'capability_evidence',
  AMBIGUOUS: 'operational_reliability'
});

// Attributions that explain a failure without implicating the route itself;
// they do not count against its operational retry reliability.
export const ROUTE_EXCUSED_ATTRIBUTIONS = Object.freeze(['QUOTA', 'POLICY', 'EVALUATOR', 'TASK_SPEC', 'PROMPT', 'CONTEXT']);

export function normalizeAttribution(attribution) {
  const value = typeof attribution === 'string' ? attribution.toUpperCase() : null;
  return FAILURE_ATTRIBUTIONS.includes(value) ? value : 'AMBIGUOUS';
}

export function capabilityMutationAllowed({ attribution, evidence = [] } = {}) {
  const normalized = normalizeAttribution(attribution);
  const kinds = (Array.isArray(evidence) ? evidence : [evidence]).filter((kind) => MODEL_BEHAVIOR_EVIDENCE.includes(kind));
  if (normalized !== 'MODEL_BEHAVIOR') {
    return { allowed: false, attribution: normalized, effect: ATTRIBUTION_EFFECT[normalized], reason: `${normalized} outcomes do not modify model capability` };
  }
  if (!kinds.length) {
    return { allowed: false, attribution: normalized, effect: 'telemetry_only', reason: `MODEL_BEHAVIOR requires one of: ${MODEL_BEHAVIOR_EVIDENCE.join(', ')}` };
  }
  return { allowed: true, attribution: normalized, effect: 'capability_evidence', evidence: kinds, reason: 'attributable model-behavior evidence' };
}

// Anomaly trigger: Model Intelligence says STRONG or better for the task class,
// and the most recent semantically unexplained production outcomes (AMBIGUOUS or
// MODEL_BEHAVIOR) for this route and task class hold a failure cluster.  Outcomes
// already attributed elsewhere (provider, harness, quota, prompt, ...) are
// explained and do not count.  The record never edits
// Model Intelligence; it asks for controlled diagnostics.
export const ANOMALY_MIN_FAILURES = 3;
export const ANOMALY_RECENT_OUTCOMES = 5;
const SEMANTICALLY_UNEXPLAINED = Object.freeze(['AMBIGUOUS', 'MODEL_BEHAVIOR']);
export const ANOMALY_STRONG_CLASSES = Object.freeze(['STRONG', 'VERY_STRONG', 'FRONTIER']);
export const ANOMALY_DIAGNOSTICS = Object.freeze([
  'model revision', 'prompt transformation', 'harness', 'provider', 'tools', 'context', 'repo state', 'task classification'
]);

export function detectCapabilityAnomaly({ outcomes = [], route, taskClass, taskFit, now = new Date() } = {}) {
  if (!taskFit?.usable || !ANOMALY_STRONG_CLASSES.includes(taskFit.class)) return null;
  const recent = outcomes
    .filter((event) => event?.route_id === route?.route_id && event?.task_class === taskClass && ['pass', 'fail'].includes(event?.outcome))
    .filter((event) => SEMANTICALLY_UNEXPLAINED.includes(normalizeAttribution(event.attribution)))
    .slice(-ANOMALY_RECENT_OUTCOMES);
  const failures = recent.filter((event) => event.outcome === 'fail');
  if (failures.length < ANOMALY_MIN_FAILURES) return null;
  return {
    type: 'CAPABILITY_ANOMALY',
    schema_version: 1,
    detected_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    route_id: route.route_id,
    task_class: taskClass,
    model_key: taskFit.model_key,
    dimension: taskFit.dimension,
    declared_class: taskFit.class,
    declared_confidence: taskFit.confidence,
    recent_outcomes: recent.length,
    unexplained_failures: failures.length,
    failure_evaluation_ids: failures.map((event) => event.evaluation_id).filter(Boolean),
    capability_changed: false,
    diagnostics_required: ANOMALY_DIAGNOSTICS
  };
}

// Seed priors as a generated view of Model Intelligence: one entry per resolved
// model key with the harness of the routes it covers, prior_mean from the
// strongest usable class across its task classes, and the roles whose task-class
// dimension is STRONG or better.
export function derivePriorsFromModelIntelligence(intelligence, routes = [], { roleTaskClass = {}, now = new Date() } = {}) {
  const priors = {};
  for (const route of routes) {
    if (!route?.route_id || route.broken) continue;
    const found = findModelEntry(intelligence, route);
    if (!found) continue;
    // Seed priors are keyed by model; a second harness for the same model gets its own key.
    const key = !priors[found.key] || priors[found.key].harness === route.harness ? found.key : `${found.key}@${route.harness}`;
    const entry = priors[key] || {
      route_target: route.resolved_runtime_model || route.route_id,
      model_intelligence_key: found.key,
      harness: route.harness,
      derived_from: MODEL_INTELLIGENCE_RELATIVE_PATH,
      recommended_roles: []
    };
    for (const [role, taskClass] of Object.entries(roleTaskClass)) {
      const fit = resolveTaskFit(intelligence, route, taskClass, now);
      if (!fit.usable) continue;
      if (!Number.isFinite(entry.prior_mean) || fit.quality_prior > entry.prior_mean) {
        entry.prior_mean = fit.quality_prior;
        entry.prior_effective_n = fit.pseudo_n;
      }
      if (ANOMALY_STRONG_CLASSES.includes(fit.class) && !entry.recommended_roles.includes(role)) entry.recommended_roles.push(role);
    }
    if (Number.isFinite(entry.prior_mean)) priors[key] = entry;
  }
  return { version: 3, derived_from: MODEL_INTELLIGENCE_RELATIVE_PATH, generated_at: new Date(now).toISOString(), priors };
}

function parseHome(argv) {
  const index = argv.indexOf('--home');
  return index >= 0 && argv[index + 1] ? path.resolve(argv[index + 1]) : currentFmHome();
}

async function main() {
  const command = process.argv[2] || 'validate';
  const home = parseHome(process.argv.slice(3));
  const intelligence = loadModelIntelligence({ home });
  if (command === 'validate') {
    const nowMs = Date.now();
    const assertions = [];
    for (const [key, entry] of Object.entries(intelligence.models)) {
      for (const [dimension, assertion] of Object.entries(entry?.capabilities || {})) {
        const normalized = normalizeAssertion(assertion, nowMs);
        assertions.push({ model: key, dimension, usable: normalized.usable, class: normalized.usable ? normalized.class : 'UNKNOWN', problems: normalized.problems });
      }
    }
    const validation = loadRouteValidation({ home });
    process.stdout.write(`${JSON.stringify({
      model_intelligence: { path: intelligence.path, present: intelligence.present, models: Object.keys(intelligence.models).length, errors: intelligence.errors },
      route_validation: { path: validation.path, present: validation.present, routes: Object.keys(validation.routes).length, errors: validation.errors },
      assertions
    }, null, 2)}\n`);
    if (intelligence.errors.length || validation.errors.length) process.exitCode = 1;
    return;
  }
  if (command === 'derive-priors') {
    const { ROLE_TASK_CLASS } = await import('./fm-routing-capability.mjs');
    const routesPath = path.join(home, 'data/provider-catalogs/compiled-route-targets.json');
    const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
    process.stdout.write(`${JSON.stringify(derivePriorsFromModelIntelligence(intelligence, routes, { roleTaskClass: ROLE_TASK_CLASS }), null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown command "${command}"`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
