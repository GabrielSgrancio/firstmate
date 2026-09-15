// Router V3 single dispatch authority: evidence-thin bootstrap through seed
// priors, dispatch-time catalog freshness, router provenance verification, and
// the manual-override data gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRouterFixtureHome } from './router-v2-fixture.mjs';

const home = makeRouterFixtureHome();
const router = await import('../bin/fm-router-v2.mjs');

const learnedPath = path.join(home, 'data', 'learned-routing.json');
const priorsPath = path.join(home, 'config', 'routing-priors.json');
const routesPath = path.join(home, 'data', 'provider-catalogs', 'compiled-route-targets.json');
const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
const terraRoute = routes.find((route) => route.route_id === 'codex:gpt-5.6-terra:medium');
assert.equal(terraRoute?.routing_status, 'ROUTING_ELIGIBLE', 'fixture must carry a routing-eligible terra route');

// An evidence-thin home: no per-route capability records at all.
fs.writeFileSync(learnedPath, JSON.stringify({ version: 4, route_capabilities: {}, model_family_priors: {} }));
const writePriors = (priors) => fs.writeFileSync(priorsPath, JSON.stringify({ version: 3, priors }));
const route = (overrides = {}) => router.scoreAndSelectRoute({
  role: 'general_engineer',
  dataClass: 'PRIVATE_CODE',
  useLiveAxi: false,
  telemetryRecords: [],
  ...overrides
});

writePriors({});
// No evidence is uncertainty, not invisibility: every route is a candidate, and
// the task's quality floor refuses an ordinary task while a retry-tolerant one
// may use an unknown route through the low-risk uncertainty tolerance.
assert.throws(() => route(), /No routes meet quality floor/, 'no evidence and no prior still refuses an ordinary task');
const tolerant = route({ retryTolerant: true });
assert.equal(tolerant.topCandidates[0].admitted_by, 'low_risk_uncertainty_tolerance');
assert.equal(tolerant.topCandidates[0].quality, 0.5);
assert.throws(() => route({ retryTolerant: true, taskClass: 'brownfield_debugging', role: 'deep_engineer' }), /No routes meet quality floor/,
  'high-risk task classes get no uncertainty tolerance');

writePriors({
  'gpt-5.6-terra': { harness: 'opencode', prior_mean: 0.93, prior_effective_n: 40, recommended_roles: ['general_engineer'] }
});
assert.throws(() => route(), /seed prior is for harness opencode/, 'a prior for another harness is not borrowed');

writePriors({
  'gpt-5.6-terra': { prior_mean: 0.93, prior_effective_n: 40, recommended_roles: ['general_engineer'] }
});
assert.throws(() => route(), /seed prior does not name a harness/, 'a prior must name its harness to be admitted');

writePriors({
  'gpt-5.6-terra': { harness: 'codex', prior_mean: 0.93, prior_effective_n: 40, recommended_roles: ['autonomous_engineer'] }
});
assert.throws(() => route(), /seed prior does not recommend role general_engineer/);

writePriors({
  'gpt-5.6-terra': { harness: 'codex', prior_mean: 0.93, prior_effective_n: 40, recommended_roles: ['general_engineer'] }
});
const bootstrapped = route();
assert.equal(bootstrapped.harness, 'codex');
assert.match(bootstrapped.selectedRoute.route_id, /^codex:gpt-5\.6-terra:/);
assert.ok(bootstrapped.allCandidates.every((candidate) => candidate.candidate_basis === 'seed_prior'));
assert.equal(bootstrapped.topCandidates[0].quality_source, 'seed_prior');
console.log(`seed-prior bootstrap selected ${bootstrapped.selectedRoute.route_id} score=${bootstrapped.finalScore.toFixed(4)}`);

assert.throws(() => route({ critical: true }), /critical tasks require real capability evidence/);

// Antigravity Gemini slugs carry their effort tier, and still match the model's prior.
writePriors({
  'gemini-3.8-flash': { harness: 'antigravity', prior_mean: 0.92, prior_effective_n: 30, recommended_roles: ['fast_context'] }
});
const agySelection = route({ role: 'fast_context', dataClass: 'PUBLIC' });
assert.match(agySelection.selectedRoute.route_id, /^agy:gemini-3\.8-flash-(low|medium)$/);
assert.ok(agySelection.allCandidates.every((candidate) => candidate.candidate_basis === 'seed_prior'));
writePriors({
  'gpt-5.6-terra': { harness: 'codex', prior_mean: 0.93, prior_effective_n: 40, recommended_roles: ['general_engineer'] }
});
assert.throws(() => route({ dataClass: 'SECRET' }), /No viable RouteTargets|SECRET/);

// Dispatch-time catalog freshness regenerates a stale catalog once.
const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
fs.utimesSync(routesPath, old, old);
assert.throws(() => route(), /No viable RouteTargets/, 'a stale catalog yields no routes');
const failed = router.ensureRouteCatalogFresh({ refresher: () => {} });
assert.equal(failed.fresh, false);
let refreshCalls = 0;
const refreshed = router.ensureRouteCatalogFresh({
  refresher: ({ home: refreshHome }) => {
    refreshCalls += 1;
    assert.equal(refreshHome, home);
    const now = new Date();
    fs.utimesSync(routesPath, now, now);
  }
});
assert.deepEqual(refreshed, { fresh: true, refreshed: true });
assert.deepEqual(router.ensureRouteCatalogFresh({ refresher: () => { refreshCalls += 1; } }), { fresh: true, refreshed: false });
assert.equal(refreshCalls, 1);
assert.match(route().selectedRoute.route_id, /^codex:gpt-5\.6-terra:/);

// Router provenance must match a recorded router selection.
const logPath = path.join(home, 'data', 'routing-executions.jsonl');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
router.ingressDispatchStarted({
  taskId: 'prov-task',
  routeExecutionId: 'rex-prov-1',
  path: 'A',
  dataClass: 'PUBLIC',
  routeDecision: { decision_type: 'router_v2' },
  quotaSnapshotBefore: {},
  selectedRouteId: 'codex:gpt-5.6-terra:medium',
  selectedHarness: 'codex',
  selectedModel: 'gpt-5.6-terra',
  selectedEffort: 'medium'
});
router.ingressDispatchStarted({
  taskId: 'manual-task',
  routeExecutionId: 'rex-manual-1',
  path: 'B',
  quotaSnapshotBefore: {},
  routeDecision: { decision_type: 'legacy_manual' },
  selectedRouteId: 'codex:gpt-5.6-terra:medium',
  selectedHarness: 'codex'
});
const verify = (overrides) => router.verifyRouterProvenance({
  taskId: 'prov-task',
  routeExecutionId: 'rex-prov-1',
  routeId: 'codex:gpt-5.6-terra:medium',
  harness: 'codex',
  model: 'gpt-5.6-terra',
  dataClass: 'PUBLIC',
  effort: 'medium',
  ...overrides
});
assert.equal(verify().verified, true);
assert.match(verify({ taskId: 'other-task' }).reason, /task prov-task/);
assert.match(verify({ harness: 'claude' }).reason, /harness codex/);
assert.match(verify({ routeId: 'codex:gpt-5.6-sol:high' }).reason, /route codex:gpt-5\.6-terra:medium/);
assert.match(verify({ routeExecutionId: 'rex-unknown' }).reason, /no router selection/);
assert.equal(verify({ taskId: 'manual-task', routeExecutionId: 'rex-manual-1' }).verified, false,
  'a legacy record is not router provenance');
// A recorded PUBLIC selection cannot be replayed under another data class or effort.
assert.match(verify({ dataClass: 'PRIVATE_CODE' }).reason, /data class PUBLIC/);
assert.match(verify({ dataClass: 'SECRET' }).reason, /SECRET data is strictly excluded/);
assert.equal(verify({ dataClass: null }).verified, false, 'provenance needs the spawn data class');
assert.match(verify({ effort: 'max' }).reason, /effort medium/);
assert.match(verify({ effort: 'default' }).reason, /effort medium/);

// The manual override keeps the data policy.
const gate = (overrides) => router.evaluateManualOverrideDataGate({ harness: 'codex', dataClass: 'PRIVATE_CODE', ...overrides });
assert.equal(gate().allowed, true);
assert.equal(gate({ dataClass: 'SECRET' }).allowed, false);
assert.equal(gate({ dataClass: 'UNKNOWN' }).allowed, false);
const agyRoute = routes.find((candidate) => candidate.harness === 'antigravity' && candidate.data_profile === 'gemini_consumer');
assert.ok(agyRoute, 'fixture must carry a gemini_consumer route');
assert.match(gate({ harness: 'antigravity', dataClass: 'PERSONAL_SENSITIVE' }).reason, /blocked on route profile gemini_consumer/);
assert.equal(gate({ harness: 'unlisted-tool', dataClass: 'PERSONAL_SENSITIVE' }).allowed, false);

// The manual override only reaches already-paid subscription capacity.
const spend = (overrides) => router.evaluateManualOverrideSpendGate({ harness: 'codex', ...overrides });
assert.equal(spend().allowed, true);
assert.equal(spend({ model: 'gpt-5.6-terra' }).allowed, true);
assert.equal(spend({ harness: 'opencode', model: 'opencode-go/qwen3.8-flash' }).allowed, true);
assert.equal(spend({ harness: 'claude', model: 'claude-opus-5' }).allowed, true);
const fable = gate({ harness: 'claude', model: 'claude-fable-5-1', dataClass: 'PUBLIC' });
assert.equal(fable.allowed, false, 'a credit-gated route is refused even when the data class is permitted');
assert.match(fable.reason, /subscription pool/);
assert.equal(spend({ harness: 'claude', model: 'claude-fable-5-1' }).allowed, false);
for (const uncatalogued of ['opencode-go/payg-sentinel-model', 'anthropic/claude-opus-5-api', 'claude-fable-5-1']) {
  assert.equal(gate({ harness: 'opencode', model: uncatalogued, dataClass: 'PRIVATE_CODE' }).allowed, false,
    `uncatalogued opencode model ${uncatalogued} is refused`);
}
assert.equal(gate({ harness: 'unlisted-tool', dataClass: 'PUBLIC' }).allowed, false, 'a harness with no subscription route is refused');
// A route catalogued outside the five pools is refused even if the model also has a subscription route.
const catalogBackup = fs.readFileSync(routesPath, 'utf8');
fs.writeFileSync(routesPath, JSON.stringify([...routes, { ...terraRoute, route_id: 'codex:gpt-5.6-terra:payg', quota_pool: 'openai_api_payg' }]));
assert.match(spend({ model: 'gpt-5.6-terra' }).reason, /outside subscription capacity on codex:gpt-5\.6-terra:payg/);
fs.writeFileSync(routesPath, catalogBackup);

console.log('Router V3 single-authority regressions passed');
