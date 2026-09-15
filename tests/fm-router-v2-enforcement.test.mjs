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
  resolveLiveQuotaPools,
  dispatchThroughHerdr
} = router;

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
console.log('Router V2 enforcement and ten-role regression fixtures passed');
