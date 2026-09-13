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
assert.equal(evaluateDataGate('WORK_CORPORATE', 'claude_consumer').allowed, false);
assert.equal(evaluateDataGate('PERSONAL_PRIVATE', 'claude_consumer').allowed, true);
assert.equal(evaluateDataGate('PERSONAL_PRIVATE', 'opencode_go_cn').allowed, false);
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
console.log('Router V2 enforcement and ten-role regression fixtures passed');
