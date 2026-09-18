#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeQuotaAxiSnapshot } from './fm-quota-normalize.mjs';
import {
  TASK_CLASSES,
  taskClassForRole,
  explorationPolicy,
  EXPLORATION_DATA_CLASSES as EXPLORATION_ASSIGNMENT_DATA_CLASSES,
  getCapabilityRecord,
  normalizeLearnedRouting,
  promotionCriteria,
  familyPriorKey,
  capabilityCredibleInterval,
  isHighRiskTaskClass
} from './fm-routing-capability.mjs';
import {
  RESOURCE_POOLS,
  buildPoolEconomics,
  buildRouteEconomics,
  calculateObservedQuotaDelta,
  collectRoutingObservations,
  routeAllowanceState,
  selectEconomicRoute
} from './fm-routing-economics.mjs';
import {
  CLASS_QUALITY_PRIOR,
  loadModelIntelligence,
  loadRouteValidation,
  resolveTaskFit,
  routeValidationSummary,
  normalizeAttribution
} from './fm-model-intelligence.mjs';
import { createContextBroker } from './fm-context-broker.mjs';
import { attestRequestedVsActual, readOpencodeSessionAt } from './fm-model-attestation.mjs';
import {
  FAILURE_CLASSIFICATIONS,
  createTaskStateCapsule,
  formatContinuationPrompt,
  getTaskCapsulePath,
  loadTaskStateCapsule,
  recordContinuationDispatch,
  recordRouteFailureAndHandoff,
  saveTaskStateCapsule,
  selectContinuationRoute,
  updateTaskStateCapsule
} from './fm-task-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const currentFmHome = () => path.resolve(process.env.FM_HOME || ROOT);
const homePath = (relPath) => path.join(currentFmHome(), relPath);
const getExecutionsLogPath = () => homePath('data/routing-executions.jsonl');

const OPENCODE_QUOTA_SCRIPT_PATH = path.join(ROOT, 'bin', 'fm-opencode-quota.mjs');

function setPoolWindowsFresh(pool, fresh) {
  // Windows that are not live evidence must not ride along into quota snapshots,
  // where a before/after comparison would read them as real burn.
  if (fresh === false) pool.windows = {};
  Object.defineProperty(pool, '_windows_fresh', {
    configurable: true,
    enumerable: false,
    value: fresh,
    writable: true
  });
}

function poolWindowsFresh(pool) {
  return pool?._windows_fresh !== false;
}

function readOpenCodeGoQuota() {
  const scriptPath = process.env.FM_OPENCODE_QUOTA_SCRIPT || OPENCODE_QUOTA_SCRIPT_PATH;
  const output = execFileSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10000,
    env: { ...process.env, FM_HOME: currentFmHome() }
  });
  const quota = JSON.parse(output);
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) {
    throw new Error('OpenCode Go quota output must be an object');
  }
  return quota;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid at ${filePath}: ${error.message}`);
  }
}

function generatedStateFresh(filePath, value) {
  if (value?.fixture === 'synthetic-router-v2') return true;
  try {
    const ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
    return ageMs >= 0 && ageMs <= 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

const PRIVACY_METADATA_DEFAULT_MAX_AGE_DAYS = 30;
const ACTIVE_DATA_CLASSES = new Set(['PUBLIC', 'SANITIZED', 'PRIVATE_CODE', 'PERSONAL_SENSITIVE', 'SECRET']);

function normalizeTelemetryClassification(dataClass, classificationStatus = null) {
  if (dataClass === null || dataClass === undefined || dataClass === '' || dataClass === 'LEGACY_UNCLASSIFIED') {
    return {
      dataClass: null,
      classificationStatus: classificationStatus || 'UNCLASSIFIED_LEGACY'
    };
  }
  if (!ACTIVE_DATA_CLASSES.has(dataClass)) {
    throw new Error(`Unknown telemetry data class: ${dataClass}`);
  }
  return {
    dataClass,
    classificationStatus: classificationStatus || 'CLASSIFIED'
  };
}

// Route-owner privacy metadata is hand-verified documentation evidence, not generated telemetry,
// so it uses its own longer revalidation cadence instead of generatedStateFresh's 24h window.
// A provider-published valid_until always wins; otherwise the file's own revalidation_cadence_days
// (or the default above) bounds how long a retrieved_at timestamp may be trusted.
function isPrivacyMetadataStale(privacyMetadata, entry) {
  if (privacyMetadata?.fixture === 'synthetic-router-v2') return false;
  if (!entry) return true;
  if (entry.valid_until) {
    const validUntilMs = new Date(entry.valid_until).getTime();
    if (!Number.isNaN(validUntilMs)) return Date.now() > validUntilMs;
  }
  const retrievedAtMs = entry.retrieved_at ? new Date(entry.retrieved_at).getTime() : NaN;
  if (Number.isNaN(retrievedAtMs)) return true;
  const cadenceDays = privacyMetadata?.revalidation_cadence_days || PRIVACY_METADATA_DEFAULT_MAX_AGE_DAYS;
  return (Date.now() - retrievedAtMs) > cadenceDays * 24 * 60 * 60 * 1000;
}

function unknownQuotaMap(quotaMap, reason) {
  return {
    ...quotaMap,
    generated_state: { stale: true, reason },
    pools: Object.fromEntries(Object.keys(quotaMap.pools || {}).map((name) => [name, {
      ...(quotaMap.pools[name] || {}),
      scarcity_state: 'UNKNOWN',
      status: 'UNKNOWN'
    }]))
  };
}

const CATALOG_REFRESH_TIMEOUT_MS = 180000;

// Dispatch-time freshness for generated RouteTargets.  A missing or stale compiled
// catalog is regenerated once through the provider discovery owner; if that still
// leaves no fresh catalog, loadConfigs keeps failing closed with no routes.
export function ensureRouteCatalogFresh({ refresher = null } = {}) {
  const compiledRoutesPath = homePath('data/provider-catalogs/compiled-route-targets.json');
  if (fs.existsSync(compiledRoutesPath) && generatedStateFresh(compiledRoutesPath)) {
    return { fresh: true, refreshed: false };
  }
  try {
    if (refresher) {
      refresher({ home: currentFmHome() });
    } else {
      execFileSync(process.execPath, [path.join(ROOT, 'bin', 'fm-provider-discovery.mjs'), 'refresh'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: CATALOG_REFRESH_TIMEOUT_MS,
        env: { ...process.env, FM_HOME: currentFmHome() }
      });
    }
  } catch (error) {
    return { fresh: false, refreshed: false, error: String(error.stderr || error.message).slice(0, 500) };
  }
  const fresh = fs.existsSync(compiledRoutesPath) && generatedStateFresh(compiledRoutesPath);
  return { fresh, refreshed: fresh, ...(fresh ? {} : { error: 'provider discovery did not produce a fresh compiled catalog' }) };
}

export function loadConfigs() {
  const registryPath = homePath('config/model-registry.json');
  const policyPath = homePath('config/routing-policy.json');
  const priorsPath = homePath('config/routing-priors.json');
  const dataPolicyPath = homePath('config/data-policy.json');
  const privacyMetadataPath = homePath('config/provider-privacy-metadata.json');
  const quotaMapPath = homePath('data/quota-pool-map.json');
  const learnedRoutingPath = homePath('data/learned-routing.json');
  const compiledRoutesPath = homePath('data/provider-catalogs/compiled-route-targets.json');

  const registry = readJson(registryPath, 'model registry');
  const policy = readJson(policyPath, 'routing policy');
  const priors = readJson(priorsPath, 'routing priors');
  const dataPolicy = readJson(dataPolicyPath, 'data policy');
  const privacyMetadata = fs.existsSync(privacyMetadataPath)
    ? readJson(privacyMetadataPath, 'provider privacy metadata')
    : { models: {} };
  const quotaMapRaw = readJson(quotaMapPath, 'quota pool map');
  const quotaMap = generatedStateFresh(quotaMapPath, quotaMapRaw)
    ? quotaMapRaw
    : unknownQuotaMap(quotaMapRaw, 'quota pool map is stale');
  const compiledRoutes = fs.existsSync(compiledRoutesPath)
    ? (generatedStateFresh(compiledRoutesPath) ? readJson(compiledRoutesPath, 'compiled route targets') : [])
    : [];
  const learned = fs.existsSync(learnedRoutingPath)
    ? normalizeLearnedRouting(readJson(learnedRoutingPath, 'learned routing'), compiledRoutes)
    : normalizeLearnedRouting(null, compiledRoutes);
  // Model Intelligence and route validation live beside, never inside, provider
  // catalogs, so a discovery refresh cannot rewrite what is known about a route.
  const modelIntelligence = loadModelIntelligence({ home: currentFmHome() });
  const routeValidation = loadRouteValidation({ home: currentFmHome() });
  return { registry, policy, priors, dataPolicy, privacyMetadata, quotaMap, learned, compiledRoutes, modelIntelligence, routeValidation };
}

export function validateConfigs() {
  const { registry, policy, priors, dataPolicy } = loadConfigs();
  const canonicalRoles = new Set(registry.canonical_roles);

  // 1. Validate roles in model-registry
  for (const role of Object.keys(registry.roles)) {
    if (!canonicalRoles.has(role)) {
      throw new Error(`Unknown role in model-registry: "${role}"`);
    }
    const roleDef = registry.roles[role];
    if (!registry.models[roleDef.primary_champion]) {
      throw new Error(`Role "${role}" primary_champion "${roleDef.primary_champion}" not found in models`);
    }
    for (const ch of roleDef.challengers || []) {
      if (!registry.models[ch]) {
        throw new Error(`Role "${role}" challenger "${ch}" not found in models`);
      }
    }
  }

  // 2. Validate routing-policy canonical_roles
  for (const role of policy.canonical_roles) {
    if (!canonicalRoles.has(role)) {
      throw new Error(`Unknown canonical role in routing-policy: "${role}"`);
    }
  }

  // 3. Validate routing-priors recommended_roles
  for (const modelId of Object.keys(priors.priors)) {
    const prior = priors.priors[modelId];
    for (const role of prior.recommended_roles || []) {
      if (!canonicalRoles.has(role)) {
        throw new Error(`Prior "${modelId}" references unknown role: "${role}"`);
      }
    }
  }

  // 4. Validate data-policy absolute-exclusion rule
  if (!dataPolicy.data_classes.SECRET.fail_closed) {
    throw new Error('SECRET must have fail_closed: true');
  }

  return { valid: true, canonicalRolesCount: canonicalRoles.size, modelsCount: Object.keys(registry.models).length };
}

// dataClass classifies the actual payload being sent, never the repository or task it came from -
// a code-only task in a personal repo is PRIVATE_CODE (or PUBLIC/SANITIZED if genuinely generic),
// not PERSONAL_SENSITIVE by default. See docs/router-v2.md "Data classification" for the full rule.
// `preloaded` lets hot per-route callers (Stage A over the whole candidate pool) pass the
// loadConfigs() result they already hold instead of re-reading every config file per route.
export function evaluateDataGate(dataClass, targetProfileName, routeContext = {}, preloaded = null) {
  const { dataPolicy, privacyMetadata } = preloaded || loadConfigs();
  const dc = dataPolicy.data_classes[dataClass];
  if (!dc) throw new Error(`Unknown data class: ${dataClass}`);

  if (dataClass === 'SECRET') {
    return { allowed: false, reason: 'SECRET data is strictly excluded from all model context under any provider' };
  }

  const profile = dataPolicy.live_route_profiles[targetProfileName];
  if (!profile) throw new Error(`Unknown route profile: ${targetProfileName}`);

  if (!profile.allowed_data_classes.includes(dataClass)) {
    return { allowed: false, reason: `Data class ${dataClass} blocked on route profile ${targetProfileName}` };
  }

  // Multi-vendor pass-through gateways (e.g. opencode_go) cannot carry one blanket privacy claim
  // for every model behind them, so PERSONAL_SENSITIVE additionally requires real, current,
  // per-model route-owner privacy metadata rather than the profile's own coarse allow-list.
  if (profile.per_model_privacy_required && dataClass === 'PERSONAL_SENSITIVE') {
    const modelKey = routeContext.resolvedRuntimeModel || null;
    const meta = modelKey ? privacyMetadata?.models?.[modelKey] : null;
    if (!meta) {
      return {
        allowed: false,
        reason: `PERSONAL_SENSITIVE blocked on route profile ${targetProfileName}: no verified per-model privacy metadata for ${modelKey || '(unresolved model)'}`
      };
    }
    if (isPrivacyMetadataStale(privacyMetadata, meta)) {
      return {
        allowed: false,
        reason: `PERSONAL_SENSITIVE blocked: privacy metadata for ${modelKey} is stale (retrieved_at ${meta.retrieved_at || 'unknown'}) and needs revalidation before it can gate this data class`
      };
    }
    if (meta.training_use === 'used') {
      return {
        allowed: false,
        reason: `PERSONAL_SENSITIVE blocked: ${modelKey}'s route-owner policy permits training on prompts/completions (source: ${meta.source})`
      };
    }
    if ((meta.retention_days ?? 0) > 0) {
      return {
        allowed: false,
        reason: `PERSONAL_SENSITIVE blocked: ${modelKey} retains data for ${meta.retention_days} day(s) per route-owner policy (source: ${meta.source})`
      };
    }
  }

  return { allowed: true, reason: 'Data class permitted by profile policy' };
}

export function planContextShunting(rawTokenCount, taskComplexity) {
  const shuntingRequired = Number(rawTokenCount) > 12000;
  return {
    shuntingRequired,
    bulkReaderRole: shuntingRequired ? 'fast_context' : null,
    contextWorkerRole: shuntingRequired ? 'fast_context' : null,
    workerSelection: shuntingRequired ? 'dynamic_router_v2' : null,
    codeWriterRole: taskComplexity === 'high' ? 'deep_engineer' : 'general_engineer',
    strategy: shuntingRequired
      ? 'Context Broker deterministically extracts evidence, then selects a worker through Router V2; the reasoner receives the ContextPack.'
      : 'Direct context injection within the Context Broker direct bound'
  };
}

export const ROLE_DEFAULT_EFFORT = {
  critical_auditor: 'high',
  architect_synthesizer: 'high',
  deep_engineer: 'high',
  deep_context: 'high',
  general_engineer: 'medium',
  autonomous_engineer: 'medium',
  strong_cheap_worker: 'medium',
  fast_context: 'low',
  fast_precise: 'low',
  cheap_tool_worker: 'low'
};

// Seed priors from config/routing-priors.json are legacy quality evidence, used
// only where no Model Intelligence file is present.  A prior counts for a route
// when it names the route's harness and recommends the requested role; a task
// marked critical never rests on a seed prior.  Catalog routing_status plays no part.
export function seedPriorAdmission({ route, role, critical = false, priors = null } = {}) {
  if (critical) return { admitted: false, reason: 'critical tasks require real capability evidence' };
  const prior = priorForRoute(route, priors);
  if (!prior) return { admitted: false, reason: 'no seed prior for this route' };
  if (!prior.harness) return { admitted: false, reason: 'seed prior does not name a harness' };
  if (prior.harness !== route.harness) {
    return { admitted: false, reason: `seed prior is for harness ${prior.harness}` };
  }
  if (!Array.isArray(prior.recommended_roles) || !prior.recommended_roles.includes(role)) {
    return { admitted: false, reason: `seed prior does not recommend role ${role}` };
  }
  return { admitted: true, reason: 'seed prior recommends this role', prior };
}

// Explicit route-level availability states (per-provider catalogs probe these
// per model; one dead model never disables an otherwise usable provider).
// AVAILABLE and RATE_LIMITED (a nonzero limit, priced through scarcity) pass;
// every other state is a hard blocker at Stage A.
export const ROUTE_AVAILABILITY_STATES = Object.freeze([
  'AVAILABLE',
  'RATE_LIMITED',
  'RATE_LIMITED_ZERO',
  'QUOTA_EXHAUSTED',
  'TIER_BLOCKED',
  'AUTH_FAILED',
  'MODEL_UNAVAILABLE',
  'STALE',
  'UNKNOWN'
]);
const AVAILABILITY_STATE = Object.freeze({
  available: 'AVAILABLE',
  // The catalog could not confirm availability; Stage A's live pool status still gates.
  unknown: 'AVAILABLE',
  credit_gated: 'AVAILABLE',
  // Catalog record of a probe/capacity outcome; UNKNOWN passes and is priced.
  rate_limited: 'RATE_LIMITED',
  rate_limited_zero: 'RATE_LIMITED_ZERO',
  quota_exhausted: 'QUOTA_EXHAUSTED',
  tier_blocked: 'TIER_BLOCKED',
  auth_failed: 'AUTH_FAILED',
  model_unavailable: 'MODEL_UNAVAILABLE',
  stale_catalog: 'STALE',
  stale: 'STALE',
  auth_required: 'AUTH_REQUIRED'
});
// States that pass candidate generation; everything else is a hard blocker.
const AVAILABILITY_PASS_STATES = new Set(['AVAILABLE', 'RATE_LIMITED']);
// Zero-marginal-cost free routes are never PAYG: they carry an explicit
// FREE_RATE_LIMITED spend policy whose only cost is the provider's rate limit.
// PAYG remains a hard blocker everywhere (zero-PAYG constraint).
const SPEND_POLICIES = new Set(['BASELINE_SUBSCRIPTION', 'CREDIT_GATED', 'PAYG', 'FREE_RATE_LIMITED', 'FORBIDDEN']);
const SPEND_PASS_POLICIES = new Set(['BASELINE_SUBSCRIPTION', 'FREE_RATE_LIMITED']);

// Independent RouteTarget state dimensions.  None of them reads lifecycle
// routing_status stages or real_n; only hard facts can produce a hard blocker.
// Validation and operational health come from route-validation.json and default
// to UNKNOWN, which is uncertainty and never a block.
export function routeStateDimensions(route, { routeValidation = null, taskClass = null } = {}) {
  const broken = route?.broken === true || route?.routing_status === 'BROKEN';
  const availability = broken ? 'UNAVAILABLE'
    : (route?.availability === undefined ? 'AVAILABLE' : (AVAILABILITY_STATE[route.availability] || 'MODEL_UNAVAILABLE'));
  let spendPolicy;
  if (SPEND_POLICIES.has(route?.spend_policy)) spendPolicy = route.spend_policy;
  else if (route?.availability === 'credit_gated' || route?.routing_status === 'CREDIT_GATED' || /_credits$/.test(route?.quota_pool || '')) spendPolicy = 'CREDIT_GATED';
  else if (RESOURCE_POOLS.includes(routePoolName(route))) spendPolicy = 'BASELINE_SUBSCRIPTION';
  else if (route?.spend_policy === 'FREE_RATE_LIMITED' || (route?.route_kind === 'api_completion' && route?.free_tier === true)) spendPolicy = 'FREE_RATE_LIMITED';
  else spendPolicy = 'FORBIDDEN';
  const summary = taskClass ? routeValidationSummary(routeValidation, route, taskClass) : { validation: 'UNKNOWN', capabilities: {}, operational_health: 'UNKNOWN' };
  const hardBlockers = [];
  if (availability !== 'AVAILABLE' && !AVAILABILITY_PASS_STATES.has(availability)) {
    hardBlockers.push(`availability ${availability}${route?.availability ? ` (${route.availability})` : ''}`);
  }
  if (!SPEND_PASS_POLICIES.has(spendPolicy)) hardBlockers.push(`spend policy ${spendPolicy}`);
  if (route?.routing_status === 'MANUAL_ONLY') hardBlockers.push('captain policy MANUAL_ONLY');
  if (summary.validation === 'FAILED') {
    const failed = Object.entries(summary.capabilities).filter(([, status]) => status === 'FAILED').map(([name]) => name);
    hardBlockers.push(`route validation FAILED for ${failed.join(', ')}`);
  }
  if (summary.operational_health === 'UNHEALTHY') hardBlockers.push('operational health UNHEALTHY');
  return {
    availability,
    spend_policy: spendPolicy,
    validation: summary.validation,
    validation_capabilities: summary.capabilities,
    operational_health: summary.operational_health,
    hard_blockers: hardBlockers
  };
}

// Candidate generation admits every RouteTarget that no hard blocker excludes.
// Missing local evidence, a small real_n, or a lifecycle stage short of
// ROUTING_ELIGIBLE is uncertainty that Stage B weighs against the task class;
// it is never invisibility.
export function queryCapabilityCandidates({
  role,
  taskClass = null,
  dataClass,
  critical = false,
  retryTolerant = false,
  policy = {},
  learned = null,
  priors = null,
  compiledRoutes = [],
  modelIntelligence = null,
  routeValidation = null,
  configs = null,
  now = new Date()
} = {}) {
  const selectedTaskClass = taskClass || taskClassForRole(role);
  if (!TASK_CLASSES[selectedTaskClass]) {
    throw new Error(`Cannot route unknown task class: "${selectedTaskClass}"`);
  }
  // Retained for audit output only; promotion criteria no longer gate candidates.
  const criteria = promotionCriteria(policy);
  const intelligenceMode = modelIntelligence?.present === true;
  const candidates = [];
  const rejected = [];
  for (const route of compiledRoutes) {
    const routeState = routeStateDimensions(route, { routeValidation, taskClass: selectedTaskClass });
    if (routeState.hard_blockers.length) {
      rejected.push({ route_id: route.route_id, reason: `Hard blocker: ${routeState.hard_blockers.join('; ')}`, route_state: routeState });
      continue;
    }
    const capability = getCapabilityRecord(learned, route, selectedTaskClass);
    const capabilityStatus = capability?.routing_status || 'BENCHMARK_ONLY';
    const taskFit = intelligenceMode ? resolveTaskFit(modelIntelligence, route, selectedTaskClass, now) : null;
    const realEvidence = Number.isFinite(capability?.real_n) && capability.real_n > 0;
    const exploration = realEvidence || taskFit?.usable ? {
      rate: 0,
      eligible: false,
      phase: taskFit?.usable ? 'model-intelligence' : 'real-evidence',
      lowRisk: !critical && retryTolerant,
      reasons: []
    } : explorationPolicy({
      stage: 'CHALLENGER',
      realN: capability?.real_n || 0,
      dataClass,
      critical,
      retryTolerant,
      routeProfile: route.data_profile,
      resolvedRuntimeModel: route.resolved_runtime_model,
      // Reuse the caller's already-loaded policy config in the per-route gate.
      evaluateDataGate: (dataClassForGate, profile, context) => evaluateDataGate(dataClassForGate, profile, context, configs)
    });
    let candidateBasis;
    if (intelligenceMode) candidateBasis = taskFit.usable ? 'model_intelligence' : 'exploration';
    else if (realEvidence) candidateBasis = 'real_evidence';
    else if (Number.isFinite(capability?.posterior_mean) && capability.prior_effective_n > 0) candidateBasis = 'capability_prior';
    else if (seedPriorAdmission({ route, role, critical, priors }).admitted) candidateBasis = 'seed_prior';
    else candidateBasis = 'exploration';
    candidates.push({ route, capability, capabilityStatus, routeState, taskFit, realEvidence, exploration, candidateBasis });
  }
  return { taskClass: selectedTaskClass, criteria, intelligenceMode, candidates, rejected };
}

export function resolveLiveQuotaPools({ quotaOverrides = null, useLiveAxi = true } = {}) {
  const { quotaMap } = loadConfigs();
  const pools = JSON.parse(JSON.stringify(quotaMap.pools || {}));
  const initialWindowsFresh = quotaMap.generated_state?.stale !== true;
  for (const pool of Object.values(pools)) {
    setPoolWindowsFresh(pool, initialWindowsFresh);
  }

  const deriveScarcity = (pct) => {
    if (pct === null || pct === undefined || isNaN(pct)) return 'UNKNOWN';
    if (pct <= 0) return 'EXHAUSTED';
    if (pct <= 10) return 'CRITICAL';
    if (pct <= 25) return 'CONSERVE';
    if (pct <= 50) return 'NORMAL';
    return 'ABUNDANT';
  };

  if (useLiveAxi && process.env.FM_DISABLE_LIVE_QUOTA !== '1') {
    try {
      const axiOut = execFileSync('quota-axi', ['--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      });
      const data = normalizeQuotaAxiSnapshot(JSON.parse(axiOut));
      const providers = data.providers;
      const liveUpdated = new Set();
      // Replace, never merge: static quota-map windows are not live evidence and
      // must not survive next to (or instead of) the provider's current windows.
      const applyLive = (poolName, isUsable, effectiveItem, windows, providerStatus) => {
        const pool = pools[poolName];
        if (!pool) return;
        liveUpdated.add(poolName);
        const rem = isUsable ? effectiveItem?.effectivePercentRemaining : null;
        const scarcity = deriveScarcity(rem);
        const windowsKnown = Object.values(windows).some((w) => Number.isFinite(w.percent_remaining));
        if (scarcity === 'UNKNOWN' || !windowsKnown) {
          pool.scarcity_state = 'UNKNOWN';
          // Stage A refuses AUTH_REQUIRED pools; expired credentials are not merely unmeasured.
          pool.status = providerStatus === 'auth_required' ? 'AUTH_REQUIRED' : 'UNKNOWN';
          setPoolWindowsFresh(pool, false);
          return;
        }
        pool.scarcity_state = scarcity;
        pool.status = scarcity === 'EXHAUSTED' ? 'EXHAUSTED' : 'HEALTHY';
        pool.windows = windows;
        setPoolWindowsFresh(pool, true);
      };

      for (const p of providers) {
        const name = p.provider;
        const pState = p.state || {};
        const isFresh = pState.status === 'fresh' || pState.status === 'cached' || (!pState.stale && pState.status !== 'auth_required' && pState.status !== 'error');
        const semantics = p.quotaSemantics || {};
        const isUsable = isFresh && semantics.status === 'known';
        const effList = semantics.effectiveAvailability || [];

        const windowMap = {};
        for (const w of (p.windows || [])) {
          if (!w.id) continue;
          windowMap[w.id] = {
            percent_remaining: w.percent_remaining,
            reset_at: w.reset_at
          };
        }
        const windowsWithPrefix = (prefix) => Object.fromEntries(Object.entries(windowMap).filter(([k]) => k.startsWith(prefix)));

        if (name === 'codex') {
          applyLive('codex_plus', isUsable, effList.find(e => e.scope === 'all_models') || effList[0], windowMap, pState.status);
        } else if (name === 'claude') {
          applyLive('claude_pro', isUsable, effList.find(e => e.scope === 'all_models') || effList[0], windowMap, pState.status);
          if (pools.claude_pro_credits) {
            pools.claude_pro_credits.scarcity_state = 'UNKNOWN';
          }
        } else if (name === 'antigravity') {
          applyLive('antigravity_gemini', isUsable, effList.find(e => e.scope === 'gemini'), windowsWithPrefix('gemini'), pState.status);
          applyLive('antigravity_3p', isUsable, effList.find(e => e.scope === '3p'), windowsWithPrefix('3p'), pState.status);
        }
      }
      // A pool the live adapter did not report has no live evidence at all.
      for (const k of ['codex_plus', 'claude_pro', 'antigravity_gemini', 'antigravity_3p']) {
        if (pools[k] && !liveUpdated.has(k)) {
          pools[k].scarcity_state = 'UNKNOWN';
          pools[k].status = 'UNKNOWN';
          setPoolWindowsFresh(pools[k], false);
        }
      }
    } catch (err) {
      // Only pools the live adapter owns lose their state on failure; probe-based
      // pools registered by provider discovery keep their recorded auth/availability.
      for (const k of ['codex_plus', 'claude_pro', 'antigravity_gemini', 'antigravity_3p']) {
        if (!pools[k]) continue;
        pools[k].scarcity_state = 'UNKNOWN';
        pools[k].status = 'UNKNOWN';
        setPoolWindowsFresh(pools[k], false);
      }
    }

    const openCodePool = pools.opencode_go;
    if (openCodePool) {
      try {
        const usage = readOpenCodeGoQuota();
        const windowNames = ['rolling_5h', 'weekly', 'monthly'];
        const hasFreshAuthoritativeWindows = usage.stale !== true &&
          usage.source === 'opencode_go_usage_api' &&
          windowNames.every((name) => Number.isFinite(usage[name]?.percent_remaining));

        if (hasFreshAuthoritativeWindows) {
          const windows = Object.fromEntries(windowNames.map((name) => [name, {
            percent_remaining: usage[name].percent_remaining,
            percent_used: usage[name].percent_used,
            reset_at: usage[name].reset_at
          }]));
          const remaining = Math.min(...windowNames.map((name) => usage[name].percent_remaining));
          openCodePool.windows = windows;
          openCodePool.scarcity_state = deriveScarcity(remaining);
          openCodePool.status = openCodePool.scarcity_state === 'EXHAUSTED' ? 'EXHAUSTED' : 'HEALTHY';
          setPoolWindowsFresh(openCodePool, true);
        } else {
          openCodePool.scarcity_state = 'UNKNOWN';
          openCodePool.status = 'UNKNOWN';
          setPoolWindowsFresh(openCodePool, false);
        }
      } catch (err) {
        openCodePool.scarcity_state = 'UNKNOWN';
        openCodePool.status = 'UNKNOWN';
        setPoolWindowsFresh(openCodePool, false);
      }
    }
  }

  if (quotaOverrides) {
    for (const [k, v] of Object.entries(quotaOverrides)) {
      const previousWindowsFresh = poolWindowsFresh(pools[k]);
      pools[k] = { ...(pools[k] || {}), ...v, _explicit_override: Boolean(v.scarcity_state) };
      setPoolWindowsFresh(pools[k], Object.prototype.hasOwnProperty.call(v, 'windows') || previousWindowsFresh);
    }
  }

  for (const k of Object.keys(pools)) {
    const p = pools[k];
    if (!p.scarcity_state || p.scarcity_state === 'UNKNOWN') {
      p.scarcity_state = 'UNKNOWN';
    }
  }

  return pools;
}

export const TASK_CLASS_QUALITY_FLOORS = Object.freeze({
  targeted_edit: 0.84,
  mechanical_tool_work: 0.82,
  test_generation: 0.84,
  refactor: 0.70,
  multi_file_feature: 0.80,
  brownfield_debugging: 0.93,
  large_context_repository_retrieval: 0.78,
  long_horizon_autonomous_engineering: 0.90,
  architecture_reasoning: 0.93,
  critical_audit: 0.96
});

export function qualityFloorForTask({ taskClass, critical = false, qualityFloor = null } = {}) {
  if (Number.isFinite(qualityFloor)) return Math.min(0.999, Math.max(0.01, qualityFloor));
  const configured = TASK_CLASS_QUALITY_FLOORS[taskClass] ?? 0.80;
  return critical ? Math.max(configured, 0.96) : configured;
}

// The executions log is appended by concurrent dispatchers, so a reader can see
// a partially written final line.  Skip only unparseable lines; one torn record
// must not erase every burn observation and active-concurrency count.
export function readRoutingTelemetryRecords(logPath = getExecutionsLogPath()) {
  let text;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch (_) {
    return [];
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (_) {
      // torn or corrupt line
    }
  }
  return records;
}

// An open execution holds a concurrency slot only while its task still has a
// live task record; teardown removes state/<task>.meta.
function executionTaskStillLive(records) {
  const taskId = records.find((record) => record?.task_id)?.task_id;
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(taskId)) return false;
  return fs.existsSync(homePath(path.join('state', `${taskId}.meta`)));
}

function routePoolName(route) {
  if (route?.quota_pool?.startsWith('opencode_go')) return 'opencode_go';
  return route?.quota_pool;
}

function effortFitScore(requiredEffort, candidateEffort) {
  // A route with no reasoning-effort knob cannot mismatch a requested effort;
  // its capability is priced separately by quality evidence.  Only explicit
  // tiers can satisfy or violate an explicit request.
  if (candidateEffort === null || candidateEffort === undefined) return 1;
  if (!candidateEffort) return 0;
  if (candidateEffort === requiredEffort) return 1;
  if (requiredEffort === 'high' && ['low', 'minimal'].includes(candidateEffort)) return -1;
  if (requiredEffort === 'low' && ['high', 'xhigh', 'max', 'ultra'].includes(candidateEffort)) return -1;
  return -0.5;
}

function priorForRoute(route, priors) {
  const candidates = [
    route?.resolved_runtime_model,
    route?.resolved_runtime_model?.replace(/^opencode-go\//, ''),
    // Antigravity Gemini slugs carry the effort tier (gemini-3.8-flash-low).
    route?.harness === 'antigravity' ? route?.resolved_runtime_model?.replace(/-(low|medium|high)$/, '') : null,
    route?.model_family,
    route?.logical_alias
  ].filter(Boolean);
  for (const key of candidates) {
    const prior = priors?.priors?.[key];
    if (Number.isFinite(prior?.prior_mean)) return prior;
    if (Number.isFinite(prior?.posterior_mean)) return { ...prior, prior_mean: prior.posterior_mean };
  }
  return null;
}

// Semantic quality evidence for Stage B.  When a Model Intelligence file is
// present it is the only semantic source: a usable assertion supplies its class
// anchor and confidence width, and a model it does not cover is UNKNOWN.  Real
// production outcomes never move that judgment; they stay operational telemetry.
// Without a Model Intelligence file the legacy chain (capability record, family
// prior, seed prior) still applies so homes keep routing until it is populated.
function qualityEvidence(candidate, selectedTaskClass, learned, priors, { intelligenceMode = false, role = null, critical = false } = {}) {
  const fit = candidate.taskFit;
  if (fit?.usable) {
    return {
      quality: fit.quality_prior,
      source: 'model_intelligence',
      capability_class: fit.class,
      confidence: fit.confidence,
      model_key: fit.model_key,
      dimension: fit.dimension,
      real_n: 0,
      real_successes: 0,
      prior_mean: fit.quality_prior,
      prior_effective_n: fit.pseudo_n
    };
  }
  if (intelligenceMode || fit) {
    return {
      quality: CLASS_QUALITY_PRIOR.UNKNOWN,
      source: 'model_intelligence_unknown',
      capability_class: 'UNKNOWN',
      unknown_reasons: fit?.problems || [],
      real_n: 0,
      real_successes: 0,
      prior_mean: CLASS_QUALITY_PRIOR.UNKNOWN,
      prior_effective_n: 0
    };
  }
  const direct = candidate.capability;
  if (Number.isFinite(direct?.posterior_mean)) {
    return {
      quality: Math.min(0.999, Math.max(0.01, direct.posterior_mean)),
      source: direct.real_n > 0 ? 'real_capability' : 'capability_prior',
      real_n: direct.real_n || 0,
      real_successes: Number.isFinite(direct.real_successes) ? direct.real_successes : 0,
      prior_mean: Number.isFinite(direct.prior_mean) ? direct.prior_mean : direct.posterior_mean,
      prior_effective_n: Number.isFinite(direct.prior_effective_n) ? direct.prior_effective_n : 0
    };
  }
  const familyPrior = familyPriorKey(candidate.route)
    ? learned?.model_family_priors?.[familyPriorKey(candidate.route)]?.[selectedTaskClass]
    : null;
  if (Number.isFinite(familyPrior?.prior_mean)) {
    return {
      quality: familyPrior.prior_mean,
      source: 'family_prior',
      real_n: 0,
      real_successes: 0,
      prior_mean: familyPrior.prior_mean,
      prior_effective_n: Number.isFinite(familyPrior.prior_effective_n) ? familyPrior.prior_effective_n : 0
    };
  }
  const seed = role ? seedPriorAdmission({ route: candidate.route, role, critical: false, priors }) : { admitted: false };
  const externalPrior = seed.admitted ? seed.prior : null;
  if (Number.isFinite(externalPrior?.prior_mean)) {
    return {
      quality: externalPrior.prior_mean,
      source: 'seed_prior',
      real_n: 0,
      real_successes: 0,
      prior_mean: externalPrior.prior_mean,
      prior_effective_n: Number.isFinite(externalPrior.prior_effective_n) ? externalPrior.prior_effective_n : 0
    };
  }
  return {
    quality: 0.50,
    source: 'untested',
    ...(seed.reason && !seed.admitted && seed.reason !== 'no seed prior for this route' ? { unknown_reasons: [seed.reason] } : {}),
    real_n: 0,
    real_successes: 0,
    prior_mean: 0.5,
    prior_effective_n: 0
  };
}

export function stageAHardRequirements({
  candidates = [],
  liveQuota = {},
  poolEconomics = {},
  dataClass,
  // Accepted for API compatibility; challenger lifecycle status no longer gates.
  allowChallengers = false,
  excludeRoutes = [],
  requiredEffort = null,
  effortWasExplicit = false,
  requireSpawnable = false,
  routeObservations = null,
  configs = null,
  now = new Date()
} = {}) {
  const survivors = [];
  const rejected = [];
  for (const candidate of candidates) {
    const route = candidate.route;
    const routeId = route.route_id;
    const reject = (reason) => rejected.push({ route_id: routeId, reason, stage: 'A_hard_requirements' });
    if (excludeRoutes.includes(routeId)) {
      reject('Excluded by fallback re-routing policy');
      continue;
    }
    // Agent dispatch needs a harness that can host a worker session; completion-only
    // routes stay visible to routing/eval but never receive agent dispatches.
    if (requireSpawnable && (route.route_kind === 'api_completion' || !route.harness)) {
      reject('Route is completion-only and cannot host an agent session');
      continue;
    }
    // Agent dispatch requires tool calling: a free-provider model that rejects
    // tools cannot host an fm-spawn worker session even with a working endpoint.
    if (requireSpawnable && route.supports_tools === false) {
      reject('Provider model does not support tool calling (agent session)');
      continue;
    }

    // Captain policy and spend facts, re-checked here for callers that build
    // candidates themselves.  Evaluation lifecycle stages (CHALLENGER and the
    // rest) are audit history and never reject a route.
    if (candidate.capabilityStatus === 'MANUAL_ONLY') {
      reject('Captain policy: MANUAL_ONLY candidate requires manual captain specification');
      continue;
    }
    const routeState = candidate.routeState || routeStateDimensions(route);
    if (candidate.capabilityStatus === 'CREDIT_GATED' || routeState.hard_blockers.length) {
      reject(`Hard blocker: ${routeState.hard_blockers.join('; ') || 'capability record CREDIT_GATED'}`);
      continue;
    }
    if (effortWasExplicit && route.reasoning_effort && requiredEffort && route.reasoning_effort !== requiredEffort) {
      reject(`Effort ${route.reasoning_effort} does not satisfy explicitly requested effort ${requiredEffort}`);
      continue;
    }

    let gate;
    try {
      gate = evaluateDataGate(dataClass, route.data_profile, { resolvedRuntimeModel: route.resolved_runtime_model }, configs);
    } catch (error) {
      // An unregistered or misconfigured profile removes only its own routes;
      // one bad profile must not crash the whole dispatch.
      reject(`Data Policy unavailable: ${String(error.message).slice(0, 200)}`);
      continue;
    }
    if (!gate.allowed) {
      reject(`Data Policy Rejected: ${gate.reason}`);
      continue;
    }

    // Per-model capacity: a route whose own allowance windows are exhausted or
    // hard-zero is out regardless of the shared pool's aggregate state.
    const allowance = routeAllowanceState(
      route,
      routeObservations?.byRoute?.[routeId] || null,
      now instanceof Date ? now.getTime() : new Date(now).getTime()
    );
    if (allowance?.observed) {
      if (allowance.scarcity_state === 'EXHAUSTED') {
        reject('Route allowance exhausted (per-model window)');
        continue;
      }
      if (allowance.scarcity_state === 'CRITICAL' && route.availability === 'rate_limited_zero') {
        reject('Route allowance critical with zero rate limit');
        continue;
      }
    }

    const poolName = routePoolName(route);
    const pool = liveQuota[poolName] || {};
    const economics = poolEconomics[poolName] || {};
    const scarcityState = economics.scarcity_state || pool.scarcity_state || 'UNKNOWN';
    if (['UNAVAILABLE', 'AUTH_REQUIRED', 'ERROR'].includes(pool.status)) {
      reject(`Quota Pool unavailable (${pool.status})`);
      continue;
    }
    if (scarcityState === 'EXHAUSTED') {
      reject('Quota Pool Exhausted');
      continue;
    }
    if (Number.isFinite(economics.max_concurrency) && economics.current_concurrency >= economics.max_concurrency) {
      reject(`Capacity exhausted (${economics.current_concurrency}/${economics.max_concurrency} concurrent tasks)`);
      continue;
    }
    survivors.push({ ...candidate, pool, poolName, economics, scarcityState });
  }
  return { survivors, rejected };
}

// Stage B applies the task's quality requirement to each candidate's semantic
// evidence.  Uncertainty tolerance belongs to the task, not the route:
// - ordinary tasks compare the floor with the evidence mean;
// - a retry-tolerant, non-critical, non-high-risk task also admits a candidate
//   with no semantic judgment (unknown, untested, or LOW-confidence intelligence)
//   whose credible upper bound reaches the floor, so a new or obscure route can
//   compete for low-risk work while Stage C still prices its mean; a confident
//   judgment below the floor is never overridden;
// - high-risk classes rank Stage C by the conservative lower bound;
// - a task marked critical needs real evidence (legacy) or HIGH-confidence Model
//   Intelligence on a route whose task capabilities are VALIDATED.
function evidenceIsUncertain(evidence) {
  if (evidence.real_n > 0) return false;
  if (evidence.source === 'untested' || evidence.source === 'model_intelligence_unknown') return true;
  return evidence.source === 'model_intelligence' && evidence.confidence === 'LOW';
}

export function stageBQualityGate({
  candidates = [],
  taskClass,
  role = null,
  critical = false,
  retryTolerant = false,
  qualityFloor = null,
  learned = null,
  priors = null,
  intelligenceMode = false
} = {}) {
  const floor = qualityFloorForTask({ taskClass, critical, qualityFloor });
  const highRisk = isHighRiskTaskClass(taskClass, critical);
  const lowRiskTask = retryTolerant && !critical && !highRisk;
  const survivors = [];
  const rejected = [];
  for (const candidate of candidates) {
    const evidence = qualityEvidence(candidate, taskClass, learned, priors, { intelligenceMode, role, critical });
    evidence.credible = capabilityCredibleInterval({
      priorMean: evidence.prior_mean,
      priorEffectiveN: evidence.prior_effective_n,
      realN: evidence.real_n,
      realSuccesses: evidence.real_successes
    });
    const upperBound = Math.min(1, evidence.credible.mean + evidence.credible.z * evidence.credible.sd);
    evidence.credible.upper_bound = Number(upperBound.toFixed(6));
    // The floor stays on the posterior mean; high-risk classes carry the
    // conservative bound into Stage C so evidence depth, not a marginal mean, ranks.
    const successProbability = highRisk
      ? Math.min(evidence.quality, Math.max(0.01, evidence.credible.lower_bound))
      : evidence.quality;
    evidence.high_risk = highRisk;
    evidence.success_probability = successProbability;
    const enriched = { ...candidate, qualityScore: evidence.quality, successProbability, qualityEvidence: evidence };
    const reject = (reason) => rejected.push({
      route_id: candidate.route.route_id,
      reason,
      stage: 'B_quality_floor',
      quality: evidence.quality,
      quality_source: evidence.source
    });
    if (critical) {
      const validatedIntelligence = evidence.source === 'model_intelligence' && evidence.confidence === 'HIGH' &&
        candidate.routeState?.validation === 'VALIDATED';
      if (evidence.source !== 'real_capability' && !validatedIntelligence) {
        reject('critical tasks require real capability evidence or HIGH-confidence Model Intelligence on a VALIDATED route');
        continue;
      }
    }
    if (evidence.quality >= floor) {
      evidence.admitted_by = 'quality_floor';
    } else if (lowRiskTask && evidenceIsUncertain(evidence) && upperBound >= floor) {
      evidence.admitted_by = 'low_risk_uncertainty_tolerance';
    } else {
      const extra = evidence.unknown_reasons?.length ? ` (${evidence.unknown_reasons.join('; ')})` : '';
      reject(`Quality floor rejected route: P(success) ${evidence.quality.toFixed(4)} < ${floor.toFixed(4)}${extra}`);
      continue;
    }
    survivors.push(enriched);
  }
  return { floor, survivors, rejected };
}

export function scoreAndSelectRoute({
  role,
  taskClass = null,
  dataClass,
  targetEffort = null,
  critical = false,
  retryTolerant = false,
  quotaOverrides = null,
  allowChallengers = false,
  excludeRoutes = [],
  useLiveAxi = true,
  qualityFloor = null,
  telemetryRecords = null,
  requireSpawnable = false,
  explorationRandom = null,
  now = new Date()
}) {
  if (!dataClass || dataClass === 'UNKNOWN') {
    throw new Error(`dataClass is required and must not be empty or UNKNOWN (fail-closed policy)`);
  }
  const configs = loadConfigs();
  const { registry, policy, priors, learned, compiledRoutes, modelIntelligence, routeValidation } = configs;
  if (!registry.canonical_roles.includes(role)) {
    throw new Error(`Cannot route unknown role: "${role}"`);
  }

  const capabilityQuery = queryCapabilityCandidates({
    role,
    taskClass,
    dataClass,
    critical,
    retryTolerant,
    policy,
    learned,
    priors,
    compiledRoutes,
    modelIntelligence,
    routeValidation,
    configs,
    now
  });
  const selectedTaskClass = capabilityQuery.taskClass;

  const requiredEffort = targetEffort || ROLE_DEFAULT_EFFORT[role] || 'medium';

  // Use one intake quota snapshot for all three stages.
  const liveQuota = resolveLiveQuotaPools({ quotaOverrides, useLiveAxi });
  const candidateRoutes = capabilityQuery.candidates.map(candidate => candidate.route);
  const quotaEconomics = collectRoutingObservations(telemetryRecords || readRoutingTelemetryRecords(), compiledRoutes, now, {
    isActive: telemetryRecords ? null : executionTaskStillLive
  });
  const poolEconomics = buildPoolEconomics({ pools: liveQuota, observations: quotaEconomics, now });
  const stageA = stageAHardRequirements({
    candidates: capabilityQuery.candidates,
    liveQuota,
    poolEconomics,
    dataClass,
    allowChallengers,
    excludeRoutes,
    requiredEffort,
    effortWasExplicit: targetEffort !== null,
    requireSpawnable,
    routeObservations: quotaEconomics,
    configs,
    now
  });
  const candidateGenerationRejections = capabilityQuery.rejected.map((entry) => ({ ...entry, stage: 'candidate_generation' }));
  const stageB = stageBQualityGate({
    candidates: stageA.survivors,
    taskClass: selectedTaskClass,
    role,
    critical,
    retryTolerant,
    qualityFloor,
    learned,
    priors,
    intelligenceMode: capabilityQuery.intelligenceMode
  });
  const rejectedRoutes = [...candidateGenerationRejections, ...stageA.rejected, ...stageB.rejected];
  if (stageA.survivors.length === 0) {
    throw new Error(`No viable RouteTargets for role "${role}" with dataClass "${dataClass}". Rejections: ${rejectedRoutes.map(r => `${r.route_id}: ${r.reason}`).join('; ')}`);
  }
  if (stageB.survivors.length === 0) {
    throw new Error(`No routes meet quality floor ${stageB.floor.toFixed(4)} for role "${role}" with dataClass "${dataClass}". Rejections: ${rejectedRoutes.map(r => `${r.route_id}: ${r.reason}`).join('; ')}`);
  }

  const scored = stageB.survivors.map((candidate) => {
    const effortFit = effortFitScore(requiredEffort, candidate.route.reasoning_effort);
    const economics = buildRouteEconomics({
      route: candidate.route,
      capability: candidate.capability,
      poolEconomics,
      observations: quotaEconomics,
      candidateBasis: candidate.candidateBasis,
      successProbability: candidate.successProbability ?? candidate.qualityScore,
      effortFitScore: effortFit,
      operationalHealth: candidate.routeState?.operational_health,
      now
    });
    const arbitrageNote = candidate.route.harness === 'antigravity' && candidate.route.provider_path === 'antigravity_3p_gateway'
      ? `AGY 3P participates in staged economics (native Claude headroom: ${poolEconomics.claude_pro?.actual_remaining ?? 'unknown'}%)`
      : `Staged economics (state: ${candidate.scarcityState}, expected successful burn: ${economics.expected_successful_quota_burn})`;
    return {
      ...candidate,
      economics,
      effortFitScore: effortFit,
      quotaBonus: 0,
      finalScore: economics.economic_score,
      scarcityState: candidate.scarcityState,
      arbitrageNote
    };
  });
  const selected = selectEconomicRoute(scored);
  let winner = selected.winner;
  let explorationDispatch = null;

  // Bounded exploration for low-risk work: among Stage B survivors that are
  // exploration-eligible but lost to the economic winner, occasionally send one
  // real task so outcomes accumulate and uncertainty becomes evidence.  Never
  // for critical or high-risk work; rate is the route's own exploration policy
  // cap (bootstrap 0.18 / steady 0.05).
  const highRiskTask = isHighRiskTaskClass(selectedTaskClass, critical);
  const explorationCandidate = selected.ranked.find((entry) =>
    entry !== winner &&
    entry.exploration?.eligible === true &&
    entry.exploration.rate > 0
  );
  if (explorationCandidate && retryTolerant && !critical && !highRiskTask &&
      EXPLORATION_ASSIGNMENT_DATA_CLASSES.has(dataClass)) {
    const random = explorationRandom === null ? Math.random() : explorationRandom;
    if (Number.isFinite(random) && random < explorationCandidate.exploration.rate) {
      winner = explorationCandidate;
      explorationDispatch = {
        assigned: true,
        rate: explorationCandidate.exploration.rate,
        phase: explorationCandidate.exploration.phase,
        economic_winner_route_id: selected.winner.route.route_id,
        economic_winner_score: selected.winner.finalScore
      };
    }
  }

  return {
    role,
    taskClass: selectedTaskClass,
    dataClass,
    targetEffort: requiredEffort,
    effort: winner.route.reasoning_effort,
    selectedRoute: winner.route,
    selectedModelId: winner.route.resolved_runtime_model,
    modelId: winner.route.resolved_runtime_model, // For test compatibility
    resolvedRuntimeModel: winner.route.resolved_runtime_model, // For test compatibility
    harness: winner.route.harness,
    scarcityState: winner.scarcityState,
    finalScore: winner.finalScore,
    arbitrageReason: winner.arbitrageNote,
    explorationDispatch,
    candidateRoutesCount: candidateRoutes.length,
    viableCandidatesCount: stageA.survivors.length,
    sufficientCandidatesCount: stageB.survivors.length,
    qualityFloor: stageB.floor,
    modelIntelligence: {
      mode: capabilityQuery.intelligenceMode ? 'model_intelligence' : 'legacy_capability_evidence',
      path: modelIntelligence?.path || null,
      errors: [...(modelIntelligence?.errors || []), ...(routeValidation?.errors || [])]
    },
    resourcePools: RESOURCE_POOLS,
    rejectedRoutes,
    stages: {
      stageA: {
        input_count: capabilityQuery.candidates.length,
        survivor_count: stageA.survivors.length,
        rejected: stageA.rejected
      },
      stageB: {
        quality_floor: stageB.floor,
        input_count: stageA.survivors.length,
        survivor_count: stageB.survivors.length,
        rejected: stageB.rejected
      },
      stageC: {
        input_count: stageB.survivors.length,
        selected_route_id: winner.route.route_id,
        exploration_dispatch: explorationDispatch,
        ranking: selected.ranked.map((entry) => ({
          route_id: entry.route.route_id,
          economic_score: entry.economics.economic_score,
          expected_successful_quota_burn: entry.economics.expected_successful_quota_burn
        }))
      }
    },
    poolEconomics,
    selectedRouteEconomics: winner.economics,
    topCandidates: selected.ranked.slice(0, 4).map(s => ({
      route_id: s.route.route_id,
      score: s.finalScore,
      economic_score: s.economics.economic_score,
      expected_successful_quota_burn: s.economics.expected_successful_quota_burn,
      task_success_probability: s.economics.task_success_probability,
      effort_fit: s.effortFitScore,
      capability_status: s.capabilityStatus,
      candidate_basis: s.candidateBasis,
      real_n: s.real_n,
      quality: s.qualityScore,
      quality_source: s.qualityEvidence.source,
      capability_class: s.qualityEvidence.capability_class ?? null,
      admitted_by: s.qualityEvidence.admitted_by,
      route_state: s.routeState,
      quality_credible_lower_bound: s.qualityEvidence.credible?.lower_bound ?? null,
      quality_credible_width: s.qualityEvidence.credible?.width ?? null,
      pool: s.economics.resource_pool,
      surplus: s.economics.surplus,
      pressure: s.economics.pressure,
      exploration: s.exploration,
      note: s.arbitrageNote
    })),
    liveQuotaPools: liveQuota,
    allCandidates: selected.ranked.map(s => ({
      route_id: s.route.route_id,
      harness: s.route.harness,
      model: s.route.resolved_runtime_model,
      effort: s.route.reasoning_effort,
      score: s.finalScore,
      economic_score: s.economics.economic_score,
      expected_successful_quota_burn: s.economics.expected_successful_quota_burn,
      task_success_probability: s.economics.task_success_probability,
      quality: s.qualityScore,
      quality_source: s.qualityEvidence.source,
      capability_class: s.qualityEvidence.capability_class ?? null,
      admitted_by: s.qualityEvidence.admitted_by,
      route_state: s.routeState,
      capability_status: s.capabilityStatus,
      candidate_basis: s.candidateBasis,
      real_n: s.real_n,
      exploration: s.exploration,
      economics: s.economics
    }))
  };
}

export function logTelemetry(record) {
  const routeExecId = record.route_execution_id || record.execution_id || `rex-${Date.now()}-${Math.floor(Math.random()*1000)}`;
  const parentExecId = record.parent_route_execution_id || routeExecId;
  const entry = {
    route_execution_id: routeExecId,
    parent_route_execution_id: parentExecId,
    execution_id: routeExecId,
    timestamp: record.timestamp || new Date().toISOString(),
    ...record,
    route_execution_id: routeExecId,
    parent_route_execution_id: parentExecId,
    execution_id: routeExecId
  };
  const logPath = getExecutionsLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  return entry;
}

export function ingressDispatchStarted({
  taskId,
  routeExecutionId = null,
  parentExecutionId = null,
  attemptNumber = 1,
  retryCount = 0,
  path = 'A',
  taskClassification = null,
  dataClass = null,
  classificationStatus = null,
  candidateRoutes = null,
  candidateRouteSetMarker = null,
  routeDecision = null,
  quotaSnapshotBefore = null,
  selectedRouteId = null,
  selectedHarness = null,
  selectedModel = null,
  selectedEffort = null,
  diagnosticConstraint = null,
  dispatchType = 'task_dispatch',
  extra = {}
}) {
  const execId = routeExecutionId || `rex-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const rootId = parentExecutionId || execId;
  const now = new Date().toISOString();
  const classification = normalizeTelemetryClassification(dataClass, classificationStatus);

  let quotaBefore = quotaSnapshotBefore;
  if (!quotaBefore) {
    try {
      quotaBefore = resolveLiveQuotaPools({ useLiveAxi: true });
    } catch (_) {
      quotaBefore = null;
    }
  }

  const record = {
    route_execution_id: execId,
    parent_route_execution_id: rootId,
    execution_id: execId,
    attempt_number: attemptNumber,
    retry_count: retryCount,
    task_id: taskId,
    dispatch_path: path,
    dispatch_type: dispatchType,
    task_classification: taskClassification || 'general_engineer',
    requested_role: taskClassification || 'general_engineer',
    data_class: classification.dataClass,
    classification_status: classification.classificationStatus,
    candidate_routes: candidateRoutes,
    candidate_route_set_marker: candidateRouteSetMarker,
    route_decision: routeDecision,
    quota_snapshot_before: quotaBefore,
    selected_route_id: selectedRouteId,
    selected_harness: selectedHarness,
    selected_model: selectedModel,
    selected_effort: selectedEffort,
    actual_harness: null,
    actual_model: null,
    actual_effort: null,
    ...(diagnosticConstraint ? { diagnostic_constraint: diagnosticConstraint } : {}),
    dispatch_status: 'started',
    lifecycle_state: 'SELECTED',
    started_at: now,
    timestamp: now,
    ...extra,
    data_class: classification.dataClass,
    classification_status: classification.classificationStatus
  };

  return logTelemetry(record);
}

export function ingressDispatchLaunching({
  taskId,
  routeExecutionId,
  parentExecutionId = null,
  attemptNumber = 1,
  retryCount = 0,
  path = 'A',
  selectedRouteId = null,
  selectedHarness = null,
  selectedModel = null,
  selectedEffort = null,
  dataClass = null,
  classificationStatus = null,
  dispatchType = 'task_dispatch',
  extra = {}
}) {
  const rootId = parentExecutionId || routeExecutionId;
  const now = new Date().toISOString();
  const classification = normalizeTelemetryClassification(dataClass, classificationStatus);
  const record = {
    route_execution_id: routeExecutionId,
    parent_route_execution_id: rootId,
    execution_id: routeExecutionId,
    attempt_number: attemptNumber,
    retry_count: retryCount,
    task_id: taskId,
    dispatch_path: path,
    dispatch_type: dispatchType,
    selected_route_id: selectedRouteId,
    selected_harness: selectedHarness,
    selected_model: selectedModel,
    selected_effort: selectedEffort,
    dispatch_status: 'launching',
    lifecycle_state: 'LAUNCHING',
    launching_at: now,
    timestamp: now,
    ...extra,
    data_class: classification.dataClass,
    classification_status: classification.classificationStatus
  };
  return logTelemetry(record);
}

export function ingressDispatchDispatched({
  taskId,
  routeExecutionId,
  parentExecutionId = null,
  attemptNumber = 1,
  retryCount = 0,
  path = 'A',
  selectedRouteId = null,
  selectedHarness = null,
  selectedModel = null,
  selectedEffort = null,
  actualHarness = null,
  actualModel = null,
  actualEffort = null,
  dataClass = null,
  classificationStatus = null,
  workerId = null,
  worktree = null,
  pid = null,
  backend = null,
  dispatchType = 'task_dispatch',
  extra = {}
}) {
  const rootId = parentExecutionId || routeExecutionId;
  const now = new Date().toISOString();
  const classification = normalizeTelemetryClassification(dataClass, classificationStatus);

  const record = {
    route_execution_id: routeExecutionId,
    parent_route_execution_id: rootId,
    execution_id: routeExecutionId,
    attempt_number: attemptNumber,
    retry_count: retryCount,
    task_id: taskId,
    dispatch_path: path,
    dispatch_type: dispatchType,
    selected_route_id: selectedRouteId,
    selected_harness: selectedHarness,
    selected_model: selectedModel,
    selected_effort: selectedEffort,
    actual_harness: actualHarness,
    actual_model: actualModel,
    actual_effort: actualEffort,
    herdr_worker_id: workerId || 'unknown',
    herdr_task_id: taskId,
    worktree: worktree || null,
    pid: pid ? Number(pid) : null,
    backend: backend || null,
    dispatch_match: true,
    dispatch_status: 'dispatched',
    lifecycle_state: 'DISPATCHED',
    dispatched_at: now,
    timestamp: now,
    ...extra,
    data_class: classification.dataClass,
    classification_status: classification.classificationStatus
  };

  return logTelemetry(record);
}

export function ingressDispatchRunning({
  taskId,
  routeExecutionId,
  parentExecutionId = null,
  attemptNumber = 1,
  retryCount = 0,
  path = 'A',
  selectedRouteId = null,
  selectedHarness = null,
  selectedModel = null,
  selectedEffort = null,
  actualHarness = null,
  actualModel = null,
  actualEffort = null,
  dataClass = null,
  classificationStatus = null,
  workerId = null,
  worktree = null,
  pid = null,
  backend = null,
  dispatchType = 'task_dispatch',
  extra = {}
}) {
  const rootId = parentExecutionId || routeExecutionId;
  const now = new Date().toISOString();
  const classification = normalizeTelemetryClassification(dataClass, classificationStatus);
  const record = {
    route_execution_id: routeExecutionId,
    parent_route_execution_id: rootId,
    execution_id: routeExecutionId,
    attempt_number: attemptNumber,
    retry_count: retryCount,
    task_id: taskId,
    dispatch_path: path,
    dispatch_type: dispatchType,
    selected_route_id: selectedRouteId,
    selected_harness: selectedHarness,
    selected_model: selectedModel,
    selected_effort: selectedEffort,
    actual_harness: actualHarness,
    actual_model: actualModel,
    actual_effort: actualEffort,
    herdr_worker_id: workerId || 'unknown',
    herdr_task_id: taskId,
    worktree: worktree || null,
    pid: pid ? Number(pid) : null,
    backend: backend || null,
    dispatch_match: true,
    dispatch_status: 'running',
    lifecycle_state: 'RUNNING',
    running_at: now,
    timestamp: now,
    ...extra,
    data_class: classification.dataClass,
    classification_status: classification.classificationStatus
  };
  return logTelemetry(record);
}

export function ingressDispatchFailed({
  taskId,
  routeExecutionId,
  parentExecutionId = null,
  attemptNumber = 1,
  retryCount = 0,
  path = 'A',
  selectedRouteId = null,
  selectedHarness = null,
  selectedModel = null,
  selectedEffort = null,
  dataClass = null,
  classificationStatus = null,
  errorCategory = 'harness_launch_failure',
  errorMessage = '',
  dispatchType = 'task_dispatch',
  extra = {}
}) {
  const rootId = parentExecutionId || routeExecutionId;
  const now = new Date().toISOString();
  const classification = normalizeTelemetryClassification(dataClass, classificationStatus);

  const record = {
    route_execution_id: routeExecutionId,
    parent_route_execution_id: rootId,
    execution_id: routeExecutionId,
    attempt_number: attemptNumber,
    retry_count: retryCount,
    task_id: taskId,
    dispatch_path: path,
    dispatch_type: dispatchType,
    selected_route_id: selectedRouteId,
    selected_harness: selectedHarness,
    selected_model: selectedModel,
    selected_effort: selectedEffort,
    actual_harness: null,
    actual_model: null,
    actual_effort: null,
    dispatch_status: 'launch_failed',
    dispatch_match: false,
    terminal_state: 'LAUNCH_FAILED',
    lifecycle_state: 'FAILED',
    error_category: errorCategory,
    error_message: String(errorMessage).slice(0, 500),
    completed_at: now,
    timestamp: now,
    ...extra,
    data_class: classification.dataClass,
    classification_status: classification.classificationStatus
  };

  return logTelemetry(record);
}

// A launch failure is classified from what the spawn runner reports: an explicit
// WP8 classification wins, quota and data-policy refusals are recognised from
// the error text, and anything else is a hard runtime failure.
export function classifyDispatchFailure(spawnResult = {}) {
  const explicit = spawnResult?.failureClassification;
  if (explicit && Object.values(FAILURE_CLASSIFICATIONS).includes(explicit)) return explicit;
  const text = String(spawnResult?.error || '');
  if (/quota|rate[ -]?limit|usage limit|exhausted|\b429\b/i.test(text)) return FAILURE_CLASSIFICATIONS.QUOTA_FAILURE;
  if (/data policy|privacy|not permitted|strictly excluded/i.test(text)) return FAILURE_CLASSIFICATIONS.POLICY_FAILURE;
  return FAILURE_CLASSIFICATIONS.HARD_RUNTIME_FAILURE;
}

function continuationRouteRef(route) {
  return {
    route_id: route.route_id,
    harness: route.harness,
    model: route.resolved_runtime_model,
    effort: route.reasoning_effort || null,
    provider_path: route.provider_path || null,
    quota_pool: route.quota_pool || null
  };
}

// Work already present in the task's recorded local copy, so the next route
// resumes from it instead of rediscovering it.
function recordedWorktreeProgress(taskId) {
  const metaPath = homePath(path.join('state', `${taskId}.meta`));
  if (!fs.existsSync(metaPath)) return {};
  const line = fs.readFileSync(metaPath, 'utf8').split('\n').find((entry) => entry.startsWith('worktree='));
  const worktree = line ? line.slice('worktree='.length).trim() : '';
  if (!worktree || !fs.existsSync(worktree)) return {};
  try {
    const git = (args) => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 });
    return {
      currentDiff: git(['diff', 'HEAD']),
      filesModified: git(['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean)
    };
  } catch {
    return {};
  }
}

// WP8 handoff for a failed route: create the task's capsule on its first
// failure, then record the failure classification, the failed route, and the
// prior diff and refuted hypotheses the next route must resume from.
function recordDispatchFailureCapsule({ taskId, role, taskClass, dataClass, intent, spec, briefPath, selectedRoute, execId, failureClassification, spawnResult }) {
  const routeRef = continuationRouteRef(selectedRoute);
  if (!fs.existsSync(getTaskCapsulePath(taskId))) {
    const briefText = fs.readFileSync(briefPath, 'utf8').trim();
    const objective = [intent, spec].filter(Boolean).join('\n').trim() || briefText.slice(0, 4000) || `Complete task ${taskId}`;
    saveTaskStateCapsule(taskId, createTaskStateCapsule({
      logical_task_id: taskId,
      route_execution_id: execId,
      objective,
      constraints: [`data class ${dataClass}`, 'use only already-paid subscription capacity'],
      task_class: taskClass || taskClassForRole(role),
      data_class: dataClass,
      current_route: routeRef
    }));
  } else {
    updateTaskStateCapsule(taskId, (capsule) => {
      if (capsule.current_route?.route_id !== routeRef.route_id) {
        capsule.current_route = routeRef;
        capsule.route_execution_id = execId;
      }
    });
  }
  const progress = recordedWorktreeProgress(taskId);
  const reason = String(spawnResult?.error || 'spawn failed').slice(0, 500);
  return recordRouteFailureAndHandoff(taskId, {
    failureClassification,
    failureReason: reason,
    currentDiff: spawnResult?.currentDiff ?? progress.currentDiff ?? null,
    filesModified: spawnResult?.filesModified ?? progress.filesModified ?? null,
    commandsExecuted: spawnResult?.commandsExecuted ?? null,
    testResults: spawnResult?.testResults ?? null,
    failedHypotheses: [
      ...(Array.isArray(spawnResult?.failedHypotheses) ? spawnResult.failedHypotheses : []),
      { hypothesis: `route ${routeRef.route_id} can carry this task`, reason_refuted: `${failureClassification}: ${reason}` }
    ],
    nextRecommendedAction: `Resume on a different route after ${failureClassification}; do not repeat refuted hypotheses.`
  });
}

export function dispatchThroughHerdr({
  taskId,
  role = 'general_engineer',
  taskClass = null,
  dataClass,
  targetEffort = null,
  critical = false,
  retryTolerant = false,
  intent = '',
  spec = '',
  scout = true,
  projectDir = null,
  repoName = 'captain-workspace',
  mode = 'local-only',
  yolo = 'off',
  excludeRoutes = [],
  diagnosticConstraint = null,
  quotaOverrides = null,
  spawnRunner = null,
  routeExecutionId = null,
  parentExecutionId = null,
  attemptNumber = 1,
  retryCount = 0,
  useLiveAxi = true,
  backend = 'herdr',
  refreshCatalog = true,
  continuation = null
}) {
  if (!dataClass || dataClass === 'UNKNOWN') {
    throw new Error('dispatchThroughHerdr: dataClass is required and must not be empty or UNKNOWN (fail-closed policy)');
  }
  if (refreshCatalog) {
    const catalog = ensureRouteCatalogFresh();
    if (!catalog.fresh) {
      throw new Error(`dispatchThroughHerdr: RouteTarget catalog is missing or stale and could not be refreshed: ${catalog.error}`);
    }
  }
  let effectiveExcludes = [...excludeRoutes];
  if (diagnosticConstraint === 'non_agy_observer') {
    const { compiledRoutes } = loadConfigs();
    effectiveExcludes.push(...compiledRoutes.filter(r => r.harness === 'antigravity').map(r => r.route_id));
  }
  // A retry after a classified failure resumes from the task's capsule: the WP8
  // continuation scheduler picks the next route from its failure class, and the
  // continuation prompt is delivered to that worker through the launch brief.
  let decision;
  let continuationState = null;
  if (continuation) {
    const capsule = loadTaskStateCapsule(taskId);
    const selection = selectContinuationRoute(capsule, {
      failureClassification: continuation.failureClassification,
      failedRoute: continuation.failedRoute,
      exhaustedPool: continuation.exhaustedPool,
      excludeRoutes: effectiveExcludes,
      quotaOverrides,
      currentRole: role,
      critical,
      useLiveAxi
    });
    decision = selection.decision;
    continuationState = { capsule, escalation: selection.escalation };
    role = selection.escalation.role;
    taskClass = selection.escalation.taskClass;
  } else {
    decision = scoreAndSelectRoute({
      role,
      taskClass,
      dataClass,
      targetEffort,
      critical,
      retryTolerant,
      excludeRoutes: effectiveExcludes,
      quotaOverrides,
      requireSpawnable: true,
      useLiveAxi
    });
  }
  const selectedRoute = decision.selectedRoute;
  const briefPath = homePath(path.join('data', taskId, 'brief.md'));
  if (!fs.existsSync(briefPath)) {
    throw new Error(`dispatchThroughHerdr: task ${taskId} must be provisioned by the task intake owner; missing brief at ${briefPath}`);
  }

  const effectiveProjectDir = projectDir || currentFmHome();
  const contextBroker = createContextBroker({
    homeDir: currentFmHome(),
    routeSelector: (params) => scoreAndSelectRoute({ ...params, requireSpawnable: true }),
    dataGate: evaluateDataGate
  });
  const contextPack = contextBroker.requestContext({
    taskId,
    repoDir: effectiveProjectDir,
    query: [intent, spec].filter(Boolean).join('\n'),
    operation: 'broad_repository_scan',
    dataClass,
    interpretationNeeded: false,
    useLiveAxi
  });

  const execId = routeExecutionId || `rex-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const rootExecId = parentExecutionId || execId;

  if (continuationState) {
    const promptPath = homePath(path.join('data', taskId, 'continuation.md'));
    fs.writeFileSync(promptPath, `${formatContinuationPrompt(continuationState.capsule)}\n`, { mode: 0o600 });
    continuationState.promptPath = promptPath;
    recordContinuationDispatch(taskId, {
      nextRoute: selectedRoute,
      nextRouteExecutionId: execId,
      contextPackRefs: contextPack.provenance?.pack_sha256 ? [contextPack.provenance.pack_sha256] : []
    });
  }

  ingressDispatchStarted({
    taskId,
    routeExecutionId: execId,
    parentExecutionId: rootExecId,
    attemptNumber,
    retryCount,
    path: 'A',
    taskClassification: role,
    dataClass,
    candidateRoutes: decision.allCandidates || decision.topCandidates || [],
    candidateRouteSetMarker: null,
    routeDecision: {
      decision_type: 'router_v2',
      scheduler: 'staged_v3_wp5_wp6',
      route_id: selectedRoute.route_id,
      harness: selectedRoute.harness,
      model: selectedRoute.resolved_runtime_model,
      effort: selectedRoute.reasoning_effort,
      score: decision.finalScore,
      arbitrage_reason: decision.arbitrageReason,
      quality_floor: decision.qualityFloor,
      selected_route_economics: decision.selectedRouteEconomics,
      stages: decision.stages,
      context_pack: contextPack.provenance?.pack_sha256 || null,
      context_telemetry: contextPack.telemetry
    },
    quotaSnapshotBefore: decision.liveQuotaPools,
    selectedRouteId: selectedRoute.route_id,
    selectedHarness: selectedRoute.harness,
    selectedModel: selectedRoute.resolved_runtime_model,
    selectedEffort: selectedRoute.reasoning_effort,
    diagnosticConstraint
  });
  ingressDispatchLaunching({
    taskId,
    routeExecutionId: execId,
    parentExecutionId: rootExecId,
    attemptNumber,
    retryCount,
    path: 'A',
    selectedRouteId: selectedRoute.route_id,
    selectedHarness: selectedRoute.harness,
    selectedModel: selectedRoute.resolved_runtime_model,
    selectedEffort: selectedRoute.reasoning_effort,
    dataClass,
    extra: {
      requested_role: role,
      ...(diagnosticConstraint ? { diagnostic_constraint: diagnosticConstraint } : {})
    }
  });

  const spawnArgs = [path.join(ROOT, 'bin', 'fm-spawn.sh'), taskId, effectiveProjectDir];
  if (scout) {
    spawnArgs.push('--scout');
  } else {
    spawnArgs.push('--mode', mode, '--yolo', yolo);
  }
  spawnArgs.push('--harness', selectedRoute.harness);
  spawnArgs.push('--model', selectedRoute.resolved_runtime_model);
  spawnArgs.push('--role', role);
  spawnArgs.push('--data-class', dataClass);
  spawnArgs.push('--route-id', selectedRoute.route_id);
  spawnArgs.push('--route-execution-id', execId);
  spawnArgs.push('--parent-execution-id', rootExecId);
  if (contextPack.provenance?.cache_key) {
    spawnArgs.push('--context-pack', path.join(currentFmHome(), 'state', 'context-cache', `${contextPack.provenance.cache_key}.json`));
  }
  const spawnEffort = spawnEffortForRoute(selectedRoute.reasoning_effort);
  if (spawnEffort) spawnArgs.push('--effort', spawnEffort);
  spawnArgs.push('--backend', backend);

  let spawnResult;
  if (spawnRunner) {
    spawnResult = spawnRunner(spawnArgs, { env: { ...process.env, FM_HOME: currentFmHome() }, taskId, selectedRoute });
  } else {
    try {
      const stdout = execFileSync('bash', spawnArgs, {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 120000,
        env: { ...process.env, FM_HOME: currentFmHome() }
      });
      spawnResult = { success: true, output: stdout };
    } catch (error) {
      spawnResult = {
        success: false,
        error: typeof error.stderr === 'string' ? error.stderr : error.message,
        code: error.status
      };
    }
  }

  if (!spawnResult?.success) {
    ingressDispatchFailed({
      taskId,
      routeExecutionId: execId,
      parentExecutionId: rootExecId,
      attemptNumber,
      retryCount,
      path: 'A',
      selectedRouteId: selectedRoute.route_id,
      selectedHarness: selectedRoute.harness,
      selectedModel: selectedRoute.resolved_runtime_model,
      selectedEffort: selectedRoute.reasoning_effort,
      dataClass,
      errorMessage: String(spawnResult?.error || 'spawn failed').slice(0, 500),
      extra: {
        requested_role: role,
        ...(diagnosticConstraint ? { diagnostic_constraint: diagnosticConstraint } : {})
      }
    });

    const failureClassification = classifyDispatchFailure(spawnResult);
    let nextContinuation = null;
    let capsuleError = null;
    try {
      recordDispatchFailureCapsule({
        taskId, role, taskClass, dataClass, intent, spec, briefPath, selectedRoute, execId, failureClassification, spawnResult
      });
      nextContinuation = {
        failureClassification,
        failedRoute: continuationRouteRef(selectedRoute),
        exhaustedPool: failureClassification === FAILURE_CLASSIFICATIONS.QUOTA_FAILURE ? routePoolName(selectedRoute) : null
      };
    } catch (error) {
      capsuleError = error.message;
    }
    const failureResult = { success: false, taskId, executionId: execId, routeExecutionId: execId, routeDecision: decision, selectedRoute, spawnOutput: '', failureClassification, capsuleError };

    if (effectiveExcludes.includes(selectedRoute.route_id)) {
      return failureResult;
    }
    try {
      return dispatchThroughHerdr({
        taskId,
        role,
        taskClass,
        dataClass,
        targetEffort,
        critical,
        retryTolerant,
        intent,
        spec,
        scout,
        projectDir,
        repoName,
        mode,
        yolo,
        excludeRoutes: [...excludeRoutes, selectedRoute.route_id],
        diagnosticConstraint,
        quotaOverrides,
        spawnRunner,
        parentExecutionId: rootExecId,
        routeExecutionId: `${rootExecId}:retry-${retryCount + 1}`,
        attemptNumber: attemptNumber + 1,
        retryCount: retryCount + 1,
        useLiveAxi,
        backend,
        refreshCatalog: false,
        continuation: nextContinuation
      });
    } catch (retryError) {
      return { ...failureResult, error: retryError.message };
    }
  }

  const metaPath = homePath(path.join('state', `${taskId}.meta`));
  const meta = {};
  if (fs.existsSync(metaPath)) {
    for (const line of fs.readFileSync(metaPath, 'utf8').split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }

  ingressDispatchDispatched({
    taskId,
    routeExecutionId: execId,
    parentExecutionId: rootExecId,
    attemptNumber,
    retryCount,
    path: 'A',
    selectedRouteId: selectedRoute.route_id,
    selectedHarness: selectedRoute.harness,
    selectedModel: selectedRoute.resolved_runtime_model,
    selectedEffort: selectedRoute.reasoning_effort,
    actualHarness: meta.harness || selectedRoute.harness,
    actualModel: meta.model || selectedRoute.resolved_runtime_model,
    actualEffort: meta.effort || selectedRoute.reasoning_effort,
    dataClass,
    workerId: meta.window || meta.herdr_pane_id || 'unknown',
    worktree: meta.worktree || null,
    pid: meta.pid ? Number(meta.pid) : null,
    backend: meta.backend || 'herdr',
    extra: {
      requested_role: role,
      ...(diagnosticConstraint ? { diagnostic_constraint: diagnosticConstraint } : {}),
      herdr_session: meta.herdr_session || null,
      herdr_workspace_id: meta.herdr_workspace_id || null,
      herdr_tab_id: meta.herdr_tab_id || null,
      herdr_pane_id: meta.herdr_pane_id || null
    }
  });
  ingressDispatchRunning({
    taskId,
    routeExecutionId: execId,
    parentExecutionId: rootExecId,
    attemptNumber,
    retryCount,
    path: 'A',
    selectedRouteId: selectedRoute.route_id,
    selectedHarness: selectedRoute.harness,
    selectedModel: selectedRoute.resolved_runtime_model,
    selectedEffort: selectedRoute.reasoning_effort,
    actualHarness: meta.harness || selectedRoute.harness,
    actualModel: meta.model || selectedRoute.resolved_runtime_model,
    actualEffort: meta.effort || selectedRoute.reasoning_effort,
    dataClass,
    workerId: meta.window || meta.herdr_pane_id || 'unknown',
    worktree: meta.worktree || null,
    pid: meta.pid ? Number(meta.pid) : null,
    backend: meta.backend || 'herdr',
    extra: {
      requested_role: role,
      ...(diagnosticConstraint ? { diagnostic_constraint: diagnosticConstraint } : {}),
      herdr_session: meta.herdr_session || null,
      herdr_workspace_id: meta.herdr_workspace_id || null,
      herdr_tab_id: meta.herdr_tab_id || null,
      herdr_pane_id: meta.herdr_pane_id || null
    }
  });

  return {
    success: true,
    taskId,
    executionId: execId,
    routeExecutionId: execId,
    routeDecision: decision,
    selectedRoute,
    contextPack,
    continuation: continuationState ? {
      capsulePath: getTaskCapsulePath(taskId),
      promptPath: continuationState.promptPath,
      failureClassification: continuation.failureClassification,
      escalation: continuationState.escalation
    } : null,
    herdr: {
      window: meta.window,
      session: meta.herdr_session,
      workspaceId: meta.herdr_workspace_id,
      tabId: meta.herdr_tab_id,
      paneId: meta.herdr_pane_id,
      worktree: meta.worktree,
      pid: meta.pid ? Number(meta.pid) : null
    },
    spawnOutput: spawnResult.output || ''
  };
}

export function recordTaskCompletion(taskId, {
  terminalState = 'SUCCESS',
  resultSummary = '',
  exitCode = 0,
  routeExecutionId = null,
  parentExecutionId = null,
  tokensConsumed = null,
  cacheEfficiency = null,
  latencyMs = null,
  failureAttribution = null
} = {}) {
  const metaPath = homePath(path.join('state', `${taskId}.meta`));
  let meta = {};
  if (fs.existsSync(metaPath)) {
    const lines = fs.readFileSync(metaPath, 'utf8').split('\n');
    for (const line of lines) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
  }

  const reportPath = homePath(path.join('data', taskId, 'report.md'));
  const hasReport = fs.existsSync(reportPath);
  const logPath = getExecutionsLogPath();

  let execId = routeExecutionId || meta.route_execution_id || meta.execution_id;
  let parentId = parentExecutionId || meta.parent_route_execution_id;
  let dispatchPath = meta.dispatch_path || null;

  if (fs.existsSync(logPath)) {
    try {
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        const entry = JSON.parse(line);
        if (entry.task_id === taskId && (entry.route_execution_id || entry.execution_id)) {
          if (!execId) {
            execId = entry.route_execution_id || entry.execution_id;
            parentId = entry.parent_route_execution_id || execId;
          }
          if (!dispatchPath && entry.dispatch_path) {
            dispatchPath = entry.dispatch_path;
          }
          break;
        }
      }
    } catch (_) {}
  }

  if (!execId) {
    execId = `exec-${Date.now()}-${Math.floor(Math.random()*1000)}`;
  }
  if (!parentId) {
    parentId = execId;
  }

  // Idempotency check: if completed already recorded for this execution ID, do not re-append
  if (fs.existsSync(logPath)) {
    try {
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        const entry = JSON.parse(line);
        if (
          (entry.route_execution_id === execId || entry.execution_id === execId) &&
          entry.dispatch_status === 'completed'
        ) {
          return entry;
        }
      }
    } catch (_) {}
  }

  let quotaSnapshotAfter = null;
  try {
    quotaSnapshotAfter = resolveLiveQuotaPools({ useLiveAxi: true });
  } catch (_) {
    quotaSnapshotAfter = null;
  }

  const completionRecords = readRoutingTelemetryRecords();
  const startedRecord = completionRecords.find((entry) =>
    (entry.route_execution_id === execId || entry.execution_id === execId) && entry.dispatch_status === 'started'
  );
  let economicsObservation = null;
  if (startedRecord?.selected_route_id) {
    try {
      const { compiledRoutes } = loadConfigs();
      const route = compiledRoutes.find((candidate) => candidate.route_id === startedRecord.selected_route_id);
      const poolName = routePoolName(route);
      const quotaDelta = calculateObservedQuotaDelta(startedRecord.quota_snapshot_before, quotaSnapshotAfter, poolName);
      economicsObservation = {
        route_id: startedRecord.selected_route_id,
        resource_pool: poolName,
        shared_meter: poolName === 'opencode_go',
        expected_normalized_burn: route?.expected_normalized_burn ?? null,
        observed_quota_delta_percent: quotaDelta?.percent_points ?? null,
        observed_quota_delta_by_window: quotaDelta?.by_window ?? {},
        evidence: quotaDelta ? 'real_quota_delta' : 'unavailable'
      };
    } catch (_) {
      economicsObservation = null;
    }
  }
  const actualTokenUsage = tokensConsumed ?? meta.tokens_consumed ?? meta.actual_token_usage ?? null;
  const actualCacheEfficiency = cacheEfficiency ?? meta.cache_efficiency ?? null;
  const actualLatencyMs = latencyMs ?? meta.latency_ms ?? null;

  // Requested->actual model attestation (runtime identity invariant).  For an
  // opencode-hosted route the actual served model comes from the client's own
  // session storage for the task's worktree.  An explicit route that actually
  // served a different model can never record SUCCESS against the requested
  // model: the completion is forced to FAILED with attribution
  // MODEL_SUBSTITUTION, so the route's reliability sample counts it as a real
  // failure.  Auto routes (by design) record the resolved model where outcome
  // evidence must be attributed.  Any telemetry/runtime problem degrades to
  // UNATTESTED - uncertainty is recorded, never invented.
  const requestedModel = startedRecord?.selected_model || meta.model || null;
  let attestation = attestRequestedVsActual({
    requested: requestedModel,
    actual: meta.actual_model || null,
    autoRoute: attestationAutoRoute(startedRecord, null)
  });
  if (requestedModel && startedRecord?.selected_route_id) {
    try {
      const { compiledRoutes } = loadConfigs();
      const route = compiledRoutes.find((candidate) => candidate.route_id === startedRecord.selected_route_id);
      const autoRoute = attestationAutoRoute(startedRecord, route);
      let actualModel = meta.actual_model || null;
      if (!actualModel && (route?.harness === 'opencode')) {
        const directory = meta.worktree || meta.directory || null;
        const session = directory
          ? readOpencodeSessionAt({
            directory,
            sinceTs: startedRecord.timestamp ? new Date(startedRecord.timestamp).getTime() - 3600000 : null
          })
          : null;
        if (session) {
          actualModel = session.actual_model;
          attestation.tokens = session.tokens;
        }
      }
      const decision = attestRequestedVsActual({ requested: requestedModel, actual: actualModel, autoRoute });
      attestation = { ...attestation, ...decision };
      if (autoRoute && decision.attestation === 'AUTO_ROUTE_RESOLVED' && route) {
        // Attribution re-key: outcome evidence must land on the route of the
        // actually resolved model, not the auto route.
        const actualRoute = compiledRoutes.find((candidate) =>
          candidate.resolved_runtime_model === decision.actual_model ||
          candidate.logical_alias === decision.actual_model);
        if (actualRoute) attestation.attribution_route_id = actualRoute.route_id;
      }
    } catch (attestError) {
      attestation = attestRequestedVsActual({ requested: requestedModel, actual: meta.actual_model || null });
      attestation.attest_error = String(attestError.message).slice(0, 120);
    }
  }
  if (attestation.attestation === 'MISMATCH') {
    terminalState = 'FAILED';
    failureAttribution = failureAttribution || 'MODEL_SUBSTITUTION';
  }

  const now = new Date().toISOString();
  const completedRecord = {
    route_execution_id: execId,
    parent_route_execution_id: parentId,
    execution_id: execId,
    task_id: taskId,
    dispatch_path: dispatchPath,
    actual_harness: meta.harness || null,
    actual_model: attestation.actual_model || meta.model || null,
    actual_effort: meta.effort || null,
    model_attestation: attestation,
    herdr_worker_id: meta.window || null,
    dispatch_status: 'completed',
    lifecycle_state: terminalState === 'SUCCESS' ? 'COMPLETED' : 'FAILED',
    terminal_state: terminalState,
    // Unattributed failures default to AMBIGUOUS: operational telemetry that never
    // changes model capability (docs/router-v3-model-intelligence-schema.md).
    failure_attribution: terminalState === 'SUCCESS' ? null : normalizeAttribution(failureAttribution),
    exit_code: exitCode,
    artifact_path: hasReport ? `data/${taskId}/report.md` : null,
    result_summary: resultSummary || (hasReport ? fs.readFileSync(reportPath, 'utf8').slice(0, 300) : ''),
    quota_snapshot_after: quotaSnapshotAfter,
    actual_token_usage: actualTokenUsage === null ? null : Number(actualTokenUsage),
    cache_efficiency: actualCacheEfficiency === null ? null : Number(actualCacheEfficiency),
    latency_ms: actualLatencyMs === null ? null : Number(actualLatencyMs),
    economics_observation: economicsObservation,
    completed_at: now,
    timestamp: now
  };
  logTelemetry(completedRecord);
  return completedRecord;
}

export function teardownTask(taskId, { force = false } = {}) {
  try {
    const args = [path.join(ROOT, 'bin/fm-teardown.sh'), taskId];
    if (force) args.push('--force');
    const stdout = execFileSync('bash', args, { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, FM_HOME: currentFmHome() } });
    return { success: true, output: stdout };
  } catch (e) {
    return { success: false, error: e.stderr || e.message };
  }
}

// Router dispatch provenance: fm-spawn accepts a fresh worker as router-selected
// only when the executions log already holds this task's router_v2 selection for
// the same execution, route, harness, model, data class, and effort.  Passing the
// flags by hand is not enough, and SECRET is refused even with a matching record.
// The telemetry attribution re-key (collectRoutingObservations) calls this to
// relocate a computed observation to the actual-model route when an auto route
// resolved something different.
function attestationAutoRoute(startedRecord, route) {
  return route ? (route.auto_route === true || route.auto_routing === true) : false;
}

function spawnEffortForRoute(effort) {
  const mapped = effort === 'ultra' ? 'max' : effort;
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(mapped) ? mapped : null;
}

export function verifyRouterProvenance({ taskId, routeExecutionId, routeId, harness, model = null, dataClass = null, effort = null } = {}) {
  if (!taskId || !routeExecutionId || !routeId || !harness) {
    return { verified: false, reason: 'task id, route execution id, route id, and harness are all required' };
  }
  if (!dataClass || !ACTIVE_DATA_CLASSES.has(dataClass)) {
    return { verified: false, reason: `a router-selected spawn needs a known data class, got ${dataClass || 'none'}` };
  }
  if (dataClass === 'SECRET') {
    return { verified: false, reason: 'SECRET data is strictly excluded from all model context under any provider' };
  }
  const selection = readRoutingTelemetryRecords().find((record) =>
    record.route_execution_id === routeExecutionId &&
    record.dispatch_status === 'started' &&
    record.dispatch_path === 'A'
  );
  if (!selection) return { verified: false, reason: `no router selection is recorded for execution ${routeExecutionId}` };
  const mismatches = [];
  if (selection.task_id !== taskId) mismatches.push(`task ${selection.task_id}`);
  if (selection.route_decision?.decision_type !== 'router_v2') mismatches.push(`decision ${selection.route_decision?.decision_type}`);
  if (selection.selected_route_id !== routeId) mismatches.push(`route ${selection.selected_route_id}`);
  if (selection.selected_harness !== harness) mismatches.push(`harness ${selection.selected_harness}`);
  if (model && selection.selected_model !== model) mismatches.push(`model ${selection.selected_model}`);
  if (selection.data_class !== dataClass) mismatches.push(`data class ${selection.data_class}`);
  const requestedEffort = effort && effort !== 'default' ? effort : null;
  if (spawnEffortForRoute(selection.selected_effort) !== requestedEffort) {
    mismatches.push(`effort ${selection.selected_effort || 'default'}`);
  }
  if (mismatches.length > 0) {
    return { verified: false, reason: `recorded router selection differs: ${mismatches.join(', ')}` };
  }
  return { verified: true, reason: 'router selection recorded' };
}

function readCompiledRouteCatalog() {
  try {
    const routes = JSON.parse(fs.readFileSync(homePath('data/provider-catalogs/compiled-route-targets.json'), 'utf8'));
    return Array.isArray(routes) ? routes : [];
  } catch {
    return [];
  }
}

function routeIsSubscriptionCapacity(route) {
  return RESOURCE_POOLS.includes(routePoolName(route)) &&
    route.availability !== 'credit_gated' && route.routing_status !== 'CREDIT_GATED';
}

// A manual override replaces the router's route choice, never the spend policy:
// only already-paid subscription capacity in the five resource pools may run.
// A concrete model must match a catalogued subscription route, and every
// catalogued route for that model must be subscription capacity, so an
// uncatalogued or credit-gated model string cannot slip through.  With no
// concrete model the harness must carry subscription routes and runs its own
// default login.
export function evaluateManualOverrideSpendGate({ harness, model = null } = {}) {
  if (!harness) return { allowed: false, reason: 'a manual override needs a harness' };
  const concreteModel = model && model !== 'default' ? model : null;
  const matched = readCompiledRouteCatalog().filter((route) => route.harness === harness &&
    (!concreteModel || route.resolved_runtime_model === concreteModel));
  const label = `${harness}${concreteModel ? `/${concreteModel}` : ''}`;
  const subscription = matched.filter(routeIsSubscriptionCapacity);
  if (subscription.length === 0) {
    return {
      allowed: false,
      reason: `${label} has no catalogued route in a subscription pool (${RESOURCE_POOLS.join(', ')}); credit-gated, pay-as-you-go, and uncatalogued capacity is refused`,
      matched_routes: matched.map((route) => route.route_id)
    };
  }
  if (concreteModel) {
    const outside = matched.filter((route) => !routeIsSubscriptionCapacity(route));
    if (outside.length > 0) {
      return {
        allowed: false,
        reason: `${label} is catalogued outside subscription capacity on ${outside.map((route) => `${route.route_id} (pool ${route.quota_pool || 'none'}, ${route.availability || route.routing_status})`).join(', ')}`,
        matched_routes: matched.map((route) => route.route_id)
      };
    }
  }
  return { allowed: true, reason: 'subscription capacity', matched_routes: subscription.map((route) => route.route_id) };
}

// A manual override replaces the router's route choice, never the data policy
// or the spend policy.  The chosen harness (and model, when concrete) is matched
// against the compiled catalog regardless of its age, because data profiles do
// not go stale with quota.
export function evaluateManualOverrideDataGate({ harness, model = null, dataClass } = {}) {
  if (!dataClass || !ACTIVE_DATA_CLASSES.has(dataClass)) {
    return { allowed: false, reason: `a manual override needs a known data class, got ${dataClass || 'none'}` };
  }
  if (dataClass === 'SECRET') {
    return { allowed: false, reason: 'SECRET data is strictly excluded from all model context under any provider' };
  }
  const spend = evaluateManualOverrideSpendGate({ harness, model });
  if (!spend.allowed) return spend;
  const routes = readCompiledRouteCatalog();
  const concreteModel = model && model !== 'default' ? model : null;
  const matched = routes.filter((route) => route.harness === harness && route.data_profile &&
    (!concreteModel || route.resolved_runtime_model === concreteModel));
  if (matched.length === 0) {
    if (dataClass === 'PERSONAL_SENSITIVE') {
      return { allowed: false, reason: `PERSONAL_SENSITIVE needs a catalogued route; ${harness}${concreteModel ? `/${concreteModel}` : ''} has none` };
    }
    return { allowed: true, reason: 'no catalogued route for this choice; data class needs no per-route verification', matched_routes: [] };
  }
  for (const route of matched) {
    const gate = evaluateDataGate(dataClass, route.data_profile, { resolvedRuntimeModel: route.resolved_runtime_model });
    if (!gate.allowed) return { allowed: false, reason: gate.reason, matched_routes: matched.map((r) => r.route_id) };
  }
  return { allowed: true, reason: 'data class permitted on every matching route', matched_routes: matched.map((r) => r.route_id) };
}

function parseCliFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const k = arg.slice(2, eqIdx);
        const v = arg.slice(eqIdx + 1);
        flags[k] = v;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[arg.slice(2)] = argv[++i];
      } else {
        flags[arg.slice(2)] = true;
      }
    }
  }
  return flags;
}

// CLI handler
if (process.argv[1] && process.argv[1].endsWith('fm-router-v2.mjs')) {
  const cmd = process.argv[2] || 'validate';
  if (cmd === 'validate') {
    try {
      const res = validateConfigs();
      console.log(`ROUTER_V2: configuration verified valid (${res.canonicalRolesCount} canonical roles, ${res.modelsCount} models)`);
      process.exit(0);
    } catch (e) {
      console.error(`ROUTER_V2: invalid configuration - ${e.message}`);
      process.exit(1);
    }
  } else if (cmd === 'route') {
    const role = process.argv[3] || 'general_engineer';
    const dataClass = process.argv[4];
    const effort = process.argv[5] || null;
    if (!dataClass || dataClass === 'UNKNOWN') {
      console.error('Usage: fm-router-v2.mjs route <role> <dataClass> [effort]');
      console.error('Error: dataClass is required and must not be empty or UNKNOWN (fail-closed policy)');
      process.exit(1);
    }
    const res = scoreAndSelectRoute({ role, dataClass, targetEffort: effort });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'dispatch' && (process.argv[3] || '').startsWith('--')) {
    // Flag form is the normal crewmate/scout dispatch entrypoint.
    const flags = parseCliFlags(process.argv.slice(3));
    const scout = Boolean(flags.scout);
    if (!flags['task-id'] || !flags['data-class'] || !flags.project || (!scout && (!flags.mode || !flags.yolo))) {
      console.error('Usage: fm-router-v2.mjs dispatch --task-id <id> --project <dir> --data-class <class> [--role <role>] [--task-class <class>] (--scout | --mode <mode> --yolo <on|off>) [--effort <level>] [--retry-tolerant] [--critical] [--backend <name>]');
      process.exit(1);
    }
    try {
      const res = dispatchThroughHerdr({
        taskId: flags['task-id'],
        role: flags.role || 'general_engineer',
        taskClass: flags['task-class'] || null,
        dataClass: flags['data-class'],
        targetEffort: flags.effort || null,
        critical: Boolean(flags.critical),
        retryTolerant: Boolean(flags['retry-tolerant']),
        intent: flags.intent || `Task ${flags['task-id']}`,
        spec: flags.spec || '',
        scout,
        projectDir: path.resolve(flags.project),
        mode: flags.mode || 'local-only',
        yolo: flags.yolo || 'off',
        ...(flags.backend ? { backend: flags.backend } : {})
      });
      const { routeDecision, contextPack, ...summary } = res;
      console.log(JSON.stringify({
        ...summary,
        role: routeDecision?.role,
        taskClass: routeDecision?.taskClass,
        finalScore: routeDecision?.finalScore,
        topCandidates: routeDecision?.topCandidates
      }, null, 2));
      process.exit(res.success ? 0 : 1);
    } catch (e) {
      console.error(`DISPATCH ERROR: ${e.message}`);
      process.exit(1);
    }
  } else if (cmd === 'dispatch') {
    const taskId = process.argv[3];
    const role = process.argv[4] || 'general_engineer';
    const dataClass = process.argv[5];
    const effort = process.argv[6] || null;
    const diagnosticConstraint = process.env.DIAGNOSTIC_CONSTRAINT || process.argv[7] || null;
    if (!taskId || !dataClass || dataClass === 'UNKNOWN') {
      console.error('Usage: fm-router-v2.mjs dispatch <task_id> [role] <dataClass> [effort] [diagnosticConstraint]');
      console.error('Error: taskId and dataClass are required; dataClass must not be empty or UNKNOWN (fail-closed policy)');
      process.exit(1);
    }
    try {
      const res = dispatchThroughHerdr({
        taskId,
        role,
        dataClass,
        targetEffort: effort,
        intent: `Task ${taskId} (${role})`,
        spec: `Execute ${taskId} as ${role} and report results.`,
        scout: true,
        diagnosticConstraint
      });
      console.log(JSON.stringify(res, null, 2));
    } catch (e) {
      console.error(`DISPATCH ERROR: ${e.message}`);
      process.exit(1);
    }
  } else if (cmd === 'ingress-start') {
    const flags = parseCliFlags(process.argv.slice(3));
    const isSecondmateRelaunch = Boolean(flags['secondmate-relaunch']);
    const isRecoveryRelaunch = Boolean(flags['recovery-relaunch']);
    const overrideReason = typeof flags['manual-override'] === 'string' ? flags['manual-override'] : null;
    const dispatchType = isSecondmateRelaunch || isRecoveryRelaunch ? 'system_internal_relaunch' : 'task_dispatch';
    let decisionType = 'legacy_manual';
    let marker = 'legacy/manual decision, no candidate set evaluated';
    if (isSecondmateRelaunch) {
      decisionType = 'system_internal_relaunch';
      marker = 'system-internal relaunch, no candidate set evaluated';
    } else if (isRecoveryRelaunch) {
      decisionType = 'recovery_relaunch';
      marker = 'recovery relaunch of an existing task, no candidate set evaluated';
    } else if (overrideReason) {
      decisionType = 'manual_override';
      marker = 'explicit manual override, no candidate set evaluated';
    }
    const entry = ingressDispatchStarted({
      taskId: flags['task-id'],
      routeExecutionId: flags['route-execution-id'],
      parentExecutionId: flags['parent-execution-id'],
      path: flags['path'] || 'B',
      taskClassification: flags['task-classification'] || flags['role'] || flags['kind'] || 'crewmate',
      dataClass: flags['data-class'] || null,
      classificationStatus: flags['classification-status'] || null,
      candidateRoutes: null,
      candidateRouteSetMarker: marker,
      routeDecision: {
        decision_type: decisionType,
        marker,
        ...(overrideReason ? { override_reason: overrideReason.slice(0, 500) } : {}),
        ...(flags['router-authority'] ? { router_authority: flags['router-authority'] } : {}),
        harness: flags['harness'] || 'default',
        model: flags['model'] || 'default',
        effort: flags['effort'] || 'default',
        route_id: flags['route-id'] || null
      },
      selectedRouteId: flags['route-id'] || null,
      selectedHarness: flags['harness'] || null,
      selectedModel: flags['model'] || null,
      selectedEffort: flags['effort'] || null,
      dataClass: flags['data-class'] || null,
      classificationStatus: flags['classification-status'] || null,
      dispatchType
    });
    console.log(JSON.stringify(entry));
  } else if (cmd === 'ingress-launching') {
    const flags = parseCliFlags(process.argv.slice(3));
    const isSecondmateRelaunch = Boolean(flags['secondmate-relaunch'] || flags['recovery-relaunch']);
    const dispatchType = isSecondmateRelaunch ? 'system_internal_relaunch' : 'task_dispatch';
    const entry = ingressDispatchLaunching({
      taskId: flags['task-id'],
      routeExecutionId: flags['route-execution-id'],
      parentExecutionId: flags['parent-execution-id'],
      path: flags['path'] || 'B',
      selectedRouteId: flags['route-id'] || null,
      selectedHarness: flags['harness'] || null,
      selectedModel: flags['model'] || null,
      selectedEffort: flags['effort'] || null,
      dataClass: flags['data-class'] || null,
      classificationStatus: flags['classification-status'] || null,
      dispatchType
    });
    console.log(JSON.stringify(entry));
  } else if (cmd === 'ingress-dispatched') {
    const flags = parseCliFlags(process.argv.slice(3));
    const isSecondmateRelaunch = Boolean(flags['secondmate-relaunch'] || flags['recovery-relaunch']);
    const dispatchType = isSecondmateRelaunch ? 'system_internal_relaunch' : 'task_dispatch';
    const entry = ingressDispatchDispatched({
      taskId: flags['task-id'],
      routeExecutionId: flags['route-execution-id'],
      parentExecutionId: flags['parent-execution-id'],
      path: flags['path'] || 'B',
      actualHarness: flags['actual-harness'],
      actualModel: flags['actual-model'],
      actualEffort: flags['actual-effort'],
      dataClass: flags['data-class'] || null,
      classificationStatus: flags['classification-status'] || null,
      workerId: flags['worker-id'] || flags['window'],
      worktree: flags['worktree'],
      backend: flags['backend'],
      pid: flags['pid'],
      dispatchType
    });
    console.log(JSON.stringify(entry));
  } else if (cmd === 'ingress-running') {
    const flags = parseCliFlags(process.argv.slice(3));
    const isSecondmateRelaunch = Boolean(flags['secondmate-relaunch'] || flags['recovery-relaunch']);
    const dispatchType = isSecondmateRelaunch ? 'system_internal_relaunch' : 'task_dispatch';
    const entry = ingressDispatchRunning({
      taskId: flags['task-id'],
      routeExecutionId: flags['route-execution-id'],
      parentExecutionId: flags['parent-execution-id'],
      path: flags['path'] || 'B',
      selectedRouteId: flags['route-id'] || null,
      selectedHarness: flags['harness'] || null,
      selectedModel: flags['model'] || null,
      selectedEffort: flags['effort'] || null,
      actualHarness: flags['actual-harness'],
      actualModel: flags['actual-model'],
      actualEffort: flags['actual-effort'],
      dataClass: flags['data-class'] || null,
      classificationStatus: flags['classification-status'] || null,
      workerId: flags['worker-id'] || flags['window'],
      worktree: flags['worktree'],
      backend: flags['backend'],
      pid: flags['pid'],
      dispatchType
    });
    console.log(JSON.stringify(entry));
  } else if (cmd === 'ingress-failed') {
    const flags = parseCliFlags(process.argv.slice(3));
    const isSecondmateRelaunch = Boolean(flags['secondmate-relaunch'] || flags['recovery-relaunch']);
    const dispatchType = isSecondmateRelaunch ? 'system_internal_relaunch' : 'task_dispatch';
    const entry = ingressDispatchFailed({
      taskId: flags['task-id'],
      routeExecutionId: flags['route-execution-id'],
      parentExecutionId: flags['parent-execution-id'],
      path: flags['path'] || 'B',
      dataClass: flags['data-class'] || null,
      classificationStatus: flags['classification-status'] || null,
      errorMessage: flags['error'] || 'spawn failed',
      dispatchType
    });
    console.log(JSON.stringify(entry));
  } else if (cmd === 'verify-provenance') {
    const flags = parseCliFlags(process.argv.slice(3));
    const res = verifyRouterProvenance({
      taskId: flags['task-id'],
      routeExecutionId: flags['route-execution-id'],
      routeId: flags['route-id'],
      harness: flags['harness'],
      model: flags['model'] && flags['model'] !== 'default' ? flags['model'] : null,
      dataClass: flags['data-class'] || null,
      effort: flags['effort'] || null
    });
    console.log(JSON.stringify(res));
    process.exit(res.verified ? 0 : 1);
  } else if (cmd === 'override-gate') {
    const flags = parseCliFlags(process.argv.slice(3));
    const res = evaluateManualOverrideDataGate({
      harness: flags['harness'],
      model: flags['model'] || null,
      dataClass: flags['data-class']
    });
    console.log(JSON.stringify(res));
    process.exit(res.allowed ? 0 : 1);
  } else if (cmd === 'override-spend-gate') {
    const flags = parseCliFlags(process.argv.slice(3));
    const res = evaluateManualOverrideSpendGate({ harness: flags['harness'], model: flags['model'] || null });
    console.log(JSON.stringify(res));
    process.exit(res.allowed ? 0 : 1);
  } else if (cmd === 'catalog-refresh-if-stale') {
    const res = ensureRouteCatalogFresh();
    console.log(JSON.stringify(res));
    process.exit(res.fresh ? 0 : 1);
  } else if (cmd === 'complete') {
    const taskId = process.argv[3];
    const state = process.argv[4] || 'SUCCESS';
    const summary = process.argv[5] || '';
    // Optional sixth argument: failure attribution; unattributed failures record AMBIGUOUS.
    const res = recordTaskCompletion(taskId, { terminalState: state, resultSummary: summary, failureAttribution: process.argv[6] || null });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'teardown') {
    const taskId = process.argv[3];
    const force = process.argv[4] === '--force';
    const res = teardownTask(taskId, { force });
    console.log(JSON.stringify(res, null, 2));
  }
}
