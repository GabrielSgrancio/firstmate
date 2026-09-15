// Router V3 enforcement-readiness regressions: live quota truth (Gate A),
// concurrency-safe burn and capability learning (Gate B), and thin-evidence
// treatment for high-risk task classes (Gate C).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRouterFixtureHome } from './router-v2-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = makeRouterFixtureHome();
const evaluator = await import('../bin/fm-routing-eval.mjs');

// Gate B (capability store): concurrent real-traffic writers must not lose updates.
const routesPath = path.join(home, 'data/provider-catalogs/compiled-route-targets.json');
const learnedPath = path.join(home, 'data/learned-routing.json');
const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
routes.push({
  route_id: 'opencode:race-probe',
  model_family: 'race-probe',
  logical_alias: 'race-probe',
  resolved_runtime_model: 'opencode-go/race-probe',
  harness: 'opencode',
  routing_status: 'BENCHMARK_ONLY',
  availability: 'available',
  data_profile: 'opencode_go',
  quota_pool: 'opencode_go'
});
fs.writeFileSync(routesPath, JSON.stringify(routes, null, 2));
const routeId = 'opencode:race-probe';
evaluator.smokeCandidate({ routeId, taskClass: 'targeted_edit', task_completed: true });
evaluator.cheapEvaluateCandidate({ routeId, taskClass: 'targeted_edit', tests_pass: true, task_completed: true });
evaluator.enterChallenger({ routeId, taskClass: 'targeted_edit', dataClass: 'PUBLIC', retryTolerant: true });

const WRITERS = 8;
const writerSource = `
const evaluator = await import(${JSON.stringify(path.join(ROOT, 'bin/fm-routing-eval.mjs'))});
evaluator.recordRealTraffic({ routeId: ${JSON.stringify(routeId)}, taskClass: 'targeted_edit', dataClass: 'PUBLIC',
  retryTolerant: true, success: true, tests_pass: true, task_completed: true,
  attribution: 'MODEL_BEHAVIOR', attributionEvidence: ['controlled_evaluation'] });
`;
const exits = await Promise.all(Array.from({ length: WRITERS }, () => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', writerSource], {
    env: { ...process.env, FM_HOME: home },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('exit', (code) => resolve({ code, stderr }));
})));
for (const exit of exits) assert.equal(exit.code, 0, exit.stderr);
const raced = JSON.parse(fs.readFileSync(learnedPath, 'utf8')).route_capabilities[routeId].capabilities.targeted_edit;
console.log(`concurrent real-traffic writers=${WRITERS} persisted real_n=${raced.real_n} real_successes=${raced.real_successes}`);
assert.equal(raced.real_n, WRITERS, 'every concurrent real-traffic observation must persist');
assert.equal(raced.real_successes, WRITERS);

const router = await import('../bin/fm-router-v2.mjs');
const economics = await import('../bin/fm-routing-economics.mjs');

// Gate A: live quota-axi windows (schema 3 shape) must replace static quota-map
// windows, and a provider the live adapter omits must read as UNKNOWN.
const quotaBin = fs.mkdtempSync(path.join(home, 'quota-bin-'));
const liveSnapshot = {
  schemaVersion: 3,
  providers: [
    {
      provider: 'codex',
      state: { status: 'fresh', stale: false },
      quotaSemantics: { status: 'known', effectiveAvailability: [{ scope: 'all_models', status: 'known', effectivePercentRemaining: 28 }] },
      windows: [
        { id: 'five_hour', percentRemaining: 73, percentUsed: 27, resetsAt: '2030-01-01T05:00:00.000Z' },
        { id: 'weekly', percentRemaining: 28, percentUsed: 72, resetsAt: '2030-01-05T00:00:00.000Z' }
      ]
    },
    {
      provider: 'antigravity',
      state: { status: 'fresh', stale: false },
      quotaSemantics: {
        status: 'known',
        effectiveAvailability: [
          { scope: 'gemini', status: 'known', effectivePercentRemaining: 27 },
          { scope: '3p', status: 'known', effectivePercentRemaining: 100 }
        ]
      },
      windows: [
        { id: 'gemini-weekly', percentRemaining: 27, resetsAt: '2030-01-04T00:00:00.000Z' },
        { id: 'gemini-5h', percentRemaining: 58, resetsAt: '2030-01-01T05:00:00.000Z' },
        { id: '3p-weekly', percentRemaining: 100, resetsAt: '2030-01-07T00:00:00.000Z' },
        { id: '3p-5h', percentRemaining: 100, resetsAt: '2030-01-01T05:00:00.000Z' }
      ]
    },
    {
      provider: 'claude',
      state: { status: 'stale', stale: true, error: 'Claude quota endpoint rate limited' },
      quotaSemantics: { status: 'unknown', effectiveAvailability: [] },
      windows: [{ id: 'five_hour', percentRemaining: 85 }, { id: 'seven_day', percentRemaining: 66 }]
    }
  ]
};
fs.writeFileSync(path.join(quotaBin, 'quota-axi'), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(liveSnapshot)}\nJSON\n`);
fs.chmodSync(path.join(quotaBin, 'quota-axi'), 0o755);
const unavailableOpenCode = path.join(quotaBin, 'opencode-unavailable.mjs');
fs.writeFileSync(unavailableOpenCode, 'process.exit(1);\n');
const savedEnv = { PATH: process.env.PATH, live: process.env.FM_DISABLE_LIVE_QUOTA, oc: process.env.FM_OPENCODE_QUOTA_SCRIPT };
process.env.PATH = `${quotaBin}:${savedEnv.PATH}`;
process.env.FM_DISABLE_LIVE_QUOTA = '0';
process.env.FM_OPENCODE_QUOTA_SCRIPT = unavailableOpenCode;
const live = router.resolveLiveQuotaPools({ useLiveAxi: true });
process.env.PATH = savedEnv.PATH;
process.env.FM_DISABLE_LIVE_QUOTA = savedEnv.live;
process.env.FM_OPENCODE_QUOTA_SCRIPT = savedEnv.oc;
const liveNow = new Date('2030-01-01T00:00:00.000Z');
const liveEconomics = economics.buildPoolEconomics({ pools: live, now: liveNow });
console.log('Gate A pools:', JSON.stringify(Object.fromEntries(economics.RESOURCE_POOLS.map((name) => [name, {
  status: live[name].status,
  scarcity: liveEconomics[name].scarcity_state,
  actual_remaining: liveEconomics[name].actual_remaining
}]))));
assert.deepEqual(Object.keys(live.codex_plus.windows).sort(), ['five_hour', 'weekly']);
assert.equal(liveEconomics.codex_plus.actual_remaining, 28, 'live Codex weekly bound, not the static 100% map window');
assert.equal(liveEconomics.antigravity_gemini.actual_remaining, 27);
assert.deepEqual(Object.keys(live.antigravity_gemini.windows).sort(), ['gemini-5h', 'gemini-weekly']);
assert.equal(liveEconomics.antigravity_3p.actual_remaining, 100);
for (const name of ['claude_pro', 'opencode_go']) {
  assert.equal(live[name].status, 'UNKNOWN');
  assert.equal(liveEconomics[name].scarcity_state, 'UNKNOWN');
  assert.equal(liveEconomics[name].actual_remaining, null, `${name} must not fabricate headroom`);
}
// Unknown pools carry no windows into quota snapshots, so a later before/after
// comparison cannot mistake static map values for burn.
assert.deepEqual(live.claude_pro.windows, {});
assert.equal(JSON.parse(JSON.stringify(live)).claude_pro.windows.seven_day, undefined);
const omitted = JSON.parse(JSON.stringify(liveSnapshot));
omitted.providers = omitted.providers.filter((provider) => provider.provider !== 'codex');
const expiredAgy = omitted.providers.find((provider) => provider.provider === 'antigravity');
expiredAgy.state = { status: 'auth_required', stale: false, error: 'antigravity_oauth_token_expired' };
expiredAgy.quotaSemantics = { status: 'unknown', effectiveAvailability: [] };
expiredAgy.windows = [];
fs.writeFileSync(path.join(quotaBin, 'quota-axi'), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(omitted)}\nJSON\n`);
process.env.PATH = `${quotaBin}:${savedEnv.PATH}`;
process.env.FM_DISABLE_LIVE_QUOTA = '0';
process.env.FM_OPENCODE_QUOTA_SCRIPT = unavailableOpenCode;
const omittedLive = router.resolveLiveQuotaPools({ useLiveAxi: true });
process.env.PATH = savedEnv.PATH;
process.env.FM_DISABLE_LIVE_QUOTA = savedEnv.live;
process.env.FM_OPENCODE_QUOTA_SCRIPT = savedEnv.oc;
assert.equal(omittedLive.codex_plus.status, 'UNKNOWN', 'an omitted provider keeps no static HEALTHY status');
assert.equal(omittedLive.antigravity_gemini.status, 'AUTH_REQUIRED');
assert.equal(omittedLive.antigravity_3p.status, 'AUTH_REQUIRED');
const authGate = router.stageAHardRequirements({
  candidates: [{ route: { route_id: 'agy-3p:probe', quota_pool: 'antigravity_3p', data_profile: 'gemini_consumer' }, capabilityStatus: 'ROUTING_ELIGIBLE' }],
  liveQuota: omittedLive,
  poolEconomics: economics.buildPoolEconomics({ pools: omittedLive, now: liveNow }),
  dataClass: 'PUBLIC'
});
assert.equal(authGate.survivors.length, 0);
assert.equal(economics.buildPoolEconomics({ pools: omittedLive, now: liveNow }).codex_plus.actual_remaining, null);

// An UNKNOWN pool scores below an observed NORMAL pool for the same route shape.
const probeRoute = (poolName) => ({ route_id: `probe:${poolName}`, quota_pool: poolName, expected_normalized_burn: 1 });
const unknownScore = economics.buildRouteEconomics({ route: probeRoute('claude_pro'), poolEconomics: liveEconomics, successProbability: 0.95, now: liveNow });
const knownScore = economics.buildRouteEconomics({ route: probeRoute('antigravity_3p'), poolEconomics: liveEconomics, successProbability: 0.95, now: liveNow });
console.log(`Gate A score: unknown claude_pro=${unknownScore.economic_score} (${unknownScore.quota_evidence}) vs observed antigravity_3p=${knownScore.economic_score}`);
assert.equal(unknownScore.quota_evidence, 'unknown_low_confidence');
assert.ok(unknownScore.economic_score < knownScore.economic_score);

// An expiring 5h window is not spendable surplus while a longer window is behind pace.
const bound = economics.buildPoolEconomics({
  pools: {
    antigravity_gemini: {
      status: 'HEALTHY',
      windows: {
        'gemini-5h': { percent_remaining: 58, reset_at: '2030-01-01T00:30:00.000Z' },
        'gemini-weekly': { percent_remaining: 27, reset_at: '2030-01-04T00:00:00.000Z' }
      }
    }
  },
  now: liveNow
}).antigravity_gemini;
console.log(`Gate A binding window: scarcity=${bound.scarcity_state} surplus=${bound.surplus.toFixed(3)} unused_at_reset=${bound.expected_unused_quota_at_reset}`);
assert.notEqual(bound.scarcity_state, 'USE_BEFORE_RESET');
assert.equal(bound.expected_unused_quota_at_reset, 0);

// Gate B (burn store): a torn trailing line must not erase earlier observations.
const tornLog = path.join(home, 'torn-executions.jsonl');
fs.writeFileSync(tornLog, `${JSON.stringify({ route_execution_id: 'a', dispatch_status: 'started' })}\n{"route_execution_id":"b","dispatch_st`);
assert.equal(router.readRoutingTelemetryRecords(tornLog).length, 1);

const burnRoute = { route_id: 'opencode:burn-probe', quota_pool: 'opencode_go', expected_normalized_burn: 1 };
const peerRoute = { route_id: 'opencode:burn-peer', quota_pool: 'opencode_go', expected_normalized_burn: 1 };
let clock = Date.parse('2030-01-01T00:00:00.000Z');
function execution(id, route, before, after, { reset = '2030-01-08T00:00:00.000Z', afterReset = reset, durationMs = 60000 } = {}) {
  const start = clock;
  clock += durationMs + 60000;
  return [
    { route_execution_id: id, dispatch_status: 'started', selected_route_id: route.route_id, started_at: new Date(start).toISOString(),
      quota_snapshot_before: { opencode_go: { windows: { weekly: { percent_remaining: before, reset_at: reset } } } } },
    { route_execution_id: id, dispatch_status: 'completed', terminal_state: 'SUCCESS', completed_at: new Date(start + durationMs).toISOString(),
      quota_snapshot_after: { opencode_go: { windows: { weekly: { percent_remaining: after, reset_at: afterReset } } } } }
  ];
}
const burnFor = (records) => {
  const observations = economics.collectRoutingObservations(records, [burnRoute, peerRoute], new Date(clock));
  const pools = economics.buildPoolEconomics({ pools: { opencode_go: { status: 'HEALTHY', windows: { weekly: { percent_remaining: 50 } } } }, observations, now: new Date(clock) });
  return economics.buildRouteEconomics({ route: burnRoute, poolEconomics: pools, observations, successProbability: 0.9 });
};

// Minimum-sample floor: one or two pool observations never displace the catalog burn.
const thinBurn = burnFor([...execution('t1', burnRoute, 90, 80), ...execution('t2', peerRoute, 80, 78)]);
assert.equal(thinBurn.burn_evidence, 'insufficient_pool_calibration_samples');
assert.equal(thinBurn.expected_quota_burn_per_attempt, 1);

// Bounded skew: four clean 2-point peers plus one 60-point glitch on the probe route.
const skewRecords = [
  ...execution('p1', peerRoute, 90, 88), ...execution('p2', peerRoute, 88, 86),
  ...execution('p3', peerRoute, 86, 84), ...execution('p4', peerRoute, 84, 82),
  ...execution('glitch', burnRoute, 82, 22)
];
const skewBurn = burnFor(skewRecords);
console.log(`Gate B skew: observed=${skewBurn.observed_quota_delta_percent}pp normalized_obs=${skewBurn.observed_normalized_quota_consumption} learned_burn=${skewBurn.expected_quota_burn_per_attempt} (unbounded would be 30)`);
assert.equal(skewBurn.burn_evidence, 'real_quota_delta');
assert.ok(skewBurn.expected_quota_burn_per_attempt <= 1.75 + 1e-9, 'one outlier moves burn at most the bounded shrunk step');

// A window that reset mid-measurement is not a burn observation.
const resetDelta = economics.calculateObservedQuotaDelta(
  { opencode_go: { windows: { weekly: { percent_remaining: 10, reset_at: '2030-01-01T00:00:00.000Z' } } } },
  { opencode_go: { windows: { weekly: { percent_remaining: 5, reset_at: '2030-01-08T00:00:00.000Z' } } } },
  'opencode_go'
);
assert.equal(resetDelta, null);

// Overlapping dispatches on one shared meter cannot be attributed to either route.
const overlapStart = clock;
const overlapping = [
  { route_execution_id: 'o1', dispatch_status: 'started', selected_route_id: burnRoute.route_id, started_at: new Date(overlapStart).toISOString(),
    quota_snapshot_before: { opencode_go: { windows: { weekly: { percent_remaining: 70 } } } } },
  { route_execution_id: 'o2', dispatch_status: 'started', selected_route_id: peerRoute.route_id, started_at: new Date(overlapStart + 1000).toISOString(),
    quota_snapshot_before: { opencode_go: { windows: { weekly: { percent_remaining: 70 } } } } },
  { route_execution_id: 'o1', dispatch_status: 'completed', terminal_state: 'SUCCESS', completed_at: new Date(overlapStart + 5000).toISOString(),
    quota_snapshot_after: { opencode_go: { windows: { weekly: { percent_remaining: 60 } } } } },
  { route_execution_id: 'o2', dispatch_status: 'completed', terminal_state: 'SUCCESS', completed_at: new Date(overlapStart + 6000).toISOString(),
    quota_snapshot_after: { opencode_go: { windows: { weekly: { percent_remaining: 60 } } } } }
];
const overlapObservations = economics.collectRoutingObservations(overlapping, [burnRoute, peerRoute], new Date(overlapStart + 10000));
assert.equal(overlapObservations.byPool.opencode_go.attempts, 2);
assert.equal(overlapObservations.byPool.opencode_go.quotaDeltas.length, 0);

// Orphaned open executions never hold concurrency slots forever.
const concurrencyNow = new Date('2030-01-10T00:00:00.000Z');
const openExecution = (id, taskId, at) => ({
  route_execution_id: id, task_id: taskId, dispatch_status: 'dispatched', selected_route_id: burnRoute.route_id, timestamp: at
});
const orphaned = [
  openExecution('old-1', 'smoke-a', '2030-01-01T00:00:00.000Z'),
  openExecution('old-2', 'smoke-a', '2030-01-01T01:00:00.000Z'),
  openExecution('old-3', 'smoke-b', '2030-01-02T00:00:00.000Z'),
  openExecution('fresh-1', 'live-task', '2030-01-09T23:00:00.000Z'),
  openExecution('fresh-2', 'live-task', '2030-01-09T23:30:00.000Z')
];
assert.equal(economics.collectRoutingObservations(orphaned, [burnRoute], concurrencyNow).activeByPool.opencode_go, 1,
  'age horizon drops orphans and one task holds one slot');
assert.equal(economics.collectRoutingObservations(orphaned, [burnRoute], concurrencyNow, {
  isActive: (records) => records[0].task_id === 'smoke-b'
}).activeByPool.opencode_go, 1, 'caller liveness decides which open executions are real');
fs.mkdirSync(path.join(home, 'state'), { recursive: true });
fs.writeFileSync(path.join(home, 'data', 'routing-executions.jsonl'), orphaned.map((r) => JSON.stringify(r)).join('\n') + '\n');
const liveDecision = router.scoreAndSelectRoute({ role: 'strong_cheap_worker', dataClass: 'PUBLIC', useLiveAxi: false, now: concurrencyNow });
assert.equal(liveDecision.poolEconomics.opencode_go.current_concurrency, 0, 'no live task records means no occupied slots');

// Gate C: for a high-risk class, a thin route with a marginally higher posterior
// mean loses to a well-evidenced route in the same pool; a low-risk class keeps
// the point-estimate behavior.
const capabilityModel = await import('../bin/fm-routing-capability.mjs');
function capability(realN, successes) {
  const priorMean = 0.94;
  const priorN = 2;
  return {
    real_n: realN,
    real_successes: successes,
    prior_mean: priorMean,
    prior_effective_n: priorN,
    posterior_mean: (priorMean * priorN + successes) / (priorN + realN)
  };
}
const thin = { route: { route_id: 'codex:thin', quota_pool: 'codex_plus', expected_normalized_burn: 1 }, capability: capability(4, 4) };
const deep = { route: { route_id: 'codex:deep', quota_pool: 'codex_plus', expected_normalized_burn: 1 }, capability: capability(60, 58) };
assert.ok(thin.capability.posterior_mean > deep.capability.posterior_mean);
const gatePools = economics.buildPoolEconomics({ pools: { codex_plus: { status: 'HEALTHY', windows: { weekly: { percent_remaining: 60 } } } }, now: liveNow });
function rank(taskClass) {
  const gate = router.stageBQualityGate({ candidates: [thin, deep], taskClass, learned: { model_family_priors: {} }, priors: { priors: {} } });
  const scored = gate.survivors.map((candidate) => ({
    ...candidate,
    economics: economics.buildRouteEconomics({
      route: candidate.route,
      capability: candidate.capability,
      poolEconomics: gatePools,
      successProbability: candidate.successProbability,
      now: liveNow
    })
  }));
  return { gate, selected: economics.selectEconomicRoute(scored) };
}
for (const taskClass of capabilityModel.HIGH_RISK_TASK_CLASSES) {
  const { gate, selected } = rank(taskClass);
  const evidence = Object.fromEntries(gate.survivors.map((c) => [c.route.route_id, c.qualityEvidence]));
  console.log(`Gate C ${taskClass}: thin mean=${thin.capability.posterior_mean.toFixed(4)} lb=${evidence['codex:thin'].credible.lower_bound} width=${evidence['codex:thin'].credible.width}; deep mean=${deep.capability.posterior_mean.toFixed(4)} lb=${evidence['codex:deep'].credible.lower_bound} width=${evidence['codex:deep'].credible.width}; winner=${selected.winner.route.route_id} scores=${selected.ranked.map((c) => c.economics.economic_score).join('/')}`);
  assert.ok(evidence['codex:thin'].credible.width > 3 * evidence['codex:deep'].credible.width);
  assert.equal(selected.winner.route.route_id, 'codex:deep');
}
assert.equal(rank('critical_audit').gate.floor, 0.96);
const lowRisk = rank('refactor');
assert.equal(lowRisk.selected.winner.route.route_id, 'codex:thin', 'low-risk classes keep point-estimate ranking');

console.log('Router V3 enforcement readiness regressions passed');
