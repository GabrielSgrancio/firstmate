#!/usr/bin/env node
// Usage: fm-routing-eval.mjs <status|smoke|cheap-eval|challenger|real-traffic|live> [options]
//
// Runs the local model-evaluation lifecycle.  The evaluator owns lifecycle
// evidence and audit-only promotion writes; Router V2 remains the live routing
// authority and does not read lifecycle stages or real_n as eligibility.
//
// real-traffic records one production outcome.  --attribution <PROVIDER|HARNESS|
// TOOLING|CONTEXT|QUOTA|INFRASTRUCTURE|POLICY|EVALUATOR|TASK_SPEC|PROMPT|
// MODEL_BEHAVIOR|AMBIGUOUS> defaults to AMBIGUOUS; only MODEL_BEHAVIOR with
// --attribution-evidence <kind[,kind]> (see MODEL_BEHAVIOR_EVIDENCE in
// bin/fm-model-intelligence.mjs) changes capability evidence.  HARNESS with
// --capability <name> marks that route capability WARNING in route validation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateDataGate } from './fm-router-v2.mjs';
import {
  TASK_CLASSES as ROUTING_TASK_CLASSES,
  STAGES as ROUTING_STAGES,
  explorationPolicy as sharedExplorationPolicy,
  promotionCriteria as sharedPromotionCriteria,
  roleForTaskClass,
  stageForStatus,
  stageIndex,
  routeModelName,
  normalizeLearnedRouting,
  ensureCapabilityRecord,
  updateCapabilityPosterior,
  rebuildModelFamilyPriors
} from './fm-routing-capability.mjs';
import {
  ROUTE_VALIDATION_RELATIVE_PATH,
  CAPABILITY_ANOMALIES_RELATIVE_PATH,
  capabilityMutationAllowed,
  detectCapabilityAnomaly,
  loadModelIntelligence,
  resolveTaskFit
} from './fm-model-intelligence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FM_HOME = path.resolve(process.env.FM_HOME || ROOT);
const homePath = (relative) => path.join(FM_HOME, relative);
const LEARNED_PATH = homePath('data/learned-routing.json');
const ROUTES_PATH = homePath('data/provider-catalogs/compiled-route-targets.json');
const EVIDENCE_PATH = homePath('data/routing-evaluations.jsonl');
const BENCHMARK_PATH = homePath('data/routing-benchmark.json');
const REGISTRY_PATH = homePath('config/model-registry.json');
const POLICY_PATH = homePath('config/routing-policy.json');
const ROUTE_VALIDATION_PATH = homePath(ROUTE_VALIDATION_RELATIVE_PATH);
const ANOMALIES_PATH = homePath(CAPABILITY_ANOMALIES_RELATIVE_PATH);

export const TASK_CLASSES = ROUTING_TASK_CLASSES;
export const STAGES = ROUTING_STAGES;

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

const LEARNED_LOCK_WAIT_MS = 30000;
const LEARNED_LOCK_STALE_MS = 120000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockHolderAlive(lockPath) {
  try {
    const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Every learned-state mutation is load-modify-write of one JSON document, so
// concurrent evaluator processes serialize on an exclusive lock file; the atomic
// rename alone only prevents torn files, not lost updates.
export function withLearnedStateLock(fn, lockPath = `${LEARNED_PATH}.lock`) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LEARNED_LOCK_WAIT_MS;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let ageMs;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (ageMs > LEARNED_LOCK_STALE_MS && !lockHolderAlive(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`learned routing state is locked by another writer: ${lockPath}`);
      sleepSync(5 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function candidateKey(route) {
  return routeModelName(route);
}

function routeMatches(route, selector) {
  return route.route_id === selector ||
    candidateKey(route) === selector ||
    route.resolved_runtime_model === selector ||
    route.resolved_runtime_model === `opencode-go/${selector}` ||
    route.model_family === selector;
}

function findRoute(routes, selector) {
  const matches = routes.filter((route) => routeMatches(route, selector));
  if (matches.length === 0) throw new Error(`No compiled route target matches candidate "${selector}"`);
  if (matches.length > 1) {
    throw new Error(`Route selector "${selector}" matches multiple RouteTargets; use an explicit route_id`);
  }
  return matches[0];
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
  return sharedPromotionCriteria(policy);
}

function lowRiskReason(options = {}) {
  return sharedExplorationPolicy({
    ...options,
    stage: options.stage || 'CHALLENGER',
    routeProfile: options.routeProfile || options.route?.data_profile || null,
    resolvedRuntimeModel: options.resolvedRuntimeModel || options.route?.resolved_runtime_model || null,
    evaluateDataGate
  });
}

export function explorationPolicy(options = {}) {
  return lowRiskReason(options);
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
  const rawLearned = fs.existsSync(LEARNED_PATH) ? readJson(LEARNED_PATH, 'learned routing') : null;
  const learned = normalizeLearnedRouting(rawLearned, routes);
  const benchmark = fs.existsSync(BENCHMARK_PATH) ? readJson(BENCHMARK_PATH, 'routing benchmark') : null;
  const policy = fs.existsSync(POLICY_PATH) ? readJson(POLICY_PATH, 'routing policy') : {};
  return { routes, learned, benchmark, policy };
}

export function isExplorationAssignment({ stage, realN = 0, random = Math.random(), ...risk } = {}) {
  const policy = explorationPolicy({ stage, realN, ...risk });
  return { ...policy, assigned: policy.eligible && random < policy.rate };
}

function routeWithCapability(route, capability) {
  return {
    ...route,
    routing_status: capability.routing_status,
    capability_status: capability.routing_status,
    task_class: capability.task_class
  };
}

function persistTransition(state, route, taskClass, role, nextStage, details) {
  const capability = ensureCapabilityRecord(state.learned, route, taskClass, role);
  const currentStage = stageForStatus(capability.routing_status);
  if (stageIndex(nextStage) < stageIndex(currentStage)) {
    throw new Error(`Lifecycle cannot move backwards from ${currentStage} to ${nextStage}`);
  }
  if (stageIndex(nextStage) > stageIndex(currentStage) + 1) {
    throw new Error(`Lifecycle transition must advance one stage at a time (${currentStage} -> ${nextStage})`);
  }
  capability.routing_status = nextStage;
  writeJsonAtomic(LEARNED_PATH, state.learned);
  return routeWithCapability(route, capability);
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
  return withLearnedStateLock(() => smokeCandidateUnlocked(options));
}

function smokeCandidateUnlocked(options) {
  const state = loadState();
  const route = findRoute(state.routes, options.model || options.routeId);
  const { role, taskClass } = resolveRoleAndClass(route, options);
  const capability = ensureCapabilityRecord(state.learned, route, taskClass, role);
  const signals = normalizeSignals(options);
  if (stageForStatus(capability.routing_status) !== 'DISCOVERED') {
    throw new Error(`SMOKE requires DISCOVERED, got ${stageForStatus(capability.routing_status)}`);
  }
  const passed = options.passed !== undefined ? options.passed === true : signals.task_completed === true;
  let current = routeWithCapability(route, capability);
  if (passed && stageForStatus(capability.routing_status) === 'DISCOVERED') {
    current = persistTransition(state, route, taskClass, role, 'SMOKE', {});
  }
  const event = recordEvidence(state, current, { stage: 'SMOKE', role, taskClass, signals, outcome: passed ? 'pass' : 'fail' });
  return { route: current, event };
}

export function cheapEvaluateCandidate(options = {}) {
  return withLearnedStateLock(() => cheapEvaluateCandidateUnlocked(options));
}

function cheapEvaluateCandidateUnlocked(options) {
  const state = loadState();
  const route = findRoute(state.routes, options.model || options.routeId);
  const { role, taskClass } = resolveRoleAndClass(route, options);
  const capability = ensureCapabilityRecord(state.learned, route, taskClass, role);
  if (stageForStatus(capability.routing_status) !== 'SMOKE') {
    throw new Error(`CHEAP_EVAL requires SMOKE, got ${stageForStatus(capability.routing_status)}`);
  }
  const signals = normalizeSignals(options);
  const evidence = deterministicEvidence(taskClass, signals);
  if (!evidence.passed) {
    const event = recordEvidence(state, route, { stage: 'CHEAP_EVAL', role, taskClass, signals, outcome: 'refused', details: { refusal: evidence } });
    return { route, event, promoted: false, refusal: evidence };
  }
  const current = stageForStatus(capability.routing_status) === 'SMOKE'
    ? persistTransition(state, route, taskClass, role, 'CHEAP_EVAL', {})
    : routeWithCapability(route, capability);
  const event = recordEvidence(state, current, { stage: 'CHEAP_EVAL', role, taskClass, signals, outcome: 'pass' });
  return { route: current, event, promoted: true };
}

export function enterChallenger(options = {}) {
  return withLearnedStateLock(() => enterChallengerUnlocked(options));
}

function enterChallengerUnlocked(options) {
  const state = loadState();
  const route = findRoute(state.routes, options.model || options.routeId);
  const { role, taskClass } = resolveRoleAndClass(route, options);
  const capability = ensureCapabilityRecord(state.learned, route, taskClass, role);
  if (stageForStatus(capability.routing_status) !== 'CHEAP_EVAL') {
    throw new Error(`CHALLENGER requires CHEAP_EVAL, got ${stageForStatus(capability.routing_status)}`);
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
  const current = persistTransition(state, route, taskClass, role, 'CHALLENGER', {});
  const event = recordEvidence(state, current, { stage: 'CHALLENGER', role, taskClass, signals: {}, outcome: 'entered' });
  return { route: current, event, policy };
}

// Production outcomes are telemetry first.  Every outcome is recorded with a
// failure attribution (AMBIGUOUS when none is given), and only MODEL_BEHAVIOR
// backed by attributable evidence may change the route's capability record.
// HARNESS outcomes naming a route capability mark that capability WARNING in
// route validation; other attributions feed operational stores, not capability.
// Lifecycle stages and the promotion gate are recorded for audit only; Router V3
// candidate generation ignores both.
export function recordRealTraffic(options = {}) {
  return withLearnedStateLock(() => recordRealTrafficUnlocked(options));
}

function attributionEvidenceList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function markRouteValidationWarning(route, capability, details) {
  return withLearnedStateLock(() => {
    const validation = fs.existsSync(ROUTE_VALIDATION_PATH)
      ? readJson(ROUTE_VALIDATION_PATH, 'route validation')
      : { schema_version: 1, routes: {} };
    validation.routes = validation.routes || {};
    const record = validation.routes[route.route_id] || { capabilities: {} };
    record.capabilities = record.capabilities || {};
    const current = record.capabilities[capability]?.status || 'UNKNOWN';
    // Production evidence can raise a warning, never a FAILED verdict; FAILED is a
    // hard incompatibility that needs controlled validation.
    if (current === 'FAILED') return current;
    record.capabilities[capability] = {
      ...(record.capabilities[capability] || {}),
      status: 'WARNING',
      previous_status: current,
      method: 'production_harness_attribution',
      recorded_at: new Date().toISOString(),
      evidence: details
    };
    validation.routes[route.route_id] = record;
    writeJsonAtomic(ROUTE_VALIDATION_PATH, validation);
    return 'WARNING';
  }, `${ROUTE_VALIDATION_PATH}.lock`);
}

function recordCapabilityAnomaly(route, taskClass) {
  const intelligence = loadModelIntelligence({ home: FM_HOME });
  if (!intelligence.present) return null;
  const taskFit = resolveTaskFit(intelligence, route, taskClass);
  const outcomes = fs.existsSync(EVIDENCE_PATH)
    ? fs.readFileSync(EVIDENCE_PATH, 'utf8').split('\n').flatMap((line) => {
      try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
    }).filter((event) => event.stage === 'PRODUCTION_OUTCOME')
    : [];
  const anomaly = detectCapabilityAnomaly({ outcomes, route, taskClass, taskFit });
  if (!anomaly) return null;
  const existing = fs.existsSync(ANOMALIES_PATH)
    ? fs.readFileSync(ANOMALIES_PATH, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean)
    : [];
  const key = anomaly.failure_evaluation_ids.join(',');
  if (existing.some((entry) => entry.route_id === anomaly.route_id && entry.task_class === taskClass &&
      entry.failure_evaluation_ids?.join(',') === key)) return null;
  appendJsonLine(ANOMALIES_PATH, anomaly);
  return anomaly;
}

function recordRealTrafficUnlocked(options) {
  const state = loadState();
  const route = findRoute(state.routes, options.model || options.routeId);
  const { role, taskClass } = resolveRoleAndClass(route, options);
  const signals = normalizeSignals(options);
  const criteria = promotionCriteria(state.policy);
  const definition = TASK_CLASSES[taskClass];
  const evidence = deterministicEvidence(taskClass, signals);
  const hasDeterministicContract = definition.deterministic.length > 0;
  const success = hasDeterministicContract
    ? evidence.method === 'deterministic' && evidence.passed
    : options.success === true || signals.task_completed === true;
  const attribution = capabilityMutationAllowed({
    attribution: options.attribution,
    evidence: attributionEvidenceList(options.attribution_evidence ?? options.attributionEvidence)
  });
  const capability = ensureCapabilityRecord(state.learned, route, taskClass, role);
  let finalRoute = routeWithCapability(route, capability);
  let promoted = false;
  let promotionGate = null;
  let routeValidationEffect = null;
  if (attribution.allowed) {
    const stats = capability;
    stats.real_n += 1;
    if (success) stats.real_successes += 1;
    if (hasDeterministicContract) {
      if (evidence.method === 'deterministic') stats.deterministic_evaluations += 1;
      if (evidence.method !== 'deterministic' || !evidence.passed) stats.deterministic_failures += 1;
    }
    updateCapabilityPosterior(stats, criteria);
    writeJsonAtomic(LEARNED_PATH, state.learned);
    if (stageForStatus(capability.routing_status) === 'CHALLENGER') {
      finalRoute = persistTransition(state, route, taskClass, role, 'LOW_RISK_REAL_TRAFFIC', {});
    }
    const successRate = stats.real_n === 0 ? 0 : stats.real_successes / stats.real_n;
    const deterministicEvidencePassed = !hasDeterministicContract || (
      stats.deterministic_evaluations === stats.real_n && stats.deterministic_failures === 0
    );
    promotionGate = {
      affects_routing: false,
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
    if (promotionGate.passed && stageForStatus(capability.routing_status) === 'LOW_RISK_REAL_TRAFFIC') {
      finalRoute = persistTransition(state, route, taskClass, role, 'ROUTING_ELIGIBLE', {});
      promoteRegistryVisibility(finalRoute, role);
      promoted = true;
    }
    rebuildModelFamilyPriors(state.learned, state.routes);
    writeJsonAtomic(LEARNED_PATH, state.learned);
  } else if (attribution.attribution === 'HARNESS' && typeof options.capability === 'string' && options.capability) {
    routeValidationEffect = { capability: options.capability, status: markRouteValidationWarning(route, options.capability, options.note || null) };
  }
  const event = recordEvidence(state, finalRoute, {
    stage: 'PRODUCTION_OUTCOME', role, taskClass, signals,
    outcome: success ? 'pass' : 'fail',
    details: {
      attribution: attribution.attribution,
      attribution_effect: attribution.effect,
      attribution_reason: attribution.reason,
      capability_mutated: attribution.allowed,
      route_validation_effect: routeValidationEffect,
      real_n: capability.real_n,
      real_successes: capability.real_successes,
      promoted,
      promotion_gate: promotionGate,
      deterministic_evidence: evidence
    }
  });
  const anomaly = recordCapabilityAnomaly(route, taskClass);
  return {
    route: finalRoute,
    event,
    stats: capability,
    attribution,
    capabilityMutated: attribution.allowed,
    routeValidationEffect,
    anomaly,
    promoted,
    promotionGate
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
    const capabilities = state.learned.route_capabilities?.[route.route_id]?.capabilities || {};
    return {
      route_id: route.route_id,
      model,
      routing_status: route.routing_status,
      capabilities: Object.fromEntries(Object.entries(capabilities).map(([taskClass, stats]) => [taskClass, stats]))
    };
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
