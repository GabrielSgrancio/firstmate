// Router V3 Model Intelligence: open fleet candidate generation, Model
// Intelligence as the semantic quality source, route validation, failure
// attribution, capability anomalies, Stage C retry precision, and the
// discovery-never-erases-knowledge regression.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRouterFixtureHome } from './router-v2-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MI_FIXTURES = path.join(HERE, 'fixtures', 'model-intelligence');
const home = makeRouterFixtureHome();
const router = await import('../bin/fm-router-v2.mjs');
const intel = await import('../bin/fm-model-intelligence.mjs');
const economics = await import('../bin/fm-routing-economics.mjs');
const evaluator = await import('../bin/fm-routing-eval.mjs');
const discovery = await import('../bin/fm-provider-discovery.mjs');

const routesPath = path.join(home, 'data/provider-catalogs/compiled-route-targets.json');
const learnedPath = path.join(home, 'data/learned-routing.json');
const miDir = path.join(home, 'data/model-intelligence');
const miPath = path.join(miDir, 'model-intelligence.json');
const validationPath = path.join(miDir, 'route-validation.json');

const synthetic = (name, overrides = {}) => ({
  route_id: `opencode:${name}`,
  model_family: name,
  logical_alias: name,
  raw_id: name,
  resolved_runtime_model: `opencode-go/${name}`,
  harness: 'opencode',
  provider_path: 'opencode_go_gateway',
  reasoning_effort: null,
  quota_pool: 'opencode_go',
  expected_normalized_burn: 1,
  data_profile: 'opencode_go',
  // Historical lifecycle status: it must not decide usability.
  routing_status: 'BENCHMARK_ONLY',
  availability: 'available',
  ...overrides
});
const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
routes.push(
  synthetic('synthetic-frontier-coder'),
  synthetic('synthetic-frontier-coder-legacy-alias'),
  synthetic('synthetic-weak-coder'),
  synthetic('synthetic-unsourced-coder'),
  synthetic('synthetic-broken-tools'),
  synthetic('synthetic-unhealthy'),
  synthetic('synthetic-auth', { availability: 'auth_required' }),
  synthetic('synthetic-stale', { availability: 'stale_catalog' }),
  synthetic('synthetic-credits', { quota_pool: 'opencode_zen_credits' }),
  synthetic('synthetic-payg', { spend_policy: 'PAYG' })
);
fs.writeFileSync(routesPath, JSON.stringify(routes, null, 2));

const decide = (overrides = {}) => router.scoreAndSelectRoute({
  role: 'general_engineer',
  taskClass: 'refactor',
  dataClass: 'PUBLIC',
  useLiveAxi: false,
  telemetryRecords: [],
  ...overrides
});

// --- Before: no Model Intelligence file (legacy evidence chain) ---
const before = decide();
assert.equal(before.modelIntelligence.mode, 'legacy_capability_evidence');
const beforeFrontier = before.rejectedRoutes.find((entry) => entry.route_id === 'opencode:synthetic-frontier-coder');
assert.equal(beforeFrontier.stage, 'B_quality_floor');
assert.equal(beforeFrontier.quality, 0.5);
assert.equal(beforeFrontier.quality_source, 'untested');
console.log(`before: synthetic-frontier-coder refactor quality=${beforeFrontier.quality} source=${beforeFrontier.quality_source} -> ${beforeFrontier.reason}`);

// Hard blockers are the only candidate-generation rejections.
const hardRejected = Object.fromEntries(before.rejectedRoutes
  .filter((entry) => entry.stage === 'candidate_generation')
  .map((entry) => [entry.route_id, entry.reason]));
assert.match(hardRejected['opencode:synthetic-auth'], /availability AUTH_REQUIRED/);
assert.match(hardRejected['opencode:synthetic-stale'], /availability STALE/);
assert.match(hardRejected['opencode:synthetic-credits'], /spend policy CREDIT_GATED/);
assert.match(hardRejected['opencode:synthetic-payg'], /spend policy PAYG/);
assert.match(hardRejected['claude:claude-fable-5-1:high'], /spend policy CREDIT_GATED/);
for (const routeId of Object.keys(hardRejected)) {
  assert.doesNotMatch(hardRejected[routeId], /BENCHMARK_ONLY|real_n|ROUTING_ELIGIBLE|CHALLENGER/);
}
assert.ok(!hardRejected['opencode:synthetic-weak-coder'], 'a BENCHMARK_ONLY baseline route with no evidence is a candidate');

// --- After: Model Intelligence and route validation installed ---
fs.mkdirSync(miDir, { recursive: true });
fs.copyFileSync(path.join(MI_FIXTURES, 'model-intelligence.json'), miPath);
fs.copyFileSync(path.join(MI_FIXTURES, 'route-validation.json'), validationPath);

// Production outcomes must not move the Model Intelligence judgment.
const learned = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
learned.route_capabilities['opencode:synthetic-frontier-coder'] = {
  route_id: 'opencode:synthetic-frontier-coder',
  capabilities: {
    refactor: { route_id: 'opencode:synthetic-frontier-coder', task_class: 'refactor', real_n: 15, real_successes: 0, prior_mean: 0.5, prior_effective_n: 0, posterior_mean: 0.01, routing_status: 'BENCHMARK_ONLY' }
  }
};
fs.writeFileSync(learnedPath, JSON.stringify(learned, null, 2));

const after = decide();
assert.equal(after.modelIntelligence.mode, 'model_intelligence');
assert.deepEqual(after.modelIntelligence.errors, []);
const afterFrontier = after.allCandidates.find((candidate) => candidate.route_id === 'opencode:synthetic-frontier-coder');
assert.ok(afterFrontier, 'a well-documented, never-used model competes immediately');
assert.equal(afterFrontier.quality, intel.CLASS_QUALITY_PRIOR.FRONTIER);
assert.equal(afterFrontier.quality_source, 'model_intelligence');
assert.equal(afterFrontier.capability_class, 'FRONTIER');
assert.equal(afterFrontier.candidate_basis, 'model_intelligence');
assert.equal(afterFrontier.route_state.availability, 'AVAILABLE');
assert.equal(afterFrontier.route_state.spend_policy, 'BASELINE_SUBSCRIPTION');
assert.equal(afterFrontier.route_state.validation, 'VALIDATED');
console.log(`after: synthetic-frontier-coder refactor quality=${afterFrontier.quality} source=${afterFrontier.quality_source} class=${afterFrontier.capability_class} (15 recorded production failures ignored)`);

// An alias shares the backing model's single dataset.
const alias = after.allCandidates.find((candidate) => candidate.route_id === 'opencode:synthetic-frontier-coder-legacy-alias');
assert.equal(alias.capability_class, 'FRONTIER');
assert.equal(alias.route_state.validation, 'UNKNOWN', 'route validation stays route-specific');

const weak = after.rejectedRoutes.find((entry) => entry.route_id === 'opencode:synthetic-weak-coder');
assert.equal(weak.quality, intel.CLASS_QUALITY_PRIOR.WEAK);
const unsourced = after.rejectedRoutes.find((entry) => entry.route_id === 'opencode:synthetic-unsourced-coder');
assert.equal(unsourced.quality_source, 'model_intelligence_unknown');
assert.match(unsourced.reason, /missing provenance field source_type/);
// With Model Intelligence present, an uncovered fleet route is UNKNOWN, not its legacy posterior.
const terra = after.rejectedRoutes.find((entry) => entry.route_id === 'codex:gpt-5.6-terra:medium');
assert.equal(terra.quality_source, 'model_intelligence_unknown');

// Low-risk uncertainty tolerance: unknown routes may compete for retry-tolerant work; a confident WEAK may not.
const tolerant = decide({ retryTolerant: true });
const tolerantIds = tolerant.allCandidates.map((candidate) => candidate.route_id);
assert.ok(tolerantIds.includes('opencode:synthetic-unsourced-coder'));
assert.ok(tolerantIds.includes('codex:gpt-5.6-terra:medium'));
assert.ok(!tolerantIds.includes('opencode:synthetic-weak-coder'), 'HIGH-confidence WEAK stays below the floor');
assert.equal(tolerant.allCandidates.find((c) => c.route_id === 'codex:gpt-5.6-terra:medium').admitted_by, 'low_risk_uncertainty_tolerance');

// Route validation FAILED is a hard incompatibility for the task classes that need that capability only.
const editDecision = decide({ role: 'fast_precise', taskClass: 'targeted_edit', retryTolerant: true });
assert.match(editDecision.rejectedRoutes.find((entry) => entry.route_id === 'opencode:synthetic-broken-tools').reason, /route validation FAILED for tool_use/);
assert.match(editDecision.rejectedRoutes.find((entry) => entry.route_id === 'opencode:synthetic-unhealthy').reason, /operational health UNHEALTHY/);
const architecture = router.queryCapabilityCandidates({
  role: 'architect_synthesizer', taskClass: 'architecture_reasoning', dataClass: 'PUBLIC',
  ...router.loadConfigs()
});
assert.ok(architecture.candidates.some(({ route }) => route.route_id === 'opencode:synthetic-broken-tools'),
  'a tool_use failure does not block a text-only task class');

// Critical work needs HIGH-confidence intelligence on a VALIDATED route.
const critical = decide({ role: 'critical_auditor', taskClass: 'critical_audit', critical: true });
assert.equal(critical.selectedRoute.route_id, 'opencode:synthetic-frontier-coder');
const criticalAlias = critical.rejectedRoutes.find((entry) => entry.route_id === 'opencode:synthetic-frontier-coder-legacy-alias');
assert.match(criticalAlias.reason, /VALIDATED route/);

// Loader rules.
const nowMs = Date.parse('2026-09-15T00:00:00Z');
assert.equal(intel.normalizeAssertion({ class: 'STRONG', confidence: 'HIGH', provenance: [] }, nowMs).usable, false);
const miDoc = JSON.parse(fs.readFileSync(miPath, 'utf8'));
const futureAssertion = structuredClone(miDoc.models['synthetic-weak-coder'].capabilities.refactor);
futureAssertion.provenance[0].effective_from = '2027-01-01T00:00:00Z';
assert.match(intel.normalizeAssertion(futureAssertion, nowMs).problems.join(';'), /not yet effective/);
assert.equal(intel.resolveTaskFit({ models: miDoc.models }, synthetic('synthetic-unsourced-coder'), 'targeted_edit', new Date(nowMs)).usable, false,
  'an expired assertion reads as UNKNOWN');
const corruptHome = fs.mkdtempSync(path.join(path.dirname(home), 'mi-corrupt-'));
fs.mkdirSync(path.join(corruptHome, 'data/model-intelligence'), { recursive: true });
fs.writeFileSync(path.join(corruptHome, 'data/model-intelligence/model-intelligence.json'), '{not json');
const corrupt = intel.loadModelIntelligence({ home: corruptHome });
assert.equal(corrupt.present, false);
assert.equal(corrupt.errors.length, 1);

// Seed priors become a derived artifact of Model Intelligence.
const { ROLE_TASK_CLASS } = await import('../bin/fm-routing-capability.mjs');
const derived = intel.derivePriorsFromModelIntelligence({ models: miDoc.models }, routes, { roleTaskClass: ROLE_TASK_CLASS, now: new Date(nowMs) });
assert.equal(derived.priors['synthetic-frontier-coder'].harness, 'opencode');
assert.equal(derived.priors['synthetic-frontier-coder'].prior_mean, intel.CLASS_QUALITY_PRIOR.FRONTIER);
assert.ok(derived.priors['synthetic-frontier-coder'].recommended_roles.includes('general_engineer'));
assert.equal(derived.priors['synthetic-weak-coder'].recommended_roles.length, 0);

// --- DeepSeek Alias Resolution Regression ---
const deepseekRoute = synthetic('deepseek-v4.1-flash', { resolved_backing_model: null, resolved_runtime_model: 'deepseek-v4.1-flash' });
const deepseekMiModels = {
  'DeepSeek-V4.1-Flash': {
    aliases: ['deepseek-v4.1-flash'],
    model_version: 'deepseek-v4-flash',
    capabilities: { refactor: structuredClone(miDoc.models['synthetic-frontier-coder'].capabilities.refactor) }
  }
};
const deepseekFit = intel.resolveTaskFit({ models: deepseekMiModels }, deepseekRoute, 'refactor', new Date(nowMs));
assert.equal(deepseekFit.usable, true);
assert.equal(deepseekFit.class, 'FRONTIER');
console.log('DeepSeek alias resolution regression test passed');

// --- Failure attribution and capability anomalies ---
const learnedBeforeOutcomes = fs.readFileSync(learnedPath, 'utf8');
const miBeforeOutcomes = fs.readFileSync(miPath, 'utf8');
const failure = (attribution) => evaluator.recordRealTraffic({
  routeId: 'opencode:synthetic-frontier-coder', taskClass: 'targeted_edit', dataClass: 'PUBLIC',
  tests_pass: false, task_completed: false, ...(attribution ? { attribution } : {})
});
for (const attribution of ['TASK_SPEC', 'PROMPT', 'QUOTA', 'PROVIDER', 'HARNESS']) {
  const explained = failure(attribution);
  assert.equal(explained.capabilityMutated, false);
  assert.equal(explained.anomaly, null, `${attribution} failures do not form a capability anomaly`);
}
assert.equal(failure(null).anomaly, null);
assert.equal(failure(null).anomaly, null);
const third = failure(null);
assert.ok(third.anomaly, 'three unexplained failures against STRONG intelligence raise an anomaly');
assert.equal(third.anomaly.type, 'CAPABILITY_ANOMALY');
assert.equal(third.anomaly.declared_class, 'STRONG');
assert.equal(third.anomaly.capability_changed, false);
assert.equal(third.anomaly.unexplained_failures, 3);
assert.equal(third.event.attribution, 'AMBIGUOUS');
assert.equal(fs.readFileSync(miPath, 'utf8'), miBeforeOutcomes, 'an anomaly never rewrites Model Intelligence');
const anomalies = fs.readFileSync(path.join(miDir, 'capability-anomalies.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(anomalies.length, 1);
console.log(`anomaly: ${JSON.stringify({ route: anomalies[0].route_id, task_class: anomalies[0].task_class, declared: anomalies[0].declared_class, failures: anomalies[0].unexplained_failures })}`);
const learnedAfterOutcomes = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
assert.equal(learnedAfterOutcomes.route_capabilities['opencode:synthetic-frontier-coder'].capabilities.targeted_edit?.real_n ?? 0, 0,
  'unattributed and excused production failures leave capability evidence untouched');
assert.equal(
  JSON.stringify(learnedAfterOutcomes.route_capabilities['opencode:synthetic-frontier-coder'].capabilities.refactor),
  JSON.stringify(JSON.parse(learnedBeforeOutcomes).route_capabilities['opencode:synthetic-frontier-coder'].capabilities.refactor)
);

// HARNESS attribution feeds route validation, as a WARNING that does not block.
const harness = evaluator.recordRealTraffic({
  routeId: 'opencode:synthetic-weak-coder', taskClass: 'targeted_edit', dataClass: 'PUBLIC',
  tests_pass: false, task_completed: false, attribution: 'HARNESS', capability: 'tool_use', note: 'tool schema mismatch'
});
assert.deepEqual(harness.routeValidationEffect, { capability: 'tool_use', status: 'WARNING' });
const validationAfter = JSON.parse(fs.readFileSync(validationPath, 'utf8'));
assert.equal(validationAfter.routes['opencode:synthetic-weak-coder'].capabilities.tool_use.status, 'WARNING');
assert.equal(validationAfter.routes['opencode:synthetic-frontier-coder'].capabilities.tool_use.status, 'VALIDATED');
assert.ok(!decide({ role: 'fast_precise', taskClass: 'targeted_edit', retryTolerant: true }).rejectedRoutes
  .some((entry) => entry.route_id === 'opencode:synthetic-weak-coder' && entry.stage === 'candidate_generation'));

// --- Stage C: retry probability is shrunk, and excused failures are not route failures ---
const frontierRoute = routes.find((route) => route.route_id === 'opencode:synthetic-frontier-coder');
const telemetry = (attribution) => [
  { route_execution_id: 'x1', dispatch_status: 'started', selected_route_id: frontierRoute.route_id, started_at: '2026-09-15T00:00:00Z' },
  { route_execution_id: 'x1', dispatch_status: 'completed', terminal_state: 'FAILED', failure_attribution: attribution, completed_at: '2026-09-15T00:10:00Z' }
];
const pools = economics.buildPoolEconomics({ pools: { opencode_go: { status: 'HEALTHY', windows: { weekly: { percent_remaining: 80 } } } }, now: new Date('2026-09-15T01:00:00Z') });
const routeEconomics = (records, operationalHealth = null) => economics.buildRouteEconomics({
  route: frontierRoute,
  poolEconomics: pools,
  observations: economics.collectRoutingObservations(records, [frontierRoute], new Date('2026-09-15T01:00:00Z')),
  successProbability: 0.88,
  operationalHealth
});
const oneProviderFailure = routeEconomics(telemetry('PROVIDER'));
assert.equal(oneProviderFailure.retry_probability, Number(((1 + 3 * 0.12) / 4).toFixed(6)),
  'one failure moves retry probability a bounded step, not to 1.0');
assert.equal(routeEconomics(telemetry('TASK_SPEC')).retry_probability, routeEconomics([]).retry_probability,
  'a TASK_SPEC failure is not a route failure');
assert.ok(routeEconomics(telemetry(undefined)).retry_probability > routeEconomics([]).retry_probability,
  'a legacy unattributed failure still counts as AMBIGUOUS operational telemetry');
assert.equal(routeEconomics([], 'DEGRADED').route_health, 0.5);
assert.equal(oneProviderFailure.expected_successful_quota_burn, Number((1 / 0.88).toFixed(6)));
console.log(`stage C: one PROVIDER failure retry_probability=${oneProviderFailure.retry_probability} (previously 1.0)`);

// --- Discovery must never erase knowledge ---
const discoveryOptions = {
  codex: { cachePath: path.join(home, 'home', '.codex', 'models_cache.json') },
  claude: { cachePath: path.join(home, 'home', '.claude.json') },
  antigravity: { agyBin: path.join(home, 'missing-agy') },
  opencode_go: { fixturePath: path.join(home, 'home', 'opencode-models.json') }
};
discovery.refreshAllCatalogs(discoveryOptions);
const discovered = JSON.parse(fs.readFileSync(routesPath, 'utf8')).find((route) => route.route_id === 'opencode:qwen3.7-max');
assert.ok(discovered, 'discovery produced the route under test');
const validation = JSON.parse(fs.readFileSync(validationPath, 'utf8'));
validation.routes[discovered.route_id] = {
  operational_health: 'HEALTHY',
  capabilities: { tool_use: { status: 'VALIDATED', method: 'controlled_eval' }, file_edit: { status: 'VALIDATED', method: 'controlled_eval' } }
};
fs.writeFileSync(validationPath, JSON.stringify(validation, null, 2));
const intelligence = JSON.parse(fs.readFileSync(miPath, 'utf8'));
intelligence.models['qwen3.7-max'] = { model_version: 'synthetic', capabilities: { refactor: structuredClone(miDoc.models['synthetic-frontier-coder'].capabilities.refactor) } };
fs.writeFileSync(miPath, JSON.stringify(intelligence, null, 2));
const executionsPath = path.join(home, 'data/routing-executions.jsonl');
fs.writeFileSync(executionsPath, `${JSON.stringify(telemetry('PROVIDER')[0])}\n`);
const knowledge = [miPath, validationPath, learnedPath, executionsPath, path.join(miDir, 'capability-anomalies.jsonl'), path.join(home, 'data/routing-evaluations.jsonl')];
const snapshot = knowledge.map((file) => fs.readFileSync(file, 'utf8'));
discovery.refreshAllCatalogs(discoveryOptions);
knowledge.forEach((file, index) => assert.equal(fs.readFileSync(file, 'utf8'), snapshot[index], `provider refresh must not touch ${path.relative(home, file)}`));
const refreshedDecision = decide({ telemetryRecords: [] });
const refreshedQwen = refreshedDecision.allCandidates.find((candidate) => candidate.route_id === 'opencode:qwen3.7-max');
assert.equal(refreshedQwen.route_state.validation, 'VALIDATED');
assert.equal(refreshedQwen.capability_class, 'FRONTIER');
console.log(`discovery refresh preserved ${knowledge.length} knowledge files; ${discovered.route_id} still VALIDATED/FRONTIER`);

console.log('Model Intelligence routing, attribution, anomaly, Stage C precision, and discovery preservation passed');
