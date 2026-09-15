import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRouterFixtureHome } from './router-v2-fixture.mjs';

const home = makeRouterFixtureHome();
const evaluator = await import('../bin/fm-routing-eval.mjs');
const capabilityModel = await import('../bin/fm-routing-capability.mjs');

assert.deepEqual(Object.keys(evaluator.TASK_CLASSES), [
  'targeted_edit',
  'mechanical_tool_work',
  'test_generation',
  'refactor',
  'multi_file_feature',
  'brownfield_debugging',
  'large_context_repository_retrieval',
  'long_horizon_autonomous_engineering',
  'architecture_reasoning',
  'critical_audit'
]);

const routesPath = path.join(home, 'data/provider-catalogs/compiled-route-targets.json');
const learnedPath = path.join(home, 'data/learned-routing.json');
const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
routes.push({
  route_id: 'opencode:omen-alpha',
  model_family: 'omen-alpha',
  logical_alias: 'omen-alpha',
  resolved_runtime_model: 'opencode-go/omen-alpha',
  harness: 'opencode',
  routing_status: 'BENCHMARK_ONLY',
  availability: 'available',
  data_profile: 'opencode_go',
  quota_pool: 'opencode_go'
});
for (const route of [
  {
    route_id: 'opencode:omen-zero',
    model_family: 'omen-zero',
    logical_alias: 'omen-zero',
    resolved_runtime_model: 'opencode-go/omen-zero',
    harness: 'opencode',
    routing_status: 'BENCHMARK_ONLY',
    availability: 'available',
    data_profile: 'opencode_go',
    quota_pool: 'opencode_go'
  },
  {
    route_id: 'opencode:omen-one',
    model_family: 'omen-one',
    logical_alias: 'omen-one',
    resolved_runtime_model: 'opencode-go/omen-one',
    harness: 'opencode',
    routing_status: 'BENCHMARK_ONLY',
    availability: 'available',
    data_profile: 'opencode_go',
    quota_pool: 'opencode_go'
  },
  {
    route_id: 'opencode:omen-conflict',
    model_family: 'omen-conflict',
    logical_alias: 'omen-conflict',
    resolved_runtime_model: 'opencode-go/omen-conflict',
    harness: 'opencode',
    routing_status: 'BENCHMARK_ONLY',
    availability: 'available',
    data_profile: 'opencode_go',
    quota_pool: 'opencode_go'
  },
  {
    route_id: 'codex:shared-luna',
    model_family: 'shared-luna',
    logical_alias: 'shared-luna-codex',
    resolved_runtime_model: 'shared-luna-codex',
    harness: 'codex',
    routing_status: 'BENCHMARK_ONLY',
    availability: 'available',
    data_profile: 'codex_consumer',
    quota_pool: 'codex_plus'
  },
  {
    route_id: 'opencode:shared-luna',
    model_family: 'shared-luna',
    logical_alias: 'shared-luna-opencode',
    resolved_runtime_model: 'opencode-go/shared-luna',
    harness: 'opencode',
    routing_status: 'BENCHMARK_ONLY',
    availability: 'available',
    data_profile: 'opencode_go',
    quota_pool: 'opencode_go'
  }
]) routes.push(route);
fs.writeFileSync(routesPath, JSON.stringify(routes, null, 2));

function prepareChallenger(routeId) {
  let current = evaluator.smokeCandidate({ routeId, taskClass: 'targeted_edit', task_completed: true });
  current = evaluator.cheapEvaluateCandidate({
    routeId,
    taskClass: 'targeted_edit',
    tests_pass: true,
    task_completed: true
  });
  current = evaluator.enterChallenger({ routeId, taskClass: 'targeted_edit', dataClass: 'PUBLIC', retryTolerant: true });
  assert.equal(current.policy.rate, 0.18);
  return current;
}

let result = evaluator.smokeCandidate({ model: 'omen-alpha', taskClass: 'targeted_edit', task_completed: true });
assert.equal(result.route.routing_status, 'SMOKE');
result = evaluator.cheapEvaluateCandidate({
  model: 'omen-alpha',
  taskClass: 'targeted_edit',
  tests_pass: true,
  task_completed: true
});
assert.equal(result.route.routing_status, 'CHEAP_EVAL');
result = evaluator.enterChallenger({ model: 'omen-alpha', taskClass: 'targeted_edit', dataClass: 'PUBLIC', retryTolerant: true });
assert.equal(result.route.routing_status, 'CHALLENGER');
assert.equal(result.policy.rate, 0.18);

const refusedRisk = evaluator.recordRealTraffic({
  model: 'omen-alpha', taskClass: 'targeted_edit', dataClass: 'PERSONAL_SENSITIVE', retryTolerant: true,
  success: true
});
assert.equal(refusedRisk.promoted, false);
assert.match(refusedRisk.refusal.reasons.join(','), /not eligible for automatic exploration/);

const beforeLearned = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
const prior = beforeLearned.route_capabilities?.['opencode:omen-alpha']?.capabilities?.targeted_edit;
assert.equal(prior.real_n, 0);
assert.equal(prior.routing_status, 'CHALLENGER');
assert.equal(prior.uncertainty.status, 'untested');
for (let index = 0; index < 14; index += 1) {
  result = evaluator.recordRealTraffic({
    model: 'omen-alpha', taskClass: 'targeted_edit', dataClass: 'PUBLIC', retryTolerant: true,
    success: true, tests_pass: true, task_completed: true
  });
}
assert.equal(result.route.routing_status, 'LOW_RISK_REAL_TRAFFIC');
assert.equal(result.stats.real_n, 14);
assert.equal(result.promoted, false);
assert.equal(result.promotionGate.required_real_n, 15);
assert.equal(result.promotionGate.real_n, 14);
assert.equal(result.promotionGate.real_successes, 14);
assert.equal(result.promotionGate.minimum_success_rate, 0.8);
assert.equal(result.promotionGate.deterministic_evidence_passed, true);
assert.equal(result.promotionGate.passed, false);
assert.equal(result.policy.rate, 0.18);

result = evaluator.recordRealTraffic({
  model: 'omen-alpha', taskClass: 'targeted_edit', dataClass: 'PUBLIC', retryTolerant: true,
  success: true, tests_pass: true, task_completed: true
});
assert.equal(result.stats.real_n, 15);
assert.equal(result.stats.real_successes, 15);
assert.equal(result.route.routing_status, 'ROUTING_ELIGIBLE');
assert.equal(result.promoted, true);
assert.equal(result.promotionGate.required_real_n, 15);
assert.equal(result.promotionGate.minimum_successful_outcomes, 12);
assert.equal(result.promotionGate.success_rate, 1);
assert.equal(result.promotionGate.deterministic_evidence_passed, true);
assert.equal(result.promotionGate.passed, true);
assert.equal(result.policy.rate, 0.05);

const finalRoutes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
assert.equal(finalRoutes.find((route) => route.route_id === 'opencode:omen-alpha').routing_status, 'BENCHMARK_ONLY');
const finalLearned = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
const stats = finalLearned.route_capabilities['opencode:omen-alpha'].capabilities.targeted_edit;
assert.equal(stats.real_n, 15);
assert.equal(stats.promotion_eligible_real_n, true);
assert.equal(stats.prior_effective_n, 0);
assert.equal(stats.route_id, 'opencode:omen-alpha');
const finalRegistry = JSON.parse(fs.readFileSync(path.join(home, 'config/model-registry.json'), 'utf8'));
assert.equal(finalRegistry.models['omen-alpha'].harness, 'opencode');
assert.ok(finalRegistry.roles.fast_precise.challengers.includes('omen-alpha'));

const events = fs.readFileSync(path.join(home, 'data/routing-evaluations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
assert.ok(events.some((event) => event.stage === 'SMOKE' && event.outcome === 'pass'));
assert.ok(events.some((event) => event.outcome === 'refused' && event.refusal?.reasons));

const deterministic = evaluator.TASK_CLASSES.brownfield_debugging;
assert.deepEqual(deterministic.deterministic, ['bug_reproduced', 'regression_tests_added', 'tests_pass', 'task_completed']);
const policyBlocked = evaluator.explorationPolicy({
  stage: 'CHALLENGER',
  realN: 0,
  dataClass: 'PERSONAL_SENSITIVE',
  routeProfile: 'opencode_go',
  resolvedRuntimeModel: 'opencode-go/qwen3.7-max',
  retryTolerant: true
});
assert.equal(policyBlocked.rate, 0);
const policySteady = evaluator.explorationPolicy({
  stage: 'ROUTING_ELIGIBLE',
  realN: 15,
  dataClass: 'PUBLIC',
  routeProfile: 'opencode_go',
  resolvedRuntimeModel: 'opencode-go/omen-alpha',
  retryTolerant: true
});
assert.equal(policySteady.rate, 0.05);
const assignment = evaluator.isExplorationAssignment({
  stage: 'CHALLENGER',
  realN: 0,
  dataClass: 'PRIVATE_CODE',
  routeProfile: 'opencode_go',
  resolvedRuntimeModel: 'opencode-go/omen-alpha',
  retryTolerant: true,
  random: 0.17
});
assert.equal(assignment.assigned, true);

console.log('--- Adversarial promotion and RouteTarget isolation ---');
prepareChallenger('opencode:omen-conflict');
const conflictingSignals = evaluator.recordRealTraffic({
  routeId: 'opencode:omen-conflict',
  taskClass: 'targeted_edit',
  dataClass: 'PUBLIC',
  retryTolerant: true,
  success: true,
  tests_pass: false,
  task_completed: true
});
assert.equal(conflictingSignals.stats.real_successes, 0);
assert.equal(conflictingSignals.event.outcome, 'fail');

for (const [routeId, successfulAttempts] of [['opencode:omen-zero', 0], ['opencode:omen-one', 1]]) {
  prepareChallenger(routeId);
  let last;
  for (let index = 0; index < 15; index += 1) {
    const passed = index >= 15 - successfulAttempts;
    last = evaluator.recordRealTraffic({
      routeId,
      taskClass: 'targeted_edit',
      dataClass: 'PUBLIC',
      retryTolerant: true,
      tests_pass: passed,
      task_completed: true
    });
  }
  assert.equal(last.stats.real_n, 15);
  assert.equal(last.stats.real_successes, successfulAttempts);
  assert.equal(last.promoted, false, `${routeId} must not promote with ${successfulAttempts}/15 successes`);
  assert.notEqual(last.route.routing_status, 'ROUTING_ELIGIBLE');
  assert.equal(last.promotionGate.passed, false);
}

prepareChallenger('codex:shared-luna');
for (let index = 0; index < 15; index += 1) {
  result = evaluator.recordRealTraffic({
    routeId: 'codex:shared-luna',
    taskClass: 'targeted_edit',
    dataClass: 'PUBLIC',
    retryTolerant: true,
    tests_pass: true,
    task_completed: true
  });
}
assert.equal(result.route.routing_status, 'ROUTING_ELIGIBLE');
const isolatedRoutes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
assert.equal(isolatedRoutes.find((route) => route.route_id === 'codex:shared-luna').routing_status, 'BENCHMARK_ONLY');
assert.equal(isolatedRoutes.find((route) => route.route_id === 'opencode:shared-luna').routing_status, 'BENCHMARK_ONLY');
const isolatedLearned = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
assert.equal(isolatedLearned.route_capabilities['codex:shared-luna'].capabilities.targeted_edit.real_n, 15);
assert.equal(isolatedLearned.route_capabilities['opencode:shared-luna'], undefined);
const isolatedStatus = evaluator.status({ routeId: 'codex:shared-luna' })[0];
assert.equal(isolatedStatus.capabilities.targeted_edit.route_id, 'codex:shared-luna');
assert.equal(isolatedStatus.capabilities.targeted_edit.routing_status, 'ROUTING_ELIGIBLE');
assert.equal(isolatedStatus.capabilities.test_generation, undefined);
assert.equal(evaluator.status({ routeId: 'opencode:shared-luna' })[0].capabilities.targeted_edit, undefined);

const familyRoutes = [
  { route_id: 'opencode:family-alpha', model_family: 'family-alpha', harness: 'opencode' },
  { route_id: 'otherharness:family-alpha', model_family: 'family-alpha', harness: 'otherharness' },
  { route_id: 'opencode:deepseek-v4-flash', model_family: 'deepseek-v4-flash', harness: 'opencode' }
];
const familyLearned = {
  version: 4,
  route_capabilities: {
    'opencode:family-alpha': {
      route_id: 'opencode:family-alpha',
      capabilities: { targeted_edit: { real_n: 3, real_successes: 2 } }
    },
    'otherharness:family-alpha': {
      route_id: 'otherharness:family-alpha',
      capabilities: { targeted_edit: { real_n: 5, real_successes: 4 } }
    },
    'opencode:deepseek-v4-flash': {
      route_id: 'opencode:deepseek-v4-flash',
      capabilities: { targeted_edit: { real_n: 15, real_successes: 15 } }
    }
  }
};
const familyPriors = capabilityModel.rebuildModelFamilyPriors(familyLearned, familyRoutes);
assert.equal(familyPriors['family-alpha'].targeted_edit.source_route_count, 2);
assert.equal(familyPriors['family-alpha'].targeted_edit.source_real_n, 8);
assert.equal(familyPriors['family-alpha'].targeted_edit.prior_mean, 0.75);
assert.equal(familyPriors['deepseek-v4-flash'], undefined,
  'unresolved DeepSeek V4 aliases must not be naively aggregated');
const futureCapability = capabilityModel.ensureCapabilityRecord(familyLearned, {
  route_id: 'futureharness:family-alpha', model_family: 'family-alpha', harness: 'futureharness'
}, 'targeted_edit', 'fast_precise');
assert.equal(futureCapability.prior_mean, 0.75);
assert.equal(futureCapability.real_n, 0);
assert.equal(futureCapability.routing_status, 'BENCHMARK_ONLY');
assert.equal(capabilityModel.capabilityEvidenceQualifies(null, { minRealN: 1, minSuccessfulOutcomes: 1, minSuccessRate: 0.5 }, 'targeted_edit'), false,
  'a family prior without a route record cannot promote a new RouteTarget');

console.log('Routing evaluation lifecycle, promotion gate, deterministic evidence, and exploration policy passed');
