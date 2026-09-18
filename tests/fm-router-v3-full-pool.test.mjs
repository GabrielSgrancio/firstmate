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
const { compileFreeRouteTargets, seedFreePools, opencodeGoAllowanceFor } = discovery;

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
assert.equal(mistralOk.harness, null, 'HTTP free routes are completion-only');
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
assert.ok(stageA.rejected.some((r) => r.reason.includes('completion-only')), 'completion routes refused agent dispatch');
assert.ok(stageA.survivors.every((c) => c.route.harness), 'survivors for agent dispatch all carry a harness');
const openStageA = stageAHardRequirements({
  candidates,
  liveQuota: {},
  poolEconomics: {},
  dataClass: 'PUBLIC',
  requireSpawnable: false
});
assert.ok(openStageA.survivors.some((c) => c.route.route_kind === 'api_completion'), 'routing/eval still sees the full pool');

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

// Per-model allowance windows for OpenCode Go.
const allowance = opencodeGoAllowanceFor('mimo-v2.5');
assert.equal(allowance.capacity_model, 'per_route_windows');
assert.equal(allowance.windows.rolling.limit_requests, 30100);
const promo = opencodeGoAllowanceFor('deepseek-v4.1-flash', new Date('2026-09-19T12:00:00Z'));
assert.equal(promo.windows.rolling.limit_requests, 26000, '4x promo applies before its expiry');
assert.equal(promo.promo_factor, 4);
const expiredPromo = opencodeGoAllowanceFor('deepseek-v4.1-flash', new Date('2026-09-21T12:00:00Z'));
assert.equal(expiredPromo.windows.rolling.limit_requests, 6500, 'promo expiry returns the base allowance');
assert.equal(opencodeGoAllowanceFor('no-such-model'), null);

const allowanceRouteId = 'opencode:qwen3.7-max';
const routeWithAllowance = { ...compiled.find((r) => r.route_id === allowanceRouteId), allowance };
const observation = {
  attempts: 2,
  reliabilityAttempts: 2,
  successes: 2,
  failures: 0,
  retries: 0,
  tokenValues: [],
  latencyValues: [],
  cacheValues: [],
  quotaDeltas: [],
  timestamps: [Date.now() - 3600000, Date.now() - 7200000]
};
const windows = routeAllowanceWindows(routeWithAllowance, observation);
assert.ok(windows.rolling.percent_remaining > 99.9, 'two requests barely touch a 30,100-request 5h window');
const spentRoute = { ...routeWithAllowance };
const spentObservation = { attempts: 31000, timestamps: Array.from({ length: 31000 }, () => Date.now() - 60000) };
const spentState = routeAllowanceState(spentRoute, spentObservation);
assert.equal(spentState.scarcity_state, 'EXHAUSTED', 'per-model exhaustion is visible at route level');
assert.equal(spentState.observed, true);

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
  observations: { byRoute: { [routeWithAllowance.route_id]: observation }, byPool: {} },
  now: new Date()
});
assert.equal(routeEconomics.capacity_evidence, 'route_allowance');
assert.equal(routeEconomics.actual_remaining, routeAllowanceState(routeWithAllowance, observation).actual_remaining);
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

console.log('Router V3 full-pool regressions passed');
