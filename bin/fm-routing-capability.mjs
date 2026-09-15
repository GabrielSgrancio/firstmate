// Shared Router V3 capability taxonomy, evidence schema, and exploration policy.
// Router V2 reads this state; the evaluation lifecycle is the only writer.

export const STAGES = Object.freeze([
  'DISCOVERED',
  'SMOKE',
  'CHEAP_EVAL',
  'CHALLENGER',
  'LOW_RISK_REAL_TRAFFIC',
  'ROUTING_ELIGIBLE'
]);

export const STATUS_TO_STAGE = Object.freeze({ BENCHMARK_ONLY: 'DISCOVERED' });

export const PROMOTION_REAL_N = 15;
export const DEFAULT_PROMOTION_SUCCESS_RATE = 0.8;
export const BOOTSTRAP_EXPLORATION_RATE = 0.18;
export const STEADY_EXPLORATION_RATE = 0.05;
// High-risk task classes rank by a conservative credible bound on P(success)
// rather than the posterior point estimate, so thin evidence cannot outrank a
// well-evidenced route on a marginally higher mean.
export const HIGH_RISK_TASK_CLASSES = Object.freeze(['brownfield_debugging', 'architecture_reasoning', 'critical_audit']);
export const HIGH_RISK_CREDIBLE_Z = 1.645;
export const EXPLORATION_DATA_CLASSES = new Set(['PUBLIC', 'SANITIZED', 'PRIVATE_CODE']);

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

// Canonical roles remain task-language.  They are not model or route allow-lists.
export const ROLE_TASK_CLASS = Object.freeze({
  fast_precise: 'targeted_edit',
  cheap_tool_worker: 'mechanical_tool_work',
  strong_cheap_worker: 'test_generation',
  general_engineer: 'refactor',
  fast_context: 'large_context_repository_retrieval',
  deep_context: 'large_context_repository_retrieval',
  autonomous_engineer: 'multi_file_feature',
  deep_engineer: 'brownfield_debugging',
  architect_synthesizer: 'architecture_reasoning',
  critical_auditor: 'critical_audit'
});

export function roleForTaskClass(taskClass) {
  const definition = TASK_CLASSES[taskClass];
  if (!definition) throw new Error(`Unknown task class "${taskClass}"`);
  return definition.role;
}

export function taskClassForRole(role) {
  const taskClass = ROLE_TASK_CLASS[role];
  if (!taskClass) throw new Error(`Unknown canonical role "${role}"`);
  return taskClass;
}

export function stageForStatus(status) {
  return STATUS_TO_STAGE[status] || status;
}

export function stageIndex(stage) {
  const index = STAGES.indexOf(stage);
  if (index < 0) throw new Error(`Unknown lifecycle stage: ${stage}`);
  return index;
}

export function promotionCriteria(policy = {}) {
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

export function explorationPolicy({
  stage,
  realN = 0,
  dataClass = 'PUBLIC',
  critical = false,
  retryTolerant = false,
  routeProfile = null,
  resolvedRuntimeModel = null,
  evaluateDataGate = null
} = {}) {
  const reasons = [];
  if (!EXPLORATION_DATA_CLASSES.has(dataClass)) {
    reasons.push(`data class ${dataClass} is not eligible for automatic exploration`);
  }
  if (critical) reasons.push('task is marked critical');
  if (!retryTolerant) reasons.push('task is not retry-tolerant');
  if (!routeProfile) {
    reasons.push('no concrete route policy profile was supplied');
  } else if (typeof evaluateDataGate !== 'function') {
    reasons.push('data policy gate is unavailable');
  } else {
    try {
      const gate = evaluateDataGate(dataClass, routeProfile, { resolvedRuntimeModel });
      if (!gate.allowed) reasons.push(`data policy gate refused the route: ${gate.reason}`);
    } catch (error) {
      reasons.push(`data policy gate could not classify the route: ${error.message}`);
    }
  }
  const risk = { lowRisk: reasons.length === 0, reasons };
  if (!risk.lowRisk) return { rate: 0, eligible: false, phase: 'blocked', ...risk };
  if (['CHALLENGER', 'LOW_RISK_REAL_TRAFFIC'].includes(stage) && realN < PROMOTION_REAL_N) {
    return { rate: BOOTSTRAP_EXPLORATION_RATE, eligible: true, phase: 'bootstrap', ...risk };
  }
  if (stage === 'ROUTING_ELIGIBLE' || realN >= PROMOTION_REAL_N) {
    return { rate: STEADY_EXPLORATION_RATE, eligible: true, phase: 'steady', ...risk };
  }
  return { rate: 0, eligible: false, phase: 'not-challenger', ...risk };
}

export function familyPriorKey(route) {
  const family = route?.model_family;
  if (!family || typeof family !== 'string') return null;

  // The current catalog carries several DeepSeek V4 aliases whose backing-model
  // identity is not yet temporally verified.  Exclude them until the future
  // identity system can prove that a family label is safe to aggregate.
  if (/^deepseek-v4(?:[.-]|$)/i.test(family)) return null;
  return family;
}

export function routeModelName(route) {
  return route?.model_family || route?.raw_id || route?.logical_alias || route?.resolved_runtime_model;
}

export function isHighRiskTaskClass(taskClass, critical = false) {
  return critical || HIGH_RISK_TASK_CLASSES.includes(taskClass);
}

// Beta posterior over P(success): the record's prior contributes prior_mean *
// prior_effective_n pseudo-successes, real outcomes add their counts, and a
// uniform Beta(1,1) base keeps a short perfect streak from collapsing the width
// to zero.  The lower bound is mean - z * sd of that same posterior.
export function capabilityCredibleInterval({
  priorMean = 0.5,
  priorEffectiveN = 0,
  realN = 0,
  realSuccesses = 0,
  z = HIGH_RISK_CREDIBLE_Z
} = {}) {
  const prior = Number.isFinite(priorMean) ? Math.min(1, Math.max(0, priorMean)) : 0.5;
  const priorN = Number.isFinite(priorEffectiveN) && priorEffectiveN > 0 ? priorEffectiveN : 0;
  const n = Number.isFinite(realN) && realN > 0 ? realN : 0;
  const successes = Number.isFinite(realSuccesses) ? Math.min(n, Math.max(0, realSuccesses)) : 0;
  const alpha = 1 + prior * priorN + successes;
  const beta = 1 + (1 - prior) * priorN + (n - successes);
  const total = alpha + beta;
  const mean = alpha / total;
  const sd = Math.sqrt((alpha * beta) / (total * total * (total + 1)));
  return {
    method: 'beta_posterior_credible_bound',
    z,
    alpha: Number(alpha.toFixed(6)),
    beta: Number(beta.toFixed(6)),
    mean: Number(mean.toFixed(6)),
    sd: Number(sd.toFixed(6)),
    lower_bound: Number(Math.max(0, mean - z * sd).toFixed(6)),
    width: Number(Math.min(1, 2 * z * sd).toFixed(6))
  };
}

function defaultUncertainty(realN, effectiveN, posteriorMean, realSuccesses = null, priorMean = null) {
  const totalN = realN + effectiveN;
  const standardError = totalN > 0
    ? Math.sqrt(Math.max(0, posteriorMean * (1 - posteriorMean)) / totalN)
    : 0.5;
  return {
    method: 'binomial_standard_error',
    real_n: realN,
    effective_n: effectiveN,
    standard_error: Number(standardError.toFixed(6)),
    credible: Number.isFinite(realSuccesses) ? capabilityCredibleInterval({
      priorMean: Number.isFinite(priorMean) ? priorMean : posteriorMean,
      priorEffectiveN: effectiveN,
      realN,
      realSuccesses
    }) : undefined,
    status: realN === 0 ? 'untested' : 'measured'
  };
}

export function createCapabilityRecord({ route, taskClass, role, familyPrior = null, current = null } = {}) {
  if (!route?.route_id) throw new Error('Capability records require a concrete route_id');
  if (!TASK_CLASSES[taskClass]) throw new Error(`Unknown task class "${taskClass}"`);
  const priorMean = Number.isFinite(current?.prior_mean)
    ? current.prior_mean
    : (Number.isFinite(familyPrior?.prior_mean) ? familyPrior.prior_mean : 0.5);
  const priorEffectiveN = Number.isFinite(current?.prior_effective_n)
    ? current.prior_effective_n
    : (Number.isFinite(familyPrior?.prior_effective_n) ? familyPrior.prior_effective_n : 0);
  const realN = Number.isFinite(current?.real_n) ? current.real_n : 0;
  const realSuccesses = Number.isFinite(current?.real_successes) ? current.real_successes : 0;
  const posteriorDenominator = priorEffectiveN + realN;
  const posteriorMean = posteriorDenominator > 0
    ? (priorMean * priorEffectiveN + realSuccesses) / posteriorDenominator
    : priorMean;
  return {
    ...(current || {}),
    route_id: route.route_id,
    task_class: taskClass,
    role,
    model_family: route.model_family || null,
    model: routeModelName(route),
    harness: route.harness || null,
    provider: route.provider || route.provider_path || null,
    real_n: realN,
    real_successes: realSuccesses,
    deterministic_evaluations: Number.isFinite(current?.deterministic_evaluations) ? current.deterministic_evaluations : 0,
    deterministic_failures: Number.isFinite(current?.deterministic_failures) ? current.deterministic_failures : 0,
    prior_mean: priorMean,
    prior_effective_n: priorEffectiveN,
    posterior_mean: posteriorMean,
    promotion_eligible_real_n: current?.promotion_eligible_real_n || false,
    routing_status: current?.routing_status || 'BENCHMARK_ONLY',
    uncertainty: current?.uncertainty || defaultUncertainty(realN, priorEffectiveN, posteriorMean)
  };
}

export function updateCapabilityPosterior(record, criteria) {
  const posteriorDenominator = record.prior_effective_n + record.real_n;
  record.posterior_mean = posteriorDenominator > 0
    ? (record.prior_mean * record.prior_effective_n + record.real_successes) / posteriorDenominator
    : record.prior_mean;
  record.promotion_eligible_real_n = record.real_n >= criteria.minRealN;
  record.uncertainty = defaultUncertainty(record.real_n, record.prior_effective_n, record.posterior_mean, record.real_successes, record.prior_mean);
  return record;
}

export function capabilityEvidenceQualifies(record, criteria, taskClass) {
  if (!record || record.real_n < criteria.minRealN) return false;
  const successRate = record.real_successes / record.real_n;
  const definition = TASK_CLASSES[taskClass];
  const deterministicPassed = definition.deterministic.length === 0 || (
    record.deterministic_evaluations === record.real_n && record.deterministic_failures === 0
  );
  return record.real_successes >= criteria.minSuccessfulOutcomes &&
    successRate >= criteria.minSuccessRate &&
    deterministicPassed;
}

export function emptyLearnedRouting() {
  return { version: 4, route_capabilities: {}, model_family_priors: {} };
}

function candidateMatchesRoute(route, selector) {
  return route.route_id === selector ||
    routeModelName(route) === selector ||
    route.resolved_runtime_model === selector ||
    route.resolved_runtime_model === `opencode-go/${selector}` ||
    route.model_family === selector;
}

function ensureRouteBucket(learned, route) {
  learned.route_capabilities = learned.route_capabilities || {};
  const bucket = learned.route_capabilities[route.route_id] || {
    route: route.route_id,
    route_id: route.route_id,
    model_family: route.model_family || null,
    harness: route.harness || null,
    capabilities: {}
  };
  bucket.route = route.route_id;
  bucket.route_id = route.route_id;
  bucket.model_family = route.model_family || bucket.model_family || null;
  bucket.harness = route.harness || bucket.harness || null;
  bucket.capabilities = bucket.capabilities || {};
  learned.route_capabilities[route.route_id] = bucket;
  return bucket;
}

export function getCapabilityRecord(learned, route, taskClass) {
  return learned?.route_capabilities?.[route?.route_id]?.capabilities?.[taskClass] || null;
}

export function ensureCapabilityRecord(learned, route, taskClass, role) {
  const bucket = ensureRouteBucket(learned, route);
  const family = familyPriorKey(route);
  const familyPrior = family ? learned.model_family_priors?.[family]?.[taskClass] : null;
  bucket.capabilities[taskClass] = createCapabilityRecord({
    route,
    taskClass,
    role,
    familyPrior,
    current: bucket.capabilities[taskClass]
  });
  return bucket.capabilities[taskClass];
}

function migrateLegacyStatistics(learned, routes) {
  const legacy = learned.role_statistics;
  if (!legacy || typeof legacy !== 'object') return;
  for (const [role, candidates] of Object.entries(legacy)) {
    const taskClass = ROLE_TASK_CLASS[role];
    if (!taskClass || !candidates || typeof candidates !== 'object') continue;
    for (const [selector, stats] of Object.entries(candidates)) {
      const matches = routes.filter((route) => candidateMatchesRoute(route, selector));
      for (const route of matches) {
        const bucket = ensureRouteBucket(learned, route);
        if (bucket.capabilities[taskClass]) continue;
        const current = { ...stats };
        // Legacy family keys are prior information when they do not identify
        // one concrete route.  Only an explicit route_id can carry real_n.
        if (selector !== route.route_id) {
          delete current.real_n;
          delete current.real_successes;
          delete current.deterministic_evaluations;
          delete current.deterministic_failures;
          delete current.promotion_eligible_real_n;
          current.routing_status = 'BENCHMARK_ONLY';
        }
        bucket.capabilities[taskClass] = createCapabilityRecord({ route, taskClass, role, current });
      }
    }
  }
  delete learned.role_statistics;
}

export function normalizeLearnedRouting(input, routes = []) {
  const learned = input && typeof input === 'object' ? input : emptyLearnedRouting();
  learned.version = 4;
  learned.route_capabilities = learned.route_capabilities || {};
  learned.model_family_priors = learned.model_family_priors || {};
  migrateLegacyStatistics(learned, routes);
  rebuildModelFamilyPriors(learned, routes);
  return learned;
}

export function rebuildModelFamilyPriors(learned, routes = []) {
  const aggregates = {};
  for (const route of routes) {
    const family = familyPriorKey(route);
    if (!family) continue;
    const capabilities = learned.route_capabilities?.[route.route_id]?.capabilities || {};
    for (const [taskClass, record] of Object.entries(capabilities)) {
      if (!TASK_CLASSES[taskClass] || !Number.isFinite(record.real_n) || record.real_n <= 0) continue;
      const aggregate = aggregates[family]?.[taskClass] || {
        real_n: 0,
        real_successes: 0,
        route_ids: new Set()
      };
      aggregate.real_n += record.real_n;
      aggregate.real_successes += Number.isFinite(record.real_successes) ? record.real_successes : 0;
      aggregate.route_ids.add(route.route_id);
      aggregates[family] = { ...(aggregates[family] || {}), [taskClass]: aggregate };
    }
  }

  const priors = {};
  for (const [family, taskRecords] of Object.entries(aggregates)) {
    priors[family] = {};
    for (const [taskClass, aggregate] of Object.entries(taskRecords)) {
      const priorMean = aggregate.real_successes / aggregate.real_n;
      const prior = {
        model_family: family,
        task_class: taskClass,
        prior_mean: priorMean,
        prior_effective_n: aggregate.real_n,
        source_real_n: aggregate.real_n,
        source_route_count: aggregate.route_ids.size,
        uncertainty: defaultUncertainty(0, aggregate.real_n, priorMean)
      };
      priors[family][taskClass] = prior;
    }
  }
  learned.model_family_priors = priors;
  return priors;
}
