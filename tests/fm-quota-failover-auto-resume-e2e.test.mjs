import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRouterFixtureHome } from './router-v2-fixture.mjs';

const home = makeRouterFixtureHome();
const { normalizeQuotaAxiSnapshot } = await import('../bin/fm-quota-normalize.mjs');
const { scoreAndSelectRoute, dispatchThroughHerdr } = await import('../bin/fm-router-v2.mjs');

const provider = (schemaVersion) => ({
  schemaVersion,
  generatedAt: '2030-01-01T00:00:00Z',
  providers: [{
    provider: 'codex',
    state: { status: 'fresh', stale: false },
    quotaSemantics: {
      status: 'known',
      effectiveAvailability: [{
        scope: 'all_models',
        status: 'known',
        effectivePercentRemaining: 42,
        runway: { status: 'through_reset' }
      }]
    },
    windows: [{ id: 'five_hour', percentRemaining: 42, resetsAt: '2030-01-01T01:00:00Z' }]
  }]
});

assert.equal(normalizeQuotaAxiSnapshot(provider(3)).providers[0].provider, 'codex');
assert.equal(normalizeQuotaAxiSnapshot(provider(5)).providers[0].provenance.schema_version, 5);

const failed = scoreAndSelectRoute({
  role: 'general_engineer',
  dataClass: 'PUBLIC',
  useLiveAxi: false,
  quotaOverrides: { codex_plus: { scarcity_state: 'EXHAUSTED' }, claude_pro: { scarcity_state: 'UNKNOWN', windows: { seven_day: { percent_remaining: 10 } } } }
});
assert.equal(failed.selectedRoute.route_id, 'agy-3p:claude-sonnet-4-6');
assert.ok(failed.rejectedRoutes.some(item => item.route_id.startsWith('codex:gpt-5.6-terra')));

const taskId = 'resume-after-quota';
fs.mkdirSync(path.join(home, 'data', taskId), { recursive: true });
fs.writeFileSync(path.join(home, 'data', taskId, 'brief.md'), '# synthetic resume brief\n');
let spawnArgs;
const resumed = dispatchThroughHerdr({
  taskId,
  role: 'general_engineer',
  dataClass: 'PUBLIC',
  useLiveAxi: false,
  excludeRoutes: ['agy-3p:claude-sonnet-4-6'],
  quotaOverrides: { codex_plus: { scarcity_state: 'EXHAUSTED' }, claude_pro: { scarcity_state: 'UNKNOWN', windows: { seven_day: { percent_remaining: 10 } } } },
  spawnRunner: (args) => {
    spawnArgs = args;
    return { success: true, output: 'resumed synthetic worker' };
  }
});
assert.equal(resumed.success, true);
assert.ok(spawnArgs.includes('--backend'));
assert.equal(spawnArgs[spawnArgs.indexOf('--backend') + 1], 'herdr');

assert.throws(() => scoreAndSelectRoute({
  role: 'general_engineer',
  dataClass: 'PUBLIC',
  useLiveAxi: false,
  quotaOverrides: { codex_plus: { scarcity_state: 'EXHAUSTED' }, claude_pro: { scarcity_state: 'EXHAUSTED' }, antigravity_3p: { scarcity_state: 'EXHAUSTED' }, antigravity_gemini: { scarcity_state: 'EXHAUSTED' }, opencode_go: { scarcity_state: 'EXHAUSTED' } }
}), /No viable RouteTargets/);
console.log('Quota schema compatibility and failover/resume fixtures passed');
