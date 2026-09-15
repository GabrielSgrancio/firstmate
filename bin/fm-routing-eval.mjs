#!/usr/bin/env node
// Usage: fm-routing-eval.mjs <status|smoke|cheap-eval|challenger|real-traffic|live> [options]
//
// Runs the local model-evaluation lifecycle.  The evaluator owns lifecycle
// evidence and promotion writes; Router V2 remains the live routing authority.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateDataGate } from './fm-router-v2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FM_HOME = path.resolve(process.env.FM_HOME || ROOT);
const homePath = (relative) => path.join(FM_HOME, relative);
const LEARNED_PATH = homePath('data/learned-routing.json');
const ROUTES_PATH = homePath('data/provider-catalogs/compiled-route-targets.json');
const EVIDENCE_PATH = homePath('data/routing-evaluations.jsonl');
const BENCHMARK_PATH = homePath('data/routing-benchmark.json');
const REGISTRY_PATH = homePath('config/model-registry.json');
const POLICY_PATH = homePath('config/routing-policy.json');

export const STAGES = Object.freeze([
  'DISCOVERED',
  'SMOKE',
  'CHEAP_EVAL',
  'CHALLENGER',
  'LOW_RISK_REAL_TRAFFIC',
  'ROUTING_ELIGIBLE'
]);

const STATUS_TO_STAGE = Object.freeze({ BENCHMARK_ONLY: 'DISCOVERED' });
const PROMOTION_REAL_N = 15;
const DEFAULT_PROMOTION_SUCCESS_RATE = 0.8;
const BOOTSTRAP_EXPLORATION_RATE = 0.18;
const STEADY_EXPLORATION_RATE = 0.05;
const EXPLORATION_DATA_CLASSES = new Set(['PUBLIC', 'SANITIZED', 'PRIVATE_CODE']);

export const TASK_CLASSES = Object.freeze({
  targeted_edit: { role: 'fast_precise', deterministic: ['tests_pass', 'task_completed'] },
  mechanical_tool_work: { role: 'cheap_tool_worker', deterministic: ['task_completed', 'tool_failures'] },
  test_generation: { role: 'strong_cheap_worker', deterministic: ['tests_pass', 'regression_tests_added', 'task_completed'] },
  refactor: { role: 'general_engineer', deterministic: ['tests_pass', 'task_completed'] },
  multi_file_feature: { role: 'autonomous_engineer', deterministic: ['tests_pass', 'build_pass', 'task_completed'] },
  brownfield_debugging: { role: 'deep_engineer', deterministic: ['bug_reproduced', 'regression_tests_added', 'tests_pass', 'task_completed'] },
  large_context_repository_retrieval: { role: 'deep_context', deterministic: ['task_completed'] },
  long_horizon_autonomous_engineering: { role: 'autonomous_engineer', deterministic: ['tests_pass', 'build_pass', 'task_completed'] },
  architecture_reasoning: { role: 'architect_synthesizer', deterministic: [], fallback: 'llm_judge' },
  critical_audit: { role: 'critical_auditor', deterministic: ['task_completed', 'regression_tests_added'] }
});

export const SIGNALS = Object.freeze([
  'tests_pass',
  'build_pass',
  'lint_pass',
  'typecheck_pass',
  'bug_reproduced',
  'regression_tests_added',
  'task_completed',
  'retries',
  'tool_failures',
  'human_intervention',
  'manual_edits_after_completion',
  'later_revert_or_regression',
  'wall_clock_ms',
  'tokens_consumed',
  'quota_burn',
  'context_avoided_or_shunted'
]);

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid at ${filePath}: ${error.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function candidateKey(route) {
  return route.model_family || route.raw_id || route.logical_alias || route.resolved_runtime_model;
}

function routeMatches(route, selector) {
  return route.route_id === selector ||
    candidateKey(route) === selector ||
    route.resolved_runtime_model === selector ||
    route.resolved_runtime_model === `opencode-go/${selector}` ||
    route.model_family === selector;
}

function stageForStatus(status) {
  return STATUS_TO_STAGE[status] || status;
}

function stageIndex(stage) {
  const index = STAGES.indexOf(stage);
  if (index < 0) throw new Error(`Unknown lifecycle stage: ${stage}`);
  return index;
}

function findRoute(routes, selector) {
  const matches = routes.filter((route) => routeMatches(route, selector));
  if (matches.length === 0) throw new Error(`No compiled route target matches candidate "${selector}"`);
  if (matches.length > 1) {
    throw new Error(`Route selector "${selector}" matches multiple RouteTargets; use an explicit route_id`);
  }
  return matches[0];
}

function roleForTaskClass(taskClass) {
  const definition = TASK_CLASSES[taskClass];
  if (!definition) throw new Error(`Unknown task class "${taskClass}"`);
  return definition.role;
}

function normalizeSignals(input = {}) {
  const source = input.signals && typeof input.signals === 'object' ? input.signals : input;
  const signals = {};
  for (const name of SIGNALS) {
    if (source[name] !== undefined) signals[name] = source[name];
  }
  return signals;
}

function deterministicEvidence(taskClass, signals) {
  const definition = TASK_CLASSES[taskClass];
  if (!definition) throw new Error(`Unknown task class "${taskClass}"`);
  const required = definition.deterministic;
  const available = required.filter((name) => signals[name] !== undefined);
  const failed = available.filter((name) => {
    if (name === 'tool_failures' || name === 'retries' || name === 'human_intervention' ||
        name === 'manual_edits_after_completion' || name === 'later_revert_or_regression') {
      return Number(signals[name]) > 0;
    }
    return signals[name] !== true;
  });
  const missing = required.filter((name) => signals[name] === undefined);
  const deterministic = available.length > 0;
  const passed = deterministic && failed.length === 0 && missing.length === 0;
  return {
    method: deterministic ? 'deterministic' : (definition.fallback || 'insufficient_evidence'),
    passed,
    required,
    available,
    failed,
    missing,
    weaker_than_deterministic: !deterministic
  };
}

function promotionCriteria(policy = {}) {
  const configured = policy.champion_challenger_strategy?.promotion_criteria || {};
  const minRealN = Number.isInteger(configured.min_real_n) && configured.min_real_n > 0
    ? configured.min_real_n : PROMOTION_REAL_N;
  const minSuccessRate = Number.isFinite(configured.min_real_success_rate) &&
    configured.min_real_success_rate > 0 && configured.min_real_success_rate <= 1
    ? configured.min_real_success_rate : DEFAULT_PROMOTION_SUCCESS_RATE;
  const minSuccessfulOutcomes = Number.isInteger(configured.min_successes) && configured.min_successes > 0
    ? configured.min_successes : Math.ceil(minRealN * minSuccessRate);
  return {
    minRealN,
    minSuccessRate,
    minSuccessfulOutcomes,
    configuredSuccessRateDelta: configured.min_real_success_rate_delta ?? null,
    configuredCostReductionDelta: configured.cost_reduction_delta ?? null
  };
}

function ensureStats(learned, role, route, criteria) {
  learned.version = learned.version || 3;
  learned.role_statistics = learned.role_statistics || {};
  learned.role_statistics[role] = learned.role_statistics[role] || {};
  const routeTargetId = route.route_id;
  const current = learned.role_statistics[role][routeTargetId] || {};
  const priorMean = Number.isFinite(current.prior_mean) ? current.prior_mean :
    (Number.isFinite(current.posterior_mean) ? current.posterior_mean : 0.5);
  const priorEffectiveN = Number.isFinite(current.prior_effective_n) ? current.prior_effective_n : 0;
  const realN = Number.isFinite(current.real_n) ? current.real_n : 0;
  const realSuccesses = Number.isFinite(current.real_successes) ? current.real_successes : 0;
  learned.role_statistics[role][routeTargetId] = {
    ...current,
    route_id: routeTargetId,
    model: candidateKey(route),
    harness: route.harness,
    provider: route.provider || route.provider_path || null,
    real_n: realN,
    real_successes: realSuccesses,
    deterministic_evaluations: Number.isFinite(current.deterministic_evaluations) ? current.deterministic_evaluations : 0,
    deterministic_failures: Number.isFinite(current.deterministic_failures) ? current.deterministic_failures : 0,
    prior_mean: priorMean,
    prior_effective_n: priorEffectiveN,
    posterior_mean: (priorMean * priorEffectiveN + realSuccesses) / (priorEffectiveN + realN || 1),
    promotion_eligible_real_n: realN >= criteria.minRealN
  };
  return learned.role_statistics[role][routeTargetId];
}

function updatePosterior(stats, criteria) {
  stats.posterior_mean = (stats.prior_mean * stats.prior_effective_n + stats.real_successes) /
    (stats.prior_effective_n + stats.real_n || 1);
  stats.promotion_eligible_real_n = stats.real_n >= criteria.minRealN;
}

function updateRoutes(routes, route, nextStage) {
  const updated = routes.map((candidate) => {
    if (candidate.route_id !== route.route_id) return candidate;
    return { ...candidate, routing_status: nextStage };
  });
  return updated;
}

function promoteRegistryVisibility(route, role) {
  if (!fs.existsSync(REGISTRY_PATH)) return false;
  const registry = readJson(REGISTRY_PATH, 'model registry');
  registry.models = registry.models || {};
  const model = candidateKey(route);
  if (!registry.models[model]) {
    registry.models[model] = {
      harness: route.harness,
      data_profile: route.data_profile,
      discovered_by: route.discovery_source || 'routing-evaluation'
    };
  }
  registry.roles = registry.roles || {};
  if (registry.roles[role]) {
    registry.roles[role].challengers = registry.roles[role].challengers || [];
    if (registry.roles[role].primary_champion !== model && !registry.roles[role].challengers.includes(model)) {
      registry.roles[role].challengers.push(model);
    }
  }
  writeJsonAtomic(REGISTRY_PATH, registry);
  return true;
}

function loadState() {
  const routes = readJson(ROUTES_PATH, 'compiled route targets');
  if (!Array.isArray(routes)) throw new Error('compiled route targets must be an array');
  const learned = fs.existsSync(LEARNED_PATH) ? readJson(LEARNED_PATH, 'learned routing') : { version: 3, role_statistics: {} };
  const benchmark = fs.existsSync(BENCHMARK_PATH) ? readJson(BENCHMARK_PATH, 'routing benchmark') : null;
  const policy = fs.existsSync(POLICY_PATH) ? readJson(POLICY_PATH, 'routing policy') : {};
  return { routes, learned, benchmark, policy };
}

function lowRiskReason({
  dataClass = 'PUBLIC',
  critical = false,
  retryTolerant = false,
  route = null,
  routeProfile = null,
  resolvedRuntimeModel = null
} = {}) {
  const reasons = [];
  if (!EXPLORATION_DATA_CLASSES.has(dataClass)) {
    reasons.push(`data class ${dataClass} is not eligible for automatic exploration`);
  }
  if (critical) reasons.push('task is marked critical');
  if (!retryTolerant) reasons.push('task is not retry-tolerant');
  const profile = routeProfile || route?.data_profile;
  const model = resolvedRuntimeModel || route?.resolved_runtime_model;
  if (!profile) {
    reasons.push('no concrete route policy profile was supplied');
  } else {
    try {
      const gate = evaluateDataGate(dataClass, profile, { resolvedRuntimeModel: model });
      if (!gate.allowed) reasons.push(`data policy gate refused the route: ${gate.reason}`);
    } catch (error) {
      reasons.push(`data policy gate could not classify the route: ${error.message}`);
    }
  }
  return { lowRisk: reasons.length === 0, reasons };
}

export function explorationPolicy(options = {}) {
  const { stage, realN = 0 } = options;
  const risk = lowRiskReason(options);
  if (!risk.lowRisk) return { rate: 0, eligible: false, phase: 'blocked', ...risk };
  if (['CHALLENGER', 'LOW_RISK_REAL_TRAFFIC'].includes(stage) && realN < PROMOTION_REAL_N) {
    return { rate: BOOTSTRAP_EXPLORATION_RATE, eligible: true, phase: 'bootstrap', ...risk };
  }
  if (stage === 'ROUTING_ELIGIBLE' || realN >= PROMOTION_REAL_N) {
    return { rate: STEADY_EXPLORATION_RATE, eligible: true, phase: 'steady', ...risk };
  }
  return { rate: 0, eligible: false, phase: 'not-challenger', ...risk };
}

export function isExplorationAssignment({ stage, realN = 0, random = Math.random(), ...risk } = {}) {
  const policy = explorationPolicy({ stage, realN, ...risk });
  return { ...policy, assigned: policy.eligible && random < policy.rate };
}

function persistTransition(state, route, nextStage, details) {
  const currentStage = stageForStatus(route.routing_status);
  if (stageIndex(nextStage) < stageIndex(currentStage)) {
    throw new Error(`Lifecycle cannot move backwards from ${currentStage} to ${nextStage}`);
  }
  if (stageIndex(nextStage) > stageIndex(currentStage) + 1) {
    throw new Error(`Lifecycle transition must advance one stage at a time (${currentStage} -> ${nextStage})`);
  }
  const routes = updateRoutes(state.routes, route, nextStage);
  writeJsonAtomic(ROUTES_PATH, routes);
  state.routes = routes;
  return routes.find((candidate) => candidate.route_id === route.route_id) || route;
}

function recordEvidence(state, route, { stage, role, taskClass, signals = {}, outcome, details = {} }) {
  const evidence = deterministicEvidence(taskClass, signals);
  const event = {
    schema_version: 1,
    evaluation_id: `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    recorded_at: new Date().toISOString(),
    stage,
    route_id: route.route_id,
    route_target_id: route.route_id,
    model: candidateKey(route),
    harness: route.harness,
    provider: route.provider || route.provider_path || null,
    role,
    task_class: taskClass,
    signals,
    outcome,
    evidence,
    benchmark_seed_present: Boolean(state.benchmark),
    ...details
  };
  appendJsonLine(EVIDENCE_PATH, event);
  return event;
}

function resolveRoleAndClass(route, options) {
  const taskClass = options.taskClass || 'targeted_edit';
  const role = options.role || roleForTaskClass(taskClass);
  if (!TASK_CLASSES[taskClass]) throw new Error(`Unknown task class "${taskClass}"`);
  return { role, taskClass };
}

export function smokeCandidate(options = {}) {
  const state = loadState();
  const route = findRoute(state.routes, options.model || options.routeId);
  const { role, taskClass } = resolveRoleAndClass(route, options);
  const signals = normalizeSignals(options);
  if (stageForStatus(route.routing_status) !== 'DISCOVERED') {
    throw new Error(`SMOKE requires DISCOVERED, got ${stageForStatus(route.routing_status)}`);
  }
  const passed = options.passed !== undefined ? options.passed === true : signals.task_completed === true;
  let current = route;
  if (passed && stageForStatus(route.routing_status) === 'DISCOVERED') current = persistTransition(state, route, 'SMOKE', {});
  const event = recordEvidence(state, current, { stage: 'SMOKE', role, taskClass, signals, outcome: passed ? 'pass' : 'fail' });
  return { route: current, event };
}

export function cheapEvaluateCandidate(options = {}) {
  const state = loadState();
  const route = findRoute(state.routes, options.model || options.routeId);
  const { role, taskClass } = resolveRoleAndClass(route, options);
  if (stageForStatus(route.routing_status) !== 'SMOKE') {
    throw new Error(`CHEAP_EVAL requires SMOKE, got ${stageForStatus(route.routing_status)}`);
  }
  const signals = normalizeSignals(options);
  const evidence = deterministicEvidence(taskClass, signals);
  if (!evidence.passed) {
    const event = recordEvidence(state, route, { stage: 'CHEAP_EVAL', role, taskClass, signals, outcome: 'refused', details: { refusal: evidence } });
    return { route, event, promoted: false, refusal: evidence };
  }
  const current = stageForStatus(route.routing_status) === 'SMOKE' ? persistTransition(state, route, 'CHEAP_EVAL', {}) : route;
  const event = recordEvidence(state, current, { stage: 'CHEAP_EVAL', role, taskClass, signals, outcome: 'pass' });
  return { route: current, event, promoted: true };
}

export function enterChallenger(options = {}) {
  const state = loadState();
  const route = findRoute(state.routes, options.model || options.routeId);
  const { role, taskClass } = resolveRoleAndClass(route, options);
  if (stageForStatus(route.routing_status) !== 'CHEAP_EVAL') {
    throw new Error(`CHALLENGER requires CHEAP_EVAL, got ${stageForStatus(route.routing_status)}`);
  }
  const policy = explorationPolicy({ stage: 'CHALLENGER', route, ...options });
  if (!policy.eligible) {
    const event = recordEvidence(state, route, {
      stage: 'CHALLENGER',
      role,
      taskClass,
      signals: {},
      outcome: 'refused',
      details: { refusal: policy }
    });
    return { route, event, policy, promoted: false };
  }
  const current = persistTransition(state, route, 'CHALLENGER', {});
  const event = recordEvidence(state, current, { stage: 'CHALLENGER', role, taskClass, signals: {}, outcome: 'entered' });
  return { route: current, event, policy };
}

export function recordRealTraffic(options = {}) {
  const state = loadState();
  const route = findRoute(state.routes, options.model || options.routeId);
  const { role, taskClass } = resolveRoleAndClass(route, options);
  const signals = normalizeSignals(options);
  const risk = lowRiskReason({ ...options, route });
  if (!risk.lowRisk) {
    const event = recordEvidence(state, route, { stage: 'LOW_RISK_REAL_TRAFFIC', role, taskClass, signals, outcome: 'refused', details: { refusal: risk } });
    return { route, event, promoted: false, refusal: risk };
  }
  if (!['CHALLENGER', 'LOW_RISK_REAL_TRAFFIC'].includes(stageForStatus(route.routing_status))) {
    throw new Error(`Real traffic requires CHALLENGER, got ${stageForStatus(route.routing_status)}`);
  }
  const criteria = promotionCriteria(state.policy);
  const definition = TASK_CLASSES[taskClass];
  const evidence = deterministicEvidence(taskClass, signals);
  const hasDeterministicContract = definition.deterministic.length > 0;
  const success = hasDeterministicContract
    ? evidence.method === 'deterministic' && evidence.passed
    : options.success === true || signals.task_completed === true;
  const stats = ensureStats(state.learned, role, route, criteria);
  stats.real_n += 1;
  if (success) stats.real_successes += 1;
  if (hasDeterministicContract) {
    if (evidence.method === 'deterministic') stats.deterministic_evaluations += 1;
    if (evidence.method !== 'deterministic' || !evidence.passed) stats.deterministic_failures += 1;
  }
  updatePosterior(stats, criteria);
  writeJsonAtomic(LEARNED_PATH, state.learned);
  const current = stageForStatus(route.routing_status) === 'CHALLENGER' ?
    persistTransition(state, route, 'LOW_RISK_REAL_TRAFFIC', {}) : route;
  let promoted = false;
  let finalRoute = current;
  const successRate = stats.real_n === 0 ? 0 : stats.real_successes / stats.real_n;
  const deterministicEvidencePassed = !hasDeterministicContract || (
    stats.deterministic_evaluations === stats.real_n && stats.deterministic_failures === 0
  );
  const promotionGate = {
    required_real_n: criteria.minRealN,
    real_n: stats.real_n,
    minimum_successful_outcomes: criteria.minSuccessfulOutcomes,
    real_successes: stats.real_successes,
    success_rate: successRate,
    minimum_success_rate: criteria.minSuccessRate,
    deterministic_evidence_required: hasDeterministicContract,
    deterministic_evidence_passed: deterministicEvidencePassed,
    passed: stats.real_n >= criteria.minRealN &&
      stats.real_successes >= criteria.minSuccessfulOutcomes &&
      successRate >= criteria.minSuccessRate &&
      deterministicEvidencePassed
  };
  if (promotionGate.passed) {
    finalRoute = persistTransition(state, current, 'ROUTING_ELIGIBLE', {});
    promoteRegistryVisibility(finalRoute, role);
    promoted = true;
  }
  const event = recordEvidence(state, finalRoute, {
    stage: 'LOW_RISK_REAL_TRAFFIC', role, taskClass, signals,
    outcome: success ? 'pass' : 'fail',
    details: {
      real_n: stats.real_n,
      real_successes: stats.real_successes,
      promoted,
      promotion_gate: promotionGate,
      promotion_criteria: criteria,
      deterministic_evidence: evidence
    }
  });
  return {
    route: finalRoute,
    event,
    stats,
    promoted,
    promotionGate,
    policy: explorationPolicy({ stage: finalRoute.routing_status, realN: stats.real_n, route: finalRoute, ...options })
  };
}

function extractTextAndUsage(stdout) {
  const text = [];
  const usage = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.type === 'text' && item.part?.text) text.push(item.part.text);
      if (item.part?.text) text.push(item.part.text);
      for (const key of ['input', 'output', 'reasoning', 'cache_read', 'cache_write', 'total']) {
        if (Number.isFinite(item.usage?.[key])) usage[key] = (usage[key] || 0) + item.usage[key];
        if (Number.isFinite(item.part?.tokens?.[key])) usage[key] = (usage[key] || 0) + item.part.tokens[key];
      }
    } catch {
      // OpenCode can emit human-readable diagnostics even with --format json.
    }
  }
  return { text: [...new Set(text)].join('\n'), usage };
}

export function runLiveSmoke(options = {}) {
  const model = options.model || options.routeId;
  if (!model) throw new Error('--model or --route-id is required');
  const prompt = options.prompt || 'Reply with exactly EVAL_SMOKE_PASS and do not use tools.';
  const workdir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'firstmate-routing-eval-'));
  fs.mkdirSync(workdir, { recursive: true });
  const runtimeModel = model.includes('/') ? model : `opencode-go/${model}`;
  const started = Date.now();
  const result = spawnSync(options.opencode || 'opencode', [
    'run', '--pure', '--format', 'json', '--model', runtimeModel, '--dir', workdir, prompt
  ], { encoding: 'utf8', timeout: options.timeoutMs || 120000, env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' } });
  const elapsed = Date.now() - started;
  const parsed = extractTextAndUsage(result.stdout || '');
  const passed = result.status === 0 && parsed.text.includes('EVAL_SMOKE_PASS');
  return {
    model,
    runtime_model: runtimeModel,
    passed,
    exit_code: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    response_text: parsed.text,
    tokens_consumed: parsed.usage.total || (parsed.usage.input || 0) + (parsed.usage.output || 0),
    wall_clock_ms: elapsed
  };
}

export function runLiveCheapEval(options = {}) {
  const model = options.model || options.routeId;
  if (!model) throw new Error('--model or --route-id is required');
  const prompt = options.prompt || [
    'This is a disposable deterministic evaluation task.',
    'Use the terminal to create eval-marker.txt containing exactly EVAL_CHEAP_PASS.',
    'Verify it with a shell test before replying EVAL_CHEAP_DONE.',
    'Do not modify anything outside the current directory.'
  ].join(' ');
  const workdir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'firstmate-routing-cheap-'));
  fs.mkdirSync(workdir, { recursive: true });
  const runtimeModel = model.includes('/') ? model : `opencode-go/${model}`;
  const started = Date.now();
  const result = spawnSync(options.opencode || 'opencode', [
    'run', '--pure', '--format', 'json', '--auto', '--model', runtimeModel, '--dir', workdir, prompt
  ], { encoding: 'utf8', timeout: options.timeoutMs || 180000, env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' } });
  const elapsed = Date.now() - started;
  const parsed = extractTextAndUsage(result.stdout || '');
  let marker = '';
  try { marker = fs.readFileSync(path.join(workdir, 'eval-marker.txt'), 'utf8').trim(); } catch { /* task did not create the marker */ }
  const completed = result.status === 0 && marker === 'EVAL_CHEAP_PASS' && parsed.text.includes('EVAL_CHEAP_DONE');
  return {
    model,
    runtime_model: runtimeModel,
    workdir,
    completed,
    marker,
    exit_code: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    response_text: parsed.text,
    tokens_consumed: parsed.usage.total || (parsed.usage.input || 0) + (parsed.usage.output || 0),
    wall_clock_ms: elapsed,
    signals: {
      task_completed: completed,
      tool_failures: result.status === 0 && marker ? 0 : 1,
      wall_clock_ms: elapsed,
      tokens_consumed: parsed.usage.total || (parsed.usage.input || 0) + (parsed.usage.output || 0)
    }
  };
}

export function status(options = {}) {
  const state = loadState();
  const selected = options.model || options.routeId;
  const routes = selected ? [findRoute(state.routes, selected)] : state.routes;
  return routes.map((route) => {
    const model = candidateKey(route);
    const roleStats = Object.entries(state.learned.role_statistics || {})
      .map(([role, candidates]) => ({ role, stats: candidates[route.route_id] }))
      .filter((entry) => entry.stats);
    return { route_id: route.route_id, model, routing_status: route.routing_status, role_statistics: roleStats };
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const key = argument.slice(2).replaceAll('-', '_');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) options[key] = true;
    else { options[key] = value; index += 1; }
  }
  for (const name of ['passed', 'success', 'critical', 'retry_tolerant', 'tests_pass', 'build_pass', 'lint_pass', 'typecheck_pass', 'bug_reproduced', 'regression_tests_added', 'task_completed']) {
    if (options[name] === 'true') options[name] = true;
    if (options[name] === 'false') options[name] = false;
  }
  for (const name of ['retries', 'tool_failures', 'human_intervention', 'manual_edits_after_completion', 'later_revert_or_regression', 'wall_clock_ms', 'tokens_consumed', 'quota_burn']) {
    if (options[name] !== undefined) options[name] = Number(options[name]);
  }
  return options;
}

async function main() {
  const command = process.argv[2] || 'status';
  const options = parseArgs(process.argv.slice(3));
  const result = command === 'status' ? status(options) :
    command === 'smoke' ? smokeCandidate(options) :
    command === 'cheap-eval' ? cheapEvaluateCandidate(options) :
    command === 'challenger' ? enterChallenger(options) :
    command === 'real-traffic' ? recordRealTraffic(options) :
    command === 'live' ? runLiveSmoke(options) :
    command === 'live-cheap' ? runLiveCheapEval(options) : null;
  if (!result) throw new Error(`Unknown command "${command}"`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
