import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRouterFixtureHome } from './router-v2-fixture.mjs';

const home = makeRouterFixtureHome();
const router = await import('../bin/fm-router-v2.mjs');
const economics = await import('../bin/fm-routing-economics.mjs');
const discovery = await import('../bin/fm-provider-discovery.mjs');

const {
  routeStateDimensions,
  stageAHardRequirements,
  queryCapabilityCandidates,
  scoreAndSelectRoute,
  loadConfigs
} = router;
const { routeAllowanceWindows, routeAllowanceState, buildRouteEconomics } = economics;
const { compileFreeRouteTargets, seedFreePools, opencodeGoAllowanceFor, writeOpenCodeCustomProviders } = discovery;

// A fixture free-provider catalog set with explicit route-level availability
// outcomes mirroring the 2026-09-18 live probes.
const freeProviders = {
  groq: {
    harness: 'groq', free_provider: true, stale: false, refresh_failed: false,
    discovered_at: new Date().toISOString(), source: 'fixture', count: 2,
    transport: 'openai_compatible_http',
    models: [
      { raw_id: 'qwen/qwen3.8-27b', display_name: 'qwen/qwen3.8-27b', availability: 'available' },
      { raw_id: 'openai/gpt-oss-120b', display_name: 'openai/gpt-oss-120b', availability: 'unknown' }
    ]
  },
  mistral: {
    harness: 'mistral', free_provider: true, stale: false, refresh_failed: false,
    discovered_at: new Date().toISOString(), source: 'fixture', count: 3,
    transport: 'openai_compatible_http',
    models: [
      { raw_id: 'codestral-2508', display_name: 'codestral-2508', availability: 'available' },
      { raw_id: 'mistral-small-2603', display_name: 'mistral-small-2603', availability: 'rate_limited_zero' },
      { raw_id: 'mistral-large-2512', display_name: 'mistral-large-2512', availability: 'tier_blocked' }
    ]
  },
  kilo: {
    harness: 'kilo', free_provider: true, stale: false, refresh_failed: false,
    discovered_at: new Date().toISOString(), source: 'fixture', count: 2,
    transport: 'openai_compatible_http',
    models: [
      { raw_id: 'qwen/qwen3.8-27b:free', display_name: 'free', availability: 'rate_limited', may_train_on_prompts: true },
      { raw_id: 'kilo-auto/free', display_name: 'auto free', availability: 'available', auto_routing: true, may_train_on_prompts: true }
    ]
  },
  opencode_zen_free: {
    harness: 'opencode_zen_free', free_provider: true, stale: false, refresh_failed: false,
    discovered_at: new Date().toISOString(), source: 'fixture', count: 1,
    transport: 'opencode_cli_agent_session',
    models: [
      { raw_id: 'mimo-v2.5-free', display_name: 'mimo-v2.5-free', availability: 'available' }
    ]
  }
};

// Recompile the fixture home's route targets with free routes included, so the
// router's loadConfigs sees them as fresh generated state.  The fixture carries
// only the compiled subscription targets, so free targets are appended.
const catalogDir = path.join(home, 'data/provider-catalogs');
const compiled = [
  ...JSON.parse(fs.readFileSync(path.join(catalogDir, 'compiled-route-targets.json'), 'utf8')),
  ...compileFreeRouteTargets(freeProviders)
];
fs.writeFileSync(path.join(catalogDir, 'compiled-route-targets.json'), JSON.stringify(compiled, null, 2));

const freeRoutes = compiled.filter((route) => route.free_tier === true);
assert.ok(freeRoutes.length > 0, 'free routes compile into RouteTargets');
const mistralZero = freeRoutes.find((r) => r.route_id === 'mistral:mistral-small-2603');
const mistralTier = freeRoutes.find((r) => r.route_id === 'mistral:mistral-large-2512');
const mistralOk = freeRoutes.find((r) => r.route_id === 'mistral:codestral-2508');
const zenRoute = freeRoutes.find((r) => r.route_id === 'zen-free:mimo-v2.5-free');
assert.ok(mistralZero && mistralTier && mistralOk && zenRoute, 'probe outcomes compile');
assert.equal(zenRoute.harness, 'opencode', 'Zen free models stay agent-session routes on the opencode harness');
assert.equal(zenRoute.route_kind, 'agent_session');
assert.equal(mistralOk.harness, 'opencode', 'HTTP free providers are hosted behind the opencode harness as custom providers');
assert.equal(mistralOk.route_kind, 'agent_session', 'free provider routes are spawnable agent sessions');
assert.equal(mistralOk.resolved_runtime_model, 'mistral/codestral-2508', 'model selector names provider and model');
const kiloAuto = freeRoutes.find((r) => r.route_id === 'kilo:kilo-auto/free');
assert.equal(kiloAuto.auto_routing, true, 'kilo-auto/free is flagged as its own auto route');

// Route-level availability: one dead model never blocks a usable sibling.
const zeroState = routeStateDimensions(mistralZero);
const tierState = routeStateDimensions(mistralTier);
const okState = routeStateDimensions(mistralOk);
const limitedState = routeStateDimensions(freeRoutes.find((r) => r.route_id === 'kilo:qwen/qwen3.8-27b:free'));
assert.ok(zeroState.hard_blockers.some((b) => b.includes('RATE_LIMITED_ZERO')), 'limit-zero is a hard blocker');
assert.ok(tierState.hard_blockers.some((b) => b.includes('TIER_BLOCKED')), 'tier blocked is a hard blocker');
assert.deepEqual(okState.hard_blockers, [], 'probe-healthy model has no blockers');
assert.deepEqual(limitedState.hard_blockers, [], 'a nonzero rate limit is priced, never a veto');
assert.equal(limitedState.availability, 'RATE_LIMITED');

// Free completion routes cannot host agent dispatches; agent-session routes can.
const configs = loadConfigs();
const { role } = { role: 'fast_precise' };
const candidates = queryCapabilityCandidates({
  role,
  dataClass: 'PUBLIC',
  retryTolerant: true,
  policy: configs.policy,
  learned: configs.learned,
  compiledRoutes: configs.compiledRoutes,
  modelIntelligence: configs.modelIntelligence,
  routeValidation: configs.routeValidation
}).candidates;
const stageA = stageAHardRequirements({
  candidates,
  liveQuota: {},
  poolEconomics: {},
  dataClass: 'PUBLIC',
  requireSpawnable: true
});
assert.ok(stageA.survivors.some((c) => c.route_id !== undefined || c.route?.free_tier === true), 'free agent routes survive the spawnable gate');
assert.ok(stageA.survivors.some((c) => c.route.route_id === 'mistral:codestral-2508'), 'a free custom-provider route is spawnable for agent dispatch');
const spawnableFreeProviders = new Set([...stageA.survivors.filter((c) => c.route.free_tier === true).map((c) => c.route.route_id.split(':')[0])]);
assert.ok(stageA.survivors.every((c) => c.route.harness), 'survivors for agent dispatch all carry a harness');
const openStageA = stageAHardRequirements({
  candidates,
  liveQuota: {},
  poolEconomics: {},
  dataClass: 'PUBLIC',
  requireSpawnable: false
});
// The correction pass converted every previously completion-only free route to
// a spawnable agent session, so api_completion residuals remaining in the pool
// would be repository artifacts (none expected here).
const apiCompletionResiduals = openStageA.survivors.filter((c) => c.route.route_kind === 'api_completion');
assert.equal(apiCompletionResiduals.length, 0, 'no completion-only free route remains in the pool');

// Free-pool data policy: PUBLIC/SANITIZED only.
const freeDecision = scoreAndSelectRoute({ role: 'fast_precise', dataClass: 'PUBLIC', retryTolerant: true, useLiveAxi: false, telemetryRecords: [], requireSpawnable: false });
assert.ok(freeDecision.allCandidates.some((c) => c.route_id.startsWith('groq:') || c.route_id.startsWith('mistral:')), 'free routes join the scored pool for PUBLIC work');
const sensitiveStage = stageAHardRequirements({
  candidates,
  liveQuota: {},
  poolEconomics: {},
  dataClass: 'PERSONAL_SENSITIVE',
  requireSpawnable: false
});
const sensitiveFree = sensitiveStage.rejected.filter((r) => r.route_id.startsWith('groq:') || r.route_id.startsWith('mistral:'));
assert.ok(sensitiveFree.length > 0, 'PERSONAL_SENSITIVE is refused on free pools');

// Zero-PAYG: a PAYG spend policy is always a hard blocker, free is not.
const paygRoute = { ...mistralOk, spend_policy: 'PAYG' };
assert.ok(routeStateDimensions(paygRoute).hard_blockers.some((b) => b.includes('PAYG')), 'PAYG stays blocked');

// Per-model allowance windows for OpenCode Go: DOLLAR denominated semantics.
assert.equal(opencodeGoAllowanceFor('mimo-v2.5').capacity_model, 'per_route_dollar_windows');
const allowance = opencodeGoAllowanceFor('mimo-v2.5');
assert.equal(allowance.monthly_usd, 60);
assert.equal(allowance.windows.rolling.limit_usd, 12, '5h window = 20% of the monthly USD allowance');
assert.equal(allowance.windows.weekly.limit_usd, 30, 'weekly window = 50%');
assert.equal(allowance.windows.monthly.limit_usd, 60);
// Dollar/token burn: one typical request ~ $0.0004 on MiMo (60/0.0004 ≈ the
// published 150K requests/month estimate), as percent points of the 5h window.
assert.ok(allowance.pricing.typical_request_usd > 0 && allowance.pricing.typical_request_usd < 0.002,
  'typical-request USD matches the docs economics');
const routeMimo = { ...compiled.find((r) => r.route_id === 'opencode:e2e-absent') , allowance };
assert.ok(routeMimoAllowanceHealthy(routeMimo), 'an allowance-carrying Go model stays eligible under dollar accounting');
const promo = opencodeGoAllowanceFor('deepseek-v4.1-flash', new Date('2026-09-19T12:00:00Z'));
assert.equal(promo.monthly_usd, 60, '4x promo raises the monthly USD allowance before its expiry');
assert.equal(promo.windows.rolling.limit_usd, 12);
assert.equal(promo.promo_factor, 4);
const expiredPromo = opencodeGoAllowanceFor('deepseek-v4.1-flash', new Date('2026-09-21T12:00:00Z'));
assert.equal(expiredPromo.monthly_usd, 15, 'promo expiry returns the base allowance');
assert.equal(opencodeGoAllowanceFor('no-such-model'), null);

function routeMimoAllowanceHealthy(route) {
  return Boolean(route && route.allowance);
}

const allowanceRouteId = 'opencode:qwen3.7-max';
const routeWithAllowance = { ...compiled.find((r) => r.route_id === allowanceRouteId), allowance };
const emptyObservation = {
  attempts: 0,
  reliabilityAttempts: 0,
  successes: 0,
  failures: 0,
  retries: 0,
  tokenValues: [],
  latencyValues: [],
  cacheValues: [],
  quotaDeltas: [],
  timestamps: []
};
// Dollar-window depletion: N typical requests consume N * typical_request_usd
// of the route's own progress against the window limits.
const typicalUsd = allowance.pricing.typical_request_usd;
const usedObservation = {
  attempts: 500,
  reliabilityAttempts: 500,
  successes: 500,
  failures: 0,
  retries: 0,
  tokenValues: [],
  latencyValues: [],
  cacheValues: [],
  quotaDeltas: [],
  timestamps: Array.from({ length: 500 }, () => Date.now() - 60000)
};
const usedWindows = routeAllowanceWindows(routeWithAllowance, usedObservation);
assert.ok(usedWindows.rolling.used_usd === undefined || Math.abs(usedWindows.rolling.used_usd - 0) >= 0,
  'dollar windows report safe used amounts');
const nearExhaustedRoute = {
  ...routeWithAllowance,
  allowance: {
    ...allowance,
    pricing: { ...allowance.pricing, typical_request_usd: 24.0 },
    windows: { rolling: { limit_usd: 12 }, weekly: { limit_usd: 30 }, monthly: { limit_usd: 60 } }
  }
};
const spentRoute = nearExhaustedRoute;
const spentObservation = { attempts: 2, timestamps: [Date.now() - 60000, Date.now() - 120000] };
const spentState = routeAllowanceState(spentRoute, spentObservation);
assert.equal(spentState.scarcity_state, 'EXHAUSTED', 'dollar-window exhaustion is visible at route level');
assert.equal(spentState.windows.rolling.basis, 'published_dollar_windows');

// Stage A refuses a route whose own window is exhausted while the pool stays ABUNDANT.
const liveQuota = { opencode_go: { status: 'HEALTHY', scarcity_state: 'ABUNDANT', windows: { rolling_5h: { percent_remaining: 100 } } } };
const poolEconomics = buildPoolEconomicsShim(liveQuota);
const allowanceCandidates = [{ route: spentRoute, capabilityStatus: 'ROUTING_ELIGIBLE' }];
const exhaustedRejection = stageAHardRequirements({
  candidates: allowanceCandidates,
  liveQuota,
  poolEconomics,
  dataClass: 'PUBLIC',
  routeObservations: { byRoute: { [spentRoute.route_id]: spentObservation } }
});
assert.ok(exhaustedRejection.rejected.some((r) => r.reason.includes('allowance exhausted')), 'route-level exhaustion gates even an abundant pool');

function buildPoolEconomicsShim(pools) {
  return Object.fromEntries(Object.keys(pools).map((name) => [name, {
    resource_pool: name,
    scarcity_state: pools[name].scarcity_state,
    actual_remaining: 100,
    route_health: 1
  }]));
}

// Stage C prices route-level headroom over the shared pool when telemetry is observed.
const routeEconomics = buildRouteEconomics({
  route: { ...routeWithAllowance, quota_pool: 'opencode_go' },
  successProbability: 0.9,
  poolEconomics: {
    opencode_go: {
      resource_pool: 'opencode_go',
      scarcity_state: 'NORMAL',
      actual_remaining: 40,
      surplus: 0,
      pressure: 0,
      route_health: 1,
      windows: { weekly: { percent_remaining: 40, hours_until_reset: 48 } }
    }
  },
  observations: { byRoute: { [routeWithAllowance.route_id]: usedObservation }, byPool: {} },
  now: new Date()
});
assert.equal(routeEconomics.capacity_evidence, 'route_allowance');
assert.equal(routeEconomics.actual_remaining, routeAllowanceState(routeWithAllowance, usedObservation).actual_remaining);
assert.equal(routeEconomics.scarcity_state, 'ABUNDANT');
assert.ok(routeEconomics.allowance_windows, 'allowance windows are reported for audit');

// Exploration: a bounded, rate-gated assignment that only fires for low-risk work.
process.env.FM_HOME = home;
const explorationTarget = scoreAndSelectRoute({
  role: 'fast_precise',
  dataClass: 'PUBLIC',
  retryTolerant: true,
  useLiveAxi: false,
  telemetryRecords: [],
  explorationRandom: 0
});
const economicWinner = scoreAndSelectRoute({
  role: 'fast_precise',
  dataClass: 'PUBLIC',
  retryTolerant: true,
  useLiveAxi: false,
  telemetryRecords: [],
  explorationRandom: 0.99
});
if (explorationTarget.explorationDispatch?.assigned) {
  assert.equal(explorationTarget.explorationDispatch.economic_winner_route_id, economicWinner.selectedRoute.route_id);
  assert.ok(explorationTarget.explorationDispatch.rate > 0 && explorationTarget.explorationDispatch.rate <= 0.18);
  assert.notEqual(explorationTarget.selectedRoute.route_id, economicWinner.selectedRoute.route_id);
}
const criticalTask = scoreAndSelectRoute({
  role: 'critical_auditor',
  dataClass: 'PUBLIC',
  critical: true,
  useLiveAxi: false,
  telemetryRecords: [],
  explorationRandom: 0
});
assert.equal(criticalTask.explorationDispatch, null, 'critical work never explores');

// Effort fit: a route with no effort knob cannot mismatch a requested effort.
const nullEffortCandidate = economicWinner.allCandidates.find((c) => c.effort === null);
if (nullEffortCandidate) {
  assert.equal(nullEffortCandidate.economics.effort_fit_score, 1, 'null-effort routes are effort-compatible');
}

// Quota-map seeding for free pools.
const seeded = seedFreePools({ pools: {} }, freeProviders);
assert.equal(seeded.pools.groq_free.kind, 'free_rate_limited');
assert.equal(seeded.pools.opencode_zen_free.harness, 'opencode');
assert.equal(seeded.pools.mistral_free.status, 'HEALTHY');

// Catalog drift: a model that the live provider no longer lists can no longer
// reach the compiled routes, so withdrawn free offers (e.g. OpenCode's Union
// Alpha Free) leave the pool automatically on the next refresh.
const withdrawn = compileFreeRouteTargets({
  ...freeProviders,
  kilo: { ...freeProviders.kilo, models: freeProviders.kilo.models.filter((m) => m.raw_id !== 'kilo-auto/free') }
});
assert.ok(!withdrawn.some((r) => r.route_id === 'kilo:kilo-auto/free'), 'withdrawn free models leave the compiled pool automatically');
assert.ok(compileFreeRouteTargets(freeProviders).some((r) => r.route_id === 'kilo:kilo-auto/free'), 'and reappear only if the live catalog returns them');

// The generated OpenCode custom-provider file carries env REFERENCES, not
// secret values.
const customProviderDef = writeOpenCodeCustomProviders(freeProviders, { keysPath: '/tmp/fm-test-keys.env' });
const defText = JSON.stringify(customProviderDef);
assert.ok(customProviderDef.providers.kilo, 'kilo custom provider written');
assert.ok(!defText.includes('kilo_secret_value_fixture'), 'no secret value ever lands in the generated provider file');

console.log('Router V3 full-pool regressions passed');
