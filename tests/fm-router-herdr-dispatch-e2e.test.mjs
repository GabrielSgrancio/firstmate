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

for (const [taskId, role, model, effort] of [
  ['codex-dispatch', 'deep_engineer', 'gpt-5.6-sol', 'high'],
  ['claude-dispatch', 'autonomous_engineer', 'claude-sonnet-5', 'medium'],
  ['opencode-dispatch', 'strong_cheap_worker', 'opencode-go/qwen3.7-max', null],
  ['agy-dispatch', 'fast_context', 'gemini-3.8-flash-low', 'low']
]) {
  provision(taskId);
  let invocation;
  const result = dispatchThroughHerdr({
    taskId,
    role,
    dataClass: 'PUBLIC',
    targetEffort: effort,
    useLiveAxi: false,
    ...(role === 'deep_engineer' ? { excludeRoutes: ['claude:claude-opus-5:high', 'agy-3p:claude-opus-4-6-thinking'] } : {}),
    spawnRunner: (args) => {
      invocation = args;
      fs.mkdirSync(path.join(home, 'state'), { recursive: true });
      fs.writeFileSync(path.join(home, 'state', taskId + '.meta'), [
        'backend=herdr',
        'harness=' + (role === 'fast_context' ? 'antigravity' : resultHarness(role)),
        'model=' + model,
        'effort=' + (effort || ''),
        'window=synthetic-window'
      ].join('\n') + '\n');
      return { success: true, output: 'synthetic herdr launch' };
    }
  });
  assert.equal(result.success, true);
  assert.equal(result.selectedRoute.resolved_runtime_model, model);
  assert.ok(invocation.includes('--backend'));
  assert.equal(invocation[invocation.indexOf('--backend') + 1], 'herdr');
  assert.ok(fs.readFileSync(path.join(home, 'data', 'routing-executions.jsonl'), 'utf8').includes(taskId));
}

function resultHarness(role) {
  if (role === 'deep_engineer') return 'codex';
  if (role === 'deep_engineer') return 'claude';
  if (role === 'strong_cheap_worker') return 'opencode';
  return 'claude';
}

assert.throws(() => dispatchThroughHerdr({
  taskId: 'unprovisioned',
  role: 'general_engineer',
  dataClass: 'PUBLIC',
  useLiveAxi: false,
  spawnRunner: () => ({ success: true })
}), /must be provisioned/);
console.log('Herdr dispatch contract fixtures passed');
