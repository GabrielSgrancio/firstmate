import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRouterFixtureHome } from './router-v2-fixture.mjs';

const home = makeRouterFixtureHome();
const { dispatchThroughHerdr } = await import('../bin/fm-router-v2.mjs');

function provision(taskId) {
  fs.mkdirSync(path.join(home, 'data', taskId), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', taskId, 'brief.md'), '# synthetic brief\n');
}

// One dispatch per harness.  The brownfield quality floor (0.93) rejects the
// fixture's gpt-5.6-sol (P=0.90), so Codex is covered through general_engineer
// and deep_engineer is expected to reach claude-opus-5 instead.
for (const [taskId, role, harness, model, effort] of [
  ['codex-dispatch', 'general_engineer', 'codex', 'gpt-5.6-terra', 'medium'],
  ['deep-dispatch', 'deep_engineer', 'claude', 'claude-opus-5', 'high'],
  ['claude-dispatch', 'autonomous_engineer', 'claude', 'claude-sonnet-5', 'medium'],
  ['opencode-dispatch', 'strong_cheap_worker', 'opencode', 'opencode-go/qwen3.7-max', null],
  ['agy-dispatch', 'fast_context', 'antigravity', 'gemini-3.8-flash-low', 'low']
]) {
  provision(taskId);
  let invocation;
  const result = dispatchThroughHerdr({
    taskId,
    role,
    dataClass: 'PUBLIC',
    targetEffort: effort,
    useLiveAxi: false,
    spawnRunner: (args) => {
      invocation = args;
      fs.mkdirSync(path.join(home, 'state'), { recursive: true });
      fs.writeFileSync(path.join(home, 'state', taskId + '.meta'), [
        'backend=herdr',
        'harness=' + harness,
        'model=' + model,
        'effort=' + (effort || ''),
        'window=synthetic-window'
      ].join('\n') + '\n');
      return { success: true, output: 'synthetic herdr launch' };
    }
  });
  assert.equal(result.success, true);
  assert.equal(result.selectedRoute.harness, harness);
  assert.equal(result.selectedRoute.resolved_runtime_model, model);
  assert.ok(invocation.includes('--backend'));
  assert.equal(invocation[invocation.indexOf('--backend') + 1], 'herdr');
  assert.ok(fs.readFileSync(path.join(home, 'data', 'routing-executions.jsonl'), 'utf8').includes(taskId));
}

// The quality floor stays in force: without Opus, no deep route qualifies.
provision('deep-floor-dispatch');
assert.throws(() => dispatchThroughHerdr({
  taskId: 'deep-floor-dispatch',
  role: 'deep_engineer',
  dataClass: 'PUBLIC',
  targetEffort: 'high',
  useLiveAxi: false,
  excludeRoutes: ['claude:claude-opus-5:high', 'agy-3p:claude-opus-4-6-thinking'],
  spawnRunner: () => assert.fail('no route may launch below the quality floor')
}), /No routes meet quality floor 0\.9300.*codex:gpt-5\.6-sol:high: Quality floor rejected route/);

assert.throws(() => dispatchThroughHerdr({
  taskId: 'unprovisioned',
  role: 'general_engineer',
  dataClass: 'PUBLIC',
  useLiveAxi: false,
  spawnRunner: () => ({ success: true })
}), /must be provisioned/);
console.log('Herdr dispatch contract fixtures passed');
