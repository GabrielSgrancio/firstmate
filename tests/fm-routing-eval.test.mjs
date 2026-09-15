import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRouterFixtureHome } from './router-v2-fixture.mjs';

const home = makeRouterFixtureHome();
const evaluator = await import('../bin/fm-routing-eval.mjs');

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
fs.writeFileSync(routesPath, JSON.stringify(routes, null, 2));

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
  model: 'omen-alpha', taskClass: 'targeted_edit', dataClass: 'WORK_CORPORATE', retryTolerant: true,
  success: true
});
assert.equal(refusedRisk.promoted, false);
assert.match(refusedRisk.refusal.reasons.join(','), /PUBLIC/);

const beforeLearned = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
const prior = beforeLearned.role_statistics.fast_precise['omen-alpha'];
assert.equal(prior, undefined);
for (let index = 0; index < 14; index += 1) {
  result = evaluator.recordRealTraffic({
    model: 'omen-alpha', taskClass: 'targeted_edit', dataClass: 'PUBLIC', retryTolerant: true,
    success: true, tests_pass: true, task_completed: true
  });
}
assert.equal(result.route.routing_status, 'LOW_RISK_REAL_TRAFFIC');
assert.equal(result.stats.real_n, 14);
assert.equal(result.promoted, false);
assert.deepEqual(result.promotionGate, { required_real_n: 15, real_n: 14, passed: false });
assert.equal(result.policy.rate, 0.18);

result = evaluator.recordRealTraffic({
  model: 'omen-alpha', taskClass: 'targeted_edit', dataClass: 'PUBLIC', retryTolerant: true,
  success: true, tests_pass: true, task_completed: true
});
assert.equal(result.stats.real_n, 15);
assert.equal(result.stats.real_successes, 15);
assert.equal(result.route.routing_status, 'ROUTING_ELIGIBLE');
assert.equal(result.promoted, true);
assert.deepEqual(result.promotionGate, { required_real_n: 15, real_n: 15, passed: true });
assert.equal(result.policy.rate, 0.05);

const finalRoutes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
assert.equal(finalRoutes.find((route) => route.route_id === 'opencode:omen-alpha').routing_status, 'ROUTING_ELIGIBLE');
const finalLearned = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
const stats = finalLearned.role_statistics.fast_precise['omen-alpha'];
assert.equal(stats.real_n, 15);
assert.equal(stats.promotion_eligible_real_n, true);
assert.equal(stats.prior_effective_n, 0);
const finalRegistry = JSON.parse(fs.readFileSync(path.join(home, 'config/model-registry.json'), 'utf8'));
assert.equal(finalRegistry.models['omen-alpha'].harness, 'opencode');
assert.ok(finalRegistry.roles.fast_precise.challengers.includes('omen-alpha'));

const events = fs.readFileSync(path.join(home, 'data/routing-evaluations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
assert.ok(events.some((event) => event.stage === 'SMOKE' && event.outcome === 'pass'));
assert.ok(events.some((event) => event.outcome === 'refused' && event.refusal?.reasons));

const deterministic = evaluator.TASK_CLASSES.brownfield_debugging;
assert.deepEqual(deterministic.deterministic, ['bug_reproduced', 'regression_tests_added', 'tests_pass', 'task_completed']);
const policyBlocked = evaluator.explorationPolicy({ stage: 'CHALLENGER', realN: 0, dataClass: 'PERSONAL_PRIVATE', retryTolerant: true });
assert.equal(policyBlocked.rate, 0);
const policySteady = evaluator.explorationPolicy({ stage: 'ROUTING_ELIGIBLE', realN: 15, dataClass: 'PUBLIC', retryTolerant: true });
assert.equal(policySteady.rate, 0.05);
const assignment = evaluator.isExplorationAssignment({ stage: 'CHALLENGER', realN: 0, dataClass: 'PUBLIC', retryTolerant: true, random: 0.17 });
assert.equal(assignment.assigned, true);
console.log('Routing evaluation lifecycle, promotion gate, deterministic evidence, and exploration policy passed');
