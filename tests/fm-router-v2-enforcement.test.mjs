import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRouterFixtureHome } from './router-v2-fixture.mjs';

const home = makeRouterFixtureHome();
const router = await import('../bin/fm-router-v2.mjs');
const {
  validateConfigs,
  evaluateDataGate,
  planContextShunting,
  scoreAndSelectRoute,
  queryCapabilityCandidates,
  loadConfigs,
  resolveLiveQuotaPools,
  dispatchThroughHerdr,
  qualityFloorForTask,
  stageBQualityGate
} = router;
const economics = await import('../bin/fm-routing-economics.mjs');

const expected = {
  fast_precise: 'codex:gpt-5.6-luna:low',
  cheap_tool_worker: 'codex:gpt-5.6-luna:low',
  strong_cheap_worker: 'opencode:qwen3.7-max',
  general_engineer: 'codex:gpt-5.6-terra:medium',
  fast_context: 'agy:gemini-3.8-flash-low',
  deep_context: 'agy:gemini-3.1-pro-high',
  autonomous_engineer: 'claude:claude-sonnet-5:medium',
  deep_engineer: 'claude:claude-opus-5:high',
  architect_synthesizer: 'claude:claude-opus-5:high',
  critical_auditor: 'claude:claude-opus-5:high'
};

assert.deepEqual(validateConfigs(), { valid: true, canonicalRolesCount: 10, modelsCount: 16 });
for (const [role, routeId] of Object.entries(expected)) {
  assert.equal(scoreAndSelectRoute({ role, dataClass: 'PUBLIC', useLiveAxi: false }).selectedRoute.route_id, routeId, role);
}

const compiledPathForCapabilities = path.join(home, 'data/provider-catalogs/compiled-route-targets.json');
const compiledForCapabilities = JSON.parse(fs.readFileSync(compiledPathForCapabilities, 'utf8'));
compiledForCapabilities.push({
  route_id: 'opencode:glm-5.3-flash',
  model_family: 'glm-5.3-flash',
  logical_alias: 'glm-5.3-flash',
  resolved_runtime_model: 'opencode-go/glm-5.3-flash',
  harness: 'opencode',
  provider_path: 'opencode_go_gateway',
  reasoning_effort: null,
  quota_pool: 'opencode_go',
  expected_normalized_burn: 2,
  data_profile: 'opencode_go',
  routing_status: 'BENCHMARK_ONLY',
  availability: 'available'
});
fs.writeFileSync(compiledPathForCapabilities, JSON.stringify(compiledForCapabilities, null, 2));
const capabilityState = loadConfigs();
capabilityState.learned.route_capabilities['opencode:qwen3.8-flash'].capabilities.refactor = {
  route_id: 'opencode:qwen3.8-flash',
  task_class: 'refactor',
  role: 'general_engineer',
  real_n: 0,
  real_successes: 0,
  prior_mean: 0.5,
  prior_effective_n: 0,
  posterior_mean: 0.5,
  routing_status: 'BENCHMARK_ONLY',
  uncertainty: { status: 'untested', real_n: 0 }
};
const dynamicCandidates = queryCapabilityCandidates({
  role: 'general_engineer',
  taskClass: 'refactor',
  dataClass: 'PUBLIC',
  retryTolerant: true,
  policy: capabilityState.policy,
  learned: capabilityState.learned,
  compiledRoutes: capabilityState.compiledRoutes
});
const glmCandidate = dynamicCandidates.candidates.find(({ route }) => route.route_id === 'opencode:glm-5.3-flash');
assert.ok(glmCandidate, 'an undiscovered OpenCode Go model must enter through exploration evidence');
assert.equal(glmCandidate.candidateBasis, 'exploration');
assert.equal(glmCandidate.capability, null);
assert.equal(glmCandidate.exploration.phase, 'bootstrap');
assert.ok(dynamicCandidates.candidates.some(({ route, capability, candidateBasis }) => route.route_id === 'opencode:qwen3.8-flash' &&
  route.harness === 'opencode' && route.resolved_runtime_model === 'opencode-go/qwen3.8-flash' &&
  capability.real_n === 0 && capability.uncertainty.status === 'untested' && candidateBasis === 'exploration'),
  'an existing OpenCode Go route outside the former role list must be exploration-eligible');

const taskScopedCandidates = queryCapabilityCandidates({
  role: 'strong_cheap_worker',
  taskClass: 'test_generation',
  dataClass: 'PERSONAL_SENSITIVE',
  retryTolerant: false,
  policy: capabilityState.policy,
  learned: capabilityState.learned,
  compiledRoutes: capabilityState.compiledRoutes
});
assert.ok(!taskScopedCandidates.candidates.some(({ route }) => route.route_id === 'codex:gpt-5.6-luna:low'),
  'targeted-edit evidence must not grant test-generation eligibility to the same route');
assert.ok(taskScopedCandidates.rejected.some(({ route_id, reason }) =>
  route_id === 'codex:gpt-5.6-luna:low' && reason.includes('test_generation')));

assert.equal(evaluateDataGate('SECRET', 'claude_consumer').allowed, false);
assert.throws(() => evaluateDataGate('WORK_CORPORATE', 'claude_consumer'), /Unknown data class: WORK_CORPORATE/);
assert.equal(evaluateDataGate('PERSONAL_SENSITIVE', 'claude_consumer').allowed, true);
assert.equal(evaluateDataGate('PERSONAL_SENSITIVE', 'opencode_go_cn').allowed, false);

// Muse Spark: reachable for PUBLIC/SANITIZED, refused for PERSONAL_SENSITIVE per its real
// training-enabled metadata (not a hand-written special case) - captain's explicit WP2 example.
const museRoute = { resolvedRuntimeModel: 'opencode-go/muse-spark-1.3-contributor' };
assert.equal(evaluateDataGate('PUBLIC', 'opencode_go', museRoute).allowed, true);
assert.equal(evaluateDataGate('SANITIZED', 'opencode_go', museRoute).allowed, true);
assert.equal(evaluateDataGate('PRIVATE_CODE', 'opencode_go', museRoute).allowed, true);
const museGate = evaluateDataGate('PERSONAL_SENSITIVE', 'opencode_go', museRoute);
assert.equal(museGate.allowed, false);
assert.match(museGate.reason, /training on prompts\/completions/);

// Grok 4.6: OpenCode's own docs give it 30-day retention (not "transient_gateway"), which alone
// blocks PERSONAL_SENSITIVE even though training is disabled - the blanket claim this task replaces.
const grokRoute = { resolvedRuntimeModel: 'opencode-go/grok-4.6' };
const grokGate = evaluateDataGate('PERSONAL_SENSITIVE', 'opencode_go', grokRoute);
assert.equal(grokGate.allowed, false);
assert.match(grokGate.reason, /retains data for 30 day/);

// A verified zero-retention, non-training-use model passes the same PERSONAL_SENSITIVE gate.
assert.equal(evaluateDataGate('PERSONAL_SENSITIVE', 'opencode_go', { resolvedRuntimeModel: 'opencode-go/qwen3.7-max' }).allowed, true);

// Missing per-model metadata fails closed rather than defaulting to allowed.
const unverifiedGate = evaluateDataGate('PERSONAL_SENSITIVE', 'opencode_go', { resolvedRuntimeModel: 'opencode-go/unverified-model' });
assert.equal(unverifiedGate.allowed, false);
assert.match(unverifiedGate.reason, /no verified per-model privacy metadata/);

// Full pipeline: PERSONAL_SENSITIVE for strong_cheap_worker skips muse-spark (training-enabled)
// and still lands on qwen3.7-max (verified zero-retention, no training).
const strongPersonalSensitive = scoreAndSelectRoute({ role: 'strong_cheap_worker', dataClass: 'PERSONAL_SENSITIVE', useLiveAxi: false });
assert.equal(strongPersonalSensitive.selectedRoute.route_id, 'opencode:qwen3.7-max');
assert.ok(strongPersonalSensitive.rejectedRoutes.some(r => r.route_id === 'opencode:muse-spark' && /training on prompts\/completions/.test(r.reason)));
assert.equal(planContextShunting(12000, 'low').shuntingRequired, false);
assert.equal(planContextShunting(180000, 'high').bulkReaderRole, 'fast_context');

const low = scoreAndSelectRoute({ role: 'general_engineer', dataClass: 'PUBLIC', targetEffort: 'low', useLiveAxi: false });
const high = scoreAndSelectRoute({ role: 'general_engineer', dataClass: 'PUBLIC', targetEffort: 'high', useLiveAxi: false });
assert.equal(low.effort, 'low');
assert.equal(high.effort, 'high');
assert.notEqual(low.selectedRoute.route_id, high.selectedRoute.route_id);

const unknown = resolveLiveQuotaPools({
  useLiveAxi: false,
  quotaOverrides: { codex_plus: { scarcity_state: 'UNKNOWN' } }
});
assert.equal(unknown.codex_plus.scarcity_state, 'UNKNOWN');
assert.notEqual(unknown.codex_plus.scarcity_state, 'ABUNDANT');

// A stale/unavailable OpenCode refresh must not leak last-known-good windows into
// Router decisions as if they were current account usage.
const quotaProbeDir = fs.mkdtempSync(path.join(home, 'quota-live-probe-'));
const staleQuotaScript = path.join(quotaProbeDir, 'stale-quota.mjs');
const quotaAxiBin = path.join(quotaProbeDir, 'bin');
fs.mkdirSync(quotaAxiBin, { recursive: true });
fs.writeFileSync(staleQuotaScript, [
  '#!/usr/bin/env node',
  'console.log(JSON.stringify({source:"last_known_good",stale:true,rolling_5h:{percent_remaining:99},weekly:{percent_remaining:99},monthly:{percent_remaining:99}}));'
].join('\n') + '\n');
fs.chmodSync(staleQuotaScript, 0o755);
fs.writeFileSync(path.join(quotaAxiBin, 'quota-axi'), '#!/usr/bin/env sh\nprintf \'%s\\n\' \'{"schemaVersion":5,"providers":[]}\'\n');
fs.chmodSync(path.join(quotaAxiBin, 'quota-axi'), 0o755);
const oldPath = process.env.PATH;
const oldDisableLiveQuota = process.env.FM_DISABLE_LIVE_QUOTA;
const oldQuotaScript = process.env.FM_OPENCODE_QUOTA_SCRIPT;
process.env.PATH = `${quotaAxiBin}:${oldPath}`;
delete process.env.FM_DISABLE_LIVE_QUOTA;
process.env.FM_OPENCODE_QUOTA_SCRIPT = staleQuotaScript;
const staleLive = resolveLiveQuotaPools({ useLiveAxi: true });
assert.equal(staleLive.opencode_go.scarcity_state, 'UNKNOWN');
assert.equal(staleLive.opencode_go.status, 'UNKNOWN');
process.env.PATH = oldPath;
if (oldDisableLiveQuota === undefined) delete process.env.FM_DISABLE_LIVE_QUOTA;
else process.env.FM_DISABLE_LIVE_QUOTA = oldDisableLiveQuota;
if (oldQuotaScript === undefined) delete process.env.FM_OPENCODE_QUOTA_SCRIPT;
else process.env.FM_OPENCODE_QUOTA_SCRIPT = oldQuotaScript;

const exhausted = scoreAndSelectRoute({
  role: 'general_engineer',
  dataClass: 'PUBLIC',
  useLiveAxi: false,
  quotaOverrides: { codex_plus: { scarcity_state: 'EXHAUSTED' }, claude_pro: { scarcity_state: 'UNKNOWN', windows: { seven_day: { percent_remaining: 10 } } } }
});
assert.equal(exhausted.selectedRoute.route_id, 'agy-3p:claude-sonnet-4-6');
assert.ok(exhausted.rejectedRoutes.some(r => r.reason === 'Quota Pool Exhausted'));

const taskId = 'enforcement-dispatch';
fs.mkdirSync(path.join(home, 'data', taskId), { recursive: true });
fs.writeFileSync(path.join(home, 'data', taskId, 'brief.md'), '# synthetic brief\n');
let seenArgs = null;
const result = dispatchThroughHerdr({
  taskId,
  role: 'general_engineer',
  dataClass: 'PUBLIC',
  useLiveAxi: false,
  spawnRunner: (args) => {
    seenArgs = args;
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(home, 'state', taskId + '.meta'), 'backend=herdr\nharness=codex\nmodel=gpt-5.6-terra\neffort=medium\n');
    return { success: true, output: 'synthetic spawn' };
  }
});
assert.equal(result.success, true);
assert.deepEqual(seenArgs.slice(-2), ['--backend', 'herdr']);
assert.ok(fs.existsSync(path.join(home, 'data', 'routing-executions.jsonl')));

assert.throws(() => scoreAndSelectRoute({ role: 'general_engineer', dataClass: 'UNKNOWN', useLiveAxi: false }), /dataClass is required/);
assert.throws(() => dispatchThroughHerdr({ taskId: 'missing', dataClass: 'UNKNOWN' }), /dataClass is required/);

const compiledPath = path.join(home, 'data', 'provider-catalogs', 'compiled-route-targets.json');
fs.utimesSync(compiledPath, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
assert.throws(() => scoreAndSelectRoute({ role: 'general_engineer', dataClass: 'PUBLIC', useLiveAxi: false }), /No viable RouteTargets/);

const quotaMapPath = path.join(home, 'data', 'quota-pool-map.json');
const quotaMap = JSON.parse(fs.readFileSync(quotaMapPath, 'utf8'));
delete quotaMap.fixture;
fs.writeFileSync(quotaMapPath, JSON.stringify(quotaMap));

const quotaTestBin = fs.mkdtempSync(path.join(home, 'quota-test-bin-'));
const quotaAxiPath = path.join(quotaTestBin, 'quota-axi');
fs.writeFileSync(quotaAxiPath, '#!/bin/sh\nprintf \'%s\\n\' \'{"schemaVersion":5,"providers":[]}\'\n');
fs.chmodSync(quotaAxiPath, 0o755);

const openCodeUnavailablePath = path.join(quotaTestBin, 'opencode-unavailable.mjs');
fs.writeFileSync(openCodeUnavailablePath, 'process.exit(1);\n');

const openCodeFreshPath = path.join(quotaTestBin, 'opencode-fresh.mjs');
fs.writeFileSync(openCodeFreshPath, `console.log(JSON.stringify({
  provider: 'opencode_go',
  pool: 'opencode_go',
  rolling_5h: { percent_used: 10, percent_remaining: 90, reset_at: '2030-01-01T00:00:00.000Z' },
  weekly: { percent_used: 60, percent_remaining: 40, reset_at: '2030-01-02T00:00:00.000Z' },
  monthly: { percent_used: 20, percent_remaining: 80, reset_at: '2030-02-01T00:00:00.000Z' },
  source: 'opencode_go_usage_api',
  fetched_at: new Date().toISOString(),
  stale: false,
  scarcity_state: 'NORMAL'
}));\n`);

const originalPath = process.env.PATH;
const originalLiveQuota = process.env.FM_DISABLE_LIVE_QUOTA;
process.env.PATH = `${quotaTestBin}:${originalPath}`;
process.env.FM_DISABLE_LIVE_QUOTA = '0';
fs.utimesSync(compiledPath, new Date(), new Date());

fs.utimesSync(quotaMapPath, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
process.env.FM_OPENCODE_QUOTA_SCRIPT = openCodeUnavailablePath;
const staleUnavailable = scoreAndSelectRoute({ role: 'strong_cheap_worker', dataClass: 'PUBLIC' });
assert.equal(staleUnavailable.scarcityState, 'UNKNOWN');
assert.equal(['ABUNDANT', 'NORMAL', 'CONSERVE', 'CRITICAL', 'EXHAUSTED', 'USE_BEFORE_RESET'].includes(staleUnavailable.scarcityState), false);

fs.utimesSync(quotaMapPath, new Date(), new Date());
process.env.FM_OPENCODE_QUOTA_SCRIPT = openCodeFreshPath;
const freshOpenCode = scoreAndSelectRoute({ role: 'strong_cheap_worker', dataClass: 'PUBLIC' });
assert.equal(freshOpenCode.selectedRoute.route_id, 'opencode:qwen3.7-max');
assert.equal(freshOpenCode.scarcityState, 'NORMAL');
assert.equal(resolveLiveQuotaPools().opencode_go.windows.weekly.percent_remaining, 40);

process.env.PATH = originalPath;
process.env.FM_DISABLE_LIVE_QUOTA = originalLiveQuota;
delete process.env.FM_OPENCODE_QUOTA_SCRIPT;

// WP5/WP6 economics and staged scheduler evidence.
const stagedHome = makeRouterFixtureHome();
const stagedState = loadConfigs();
const stagedRoutes = stagedState.compiledRoutes;
const stagedLearnedPath = path.join(stagedHome, 'data', 'learned-routing.json');
const stagedLearned = stagedState.learned;
function setRefactorEvidence(routeId, posteriorMean) {
  const record = stagedLearned.route_capabilities[routeId]?.capabilities?.refactor;
  assert.ok(record, `fixture must contain refactor evidence for ${routeId}`);
  record.real_n = 15;
  record.real_successes = Math.round(posteriorMean * 15);
  record.posterior_mean = posteriorMean;
  record.routing_status = 'ROUTING_ELIGIBLE';
}
setRefactorEvidence('codex:gpt-5.6-terra:medium', 0.96);
setRefactorEvidence('agy-3p:claude-sonnet-4-6', 0.93);
fs.writeFileSync(stagedLearnedPath, `${JSON.stringify(stagedLearned, null, 2)}\n`);

const observedBefore = {
  opencode_go: { windows: { weekly: { percent_remaining: 90 } } }
};
const observedAfter = {
  opencode_go: { windows: { weekly: { percent_remaining: 85 } } }
};
const observedDelta = economics.calculateObservedQuotaDelta(observedBefore, observedAfter, 'opencode_go');
assert.equal(observedDelta.percent_points, 5);
const qwenRoute = stagedRoutes.find((route) => route.route_id === 'opencode:qwen3.7-max');
const qwenCapability = stagedLearned.route_capabilities[qwenRoute.route_id].capabilities.refactor;
const observedTelemetry = economics.collectRoutingObservations([
  {
    route_execution_id: 'observed-qwen',
    dispatch_status: 'started',
    selected_route_id: qwenRoute.route_id,
    quota_snapshot_before: observedBefore,
    started_at: '2026-09-15T00:00:00.000Z'
  },
  {
    route_execution_id: 'observed-qwen',
    dispatch_status: 'completed',
    terminal_state: 'SUCCESS',
    quota_snapshot_after: observedAfter,
    completed_at: '2026-09-15T00:00:10.000Z',
    actual_token_usage: 1200
  }
], [qwenRoute], new Date('2026-09-15T01:00:00.000Z'));
const observedPoolEconomics = economics.buildPoolEconomics({
  pools: { opencode_go: { status: 'HEALTHY', windows: { weekly: { percent_remaining: 85 } } } },
  observations: observedTelemetry,
  now: new Date('2026-09-15T01:00:00.000Z')
});
const observedRouteEconomics = economics.buildRouteEconomics({
  route: qwenRoute,
  capability: qwenCapability,
  poolEconomics: observedPoolEconomics,
  observations: observedTelemetry
});
assert.equal(observedRouteEconomics.burn_evidence, 'real_quota_delta');
assert.equal(observedRouteEconomics.actual_token_usage, 1200);
assert.equal(
  observedRouteEconomics.expected_successful_quota_burn,
  Number((observedRouteEconomics.expected_quota_burn_per_attempt / observedRouteEconomics.task_success_probability).toFixed(6))
);

const paced = economics.computeBudgetPacing({
  windows: { rolling: { percent_remaining: 80, reset_at: '2026-09-15T02:00:00.000Z' } },
  recentBurnVelocity: 1,
  now: new Date('2026-09-15T01:00:00.000Z')
});
assert.equal(paced.target_remaining, 20);
assert.equal(paced.actual_remaining, 80);
assert.equal(paced.surplus, 60);
assert.ok(paced.pressure > 0);

const oldFlatWinner = {
  route: { route_id: 'expiring-low', model_family: 'test', resolved_runtime_model: 'test-low' },
  capability: { posterior_mean: 0.79, real_n: 15 }
};
const oldFlatSufficient = {
  route: { route_id: 'scarce-sufficient', model_family: 'test', resolved_runtime_model: 'test-sufficient' },
  capability: { posterior_mean: 0.90, real_n: 15 }
};
const oldFlatLowScore = 0.79 + 0.15 + 0.05;
const oldFlatSufficientScore = 0.90 - 0.10 + 0.05;
assert.ok(oldFlatLowScore > oldFlatSufficientScore);
const qualityGateEvidence = stageBQualityGate({
  candidates: [oldFlatWinner, oldFlatSufficient],
  taskClass: 'refactor',
  qualityFloor: 0.88,
  learned: { model_family_priors: {} },
  priors: { priors: {} }
});
assert.ok(qualityGateEvidence.rejected.some((entry) => entry.route_id === 'expiring-low'));
assert.deepEqual(qualityGateEvidence.survivors.map((entry) => entry.route.route_id), ['scarce-sufficient']);
const useBeforeResetPool = economics.buildPoolEconomics({
  pools: {
    antigravity_3p: {
      status: 'HEALTHY',
      windows: { weekly: { percent_remaining: 80, reset_at: '2026-09-15T02:00:00.000Z' } }
    }
  },
  now: new Date('2026-09-15T01:00:00.000Z')
}).antigravity_3p;
assert.equal(useBeforeResetPool.scarcity_state, 'USE_BEFORE_RESET');
assert.ok(useBeforeResetPool.expected_unused_quota_at_reset > 0);

const stagedDecision = router.scoreAndSelectRoute({
  role: 'general_engineer',
  taskClass: 'refactor',
  dataClass: 'PUBLIC',
  useLiveAxi: false,
  telemetryRecords: []
});
assert.equal(stagedDecision.qualityFloor, qualityFloorForTask({ taskClass: 'refactor' }));
assert.ok(stagedDecision.allCandidates.length >= 3, 'staged fixture must expose multiple sufficient economic routes');
assert.ok(stagedDecision.allCandidates.every((candidate) => candidate.economics.expected_successful_quota_burn > 0));

const floorDecision = router.scoreAndSelectRoute({
  role: 'general_engineer',
  taskClass: 'refactor',
  dataClass: 'PUBLIC',
  qualityFloor: 0.95,
  useLiveAxi: false,
  telemetryRecords: []
});
assert.equal(floorDecision.selectedRoute.route_id, 'codex:gpt-5.6-terra:medium');
assert.ok(floorDecision.stages.stageB.rejected.some((entry) => entry.route_id === 'agy-3p:claude-sonnet-4-6'));
assert.ok(floorDecision.stages.stageB.rejected.some((entry) => entry.reason.includes('Quality floor rejected')));

const agyEarlyDecision = router.scoreAndSelectRoute({
  role: 'general_engineer',
  taskClass: 'refactor',
  dataClass: 'PUBLIC',
  useLiveAxi: false,
  telemetryRecords: [],
  quotaOverrides: {
    codex_plus: { status: 'HEALTHY', windows: { rolling_5h: { percent_remaining: 60 } } },
    claude_pro: { status: 'HEALTHY', windows: { seven_day: { percent_remaining: 80 } } },
    antigravity_3p: { status: 'HEALTHY', windows: { weekly: { percent_remaining: 100 } } }
  }
});
assert.equal(agyEarlyDecision.poolEconomics.claude_pro.actual_remaining > 25, true);
assert.equal(agyEarlyDecision.selectedRoute.route_id, 'agy-3p:claude-sonnet-4-6');
assert.equal(agyEarlyDecision.selectedRouteEconomics.resource_pool, 'antigravity_3p');
assert.equal(agyEarlyDecision.selectedRouteEconomics.shared_meter, false);
assert.deepEqual(Object.keys(agyEarlyDecision.poolEconomics).filter((name) => name.startsWith('opencode_go')), ['opencode_go']);

const opencodeCandidate = stagedDecision.allCandidates.find((candidate) => candidate.route_id === 'opencode:qwen3.7-max');
assert.ok(opencodeCandidate, 'OpenCode Go remains in the economic candidate set');
assert.equal(opencodeCandidate.economics.account_pool, 'opencode_go');
assert.equal(opencodeCandidate.economics.shared_meter, true);
assert.equal(opencodeCandidate.economics.model_burn_multiplier, 12.5);
console.log('Router V2 enforcement and ten-role regression fixtures passed');
