import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRouterFixtureHome } from './router-v2-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const home = makeRouterFixtureHome();
const taskId = 'quota-failover-worker';
const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-quota-failover-e2e-'));
const fakeBin = path.join(lab, 'fakebin');
const repo = path.join(lab, 'repo');
const project = path.join(lab, 'project');
const fakeState = path.join(lab, 'fake-state');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function metaValue(file, key) {
  const line = fs.readFileSync(file, 'utf8').split('\n').find((item) => item.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : '';
}

function makeTmuxStub() {
  write(path.join(fakeBin, 'tmux'), `#!/usr/bin/env bash
set -u
D=$FM_FAKE_DIR
case "\${1:-}" in
  send-keys)
    shift
    literal=0
    while [ $# -gt 0 ]; do
      case "$1" in
        -t) shift 2 ;;
        -l) literal=1; shift ;;
        *) break ;;
      esac
    done
    payload=\${1:-}
    if [ "$literal" = 1 ]; then
      printf '%s\\n' "$payload" >> "$D/literal"
      case "$payload" in
        /exit|/quit) printf 'zsh' > "$D/command" ;;
        *'encode launch-brief'*) cat "$D/becomes" > "$D/command" ;;
      esac
    else
      printf '%s\\n' "$payload" >> "$D/keys"
    fi
    exit 0 ;;
  display-message)
    for arg in "$@"; do
      case "$arg" in
        *cursor_y*) printf '1\\n'; exit 0 ;;
        *pane_current_command*) cat "$D/command"; printf '\\n'; exit 0 ;;
        *pane_current_path*) cat "$D/cwd"; printf '\\n'; exit 0 ;;
      esac
    done
    printf 'fakepane\\n'; exit 0 ;;
  capture-pane) printf 'idle\\n'; exit 0 ;;
  list-windows) cat "$D/windows"; exit 0 ;;
  has-session) exit 0 ;;
esac
exit 0
`);
  fs.chmodSync(path.join(fakeBin, 'tmux'), 0o755);
}

function runFailover(args, extraEnv = {}) {
  return spawnSync('bash', [path.join(ROOT, 'bin', 'fm-failover.sh'), taskId, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: path.join(lab, 'home'),
      CLAUDE_CONFIG_DIR: '',
      FM_HOME: home,
      FM_FAKE_DIR: fakeState,
      FM_DISABLE_LIVE_QUOTA: '1',
      FM_FAILOVER_USE_LIVE_QUOTA: '0',
      FM_SPAWN_NO_GUARD: '1',
      FM_CONTROL_POLL: '0.01',
      FM_CONTROL_EXIT_WAIT: '0.05',
      FM_CONTROL_LAUNCH_WAIT: '0.05'
    }
  });
}

try {
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data', taskId), { recursive: true });
  fs.mkdirSync(path.join(lab, 'home'), { recursive: true });
  fs.mkdirSync(fakeState, { recursive: true });
  makeTmuxStub();

  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Firstmate Test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'firstmate-test@example.invalid'], { cwd: repo });
  write(path.join(repo, 'README.md'), '# synthetic worker\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'initial worker state'], { cwd: repo });
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'worker/failover', project, 'HEAD'], { cwd: repo });
  write(path.join(project, 'progress.txt'), 'worker A partial progress\n');

  write(path.join(home, 'data', taskId, 'brief.md'), '# Task\n\n## Captain\'s intent\nContinue the existing task and preserve its local progress.\n\n## Firstmate spec\nResume in the recorded worktree without creating a duplicate writer.\n');
  write(path.join(home, 'state', `${taskId}.meta`), [
    'window=fmses:fm-quota-failover-worker',
    `endpoint_task_id=${taskId}`,
    `worktree=${project}`,
    `project=${repo}`,
    'harness=codex',
    'kind=ship',
    'mode=local-only',
    'yolo=off',
    'tasktmp=/tmp/fm-quota-failover-worker',
    'model=gpt-5.6-terra',
    'effort=medium',
    'role=general_engineer',
    'data_class=PUBLIC',
    'route_id=codex:gpt-5.6-terra:medium'
  ].join('\n') + '\n');
  write(path.join(home, 'state', `${taskId}.status`), 'started: synthetic worker A made partial progress\nquota_exhausted: simulated without spending provider quota\n');
  write(path.join(fakeState, 'command'), 'codex');
  write(path.join(fakeState, 'becomes'), 'claude');
  write(path.join(fakeState, 'cwd'), project);
  write(path.join(fakeState, 'windows'), 'fm-quota-failover-worker\n');
  write(path.join(fakeState, 'literal'), '');
  write(path.join(fakeState, 'keys'), '');

  const result = runFailover(['--reason', 'QUOTA_EXHAUSTED', '--failed-route', 'codex:gpt-5.6-terra:medium']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Router V2 excluded codex RouteTargets/);
  assert.match(result.stdout, /relaunched quota-failover-worker harness=claude from=codex/);
  assert.match(result.stdout, /quota failover complete/);

  const decisionPath = path.join(home, 'data', taskId, 'failover-decision.json');
  const decision = JSON.parse(fs.readFileSync(decisionPath, 'utf8'));
  assert.equal(decision.phase, 'complete');
  assert.equal(decision.failed_harness, 'codex');
  assert.equal(decision.selected_harness, 'claude');
  assert.equal(decision.selected_route, 'claude:claude-sonnet-5:medium');
  assert.ok(decision.route_target.route_id.startsWith('claude:'));

  const metaPath = path.join(home, 'state', `${taskId}.meta`);
  assert.equal(metaValue(metaPath, 'harness'), 'claude');
  assert.equal(metaValue(metaPath, 'model'), 'claude-sonnet-5');
  assert.equal(metaValue(metaPath, 'worktree'), project);
  assert.equal(metaValue(metaPath, 'role'), 'general_engineer');
  assert.equal(metaValue(metaPath, 'data_class'), 'PUBLIC');
  assert.equal(metaValue(metaPath, 'route_id'), 'claude:claude-sonnet-5:medium');
  assert.equal(fs.readFileSync(path.join(fakeState, 'command'), 'utf8'), 'claude');
  assert.equal(fs.readFileSync(path.join(fakeState, 'cwd'), 'utf8'), project);

  const literals = fs.readFileSync(path.join(fakeState, 'literal'), 'utf8').trim().split('\n');
  assert.equal(literals.filter((line) => line === '/quit').length, 1);
  assert.equal(literals.filter((line) => line.includes('encode launch-brief')).length, 1);
  assert.equal(fs.readFileSync(path.join(project, 'progress.txt'), 'utf8'), 'worker A partial progress\n');
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: project, encoding: 'utf8' }).trim(), 'worker/failover');

  fs.appendFileSync(path.join(project, 'progress.txt'), 'worker B completed after failover\n');
  execFileSync('git', ['add', 'progress.txt'], { cwd: project });
  execFileSync('git', ['commit', '-qm', 'complete worker task after quota failover'], { cwd: project });
  assert.match(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: project, encoding: 'utf8' }), /complete worker task/);

  const repeat = runFailover(['--reason', 'QUOTA_EXHAUSTED']);
  assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
  assert.match(repeat.stdout, /failover already complete/);
  const literalsAfterRepeat = fs.readFileSync(path.join(fakeState, 'literal'), 'utf8').trim().split('\n');
  assert.equal(literalsAfterRepeat.filter((line) => line.includes('encode launch-brief')).length, 1);

  const missingStateHome = makeRouterFixtureHome();
  const missingState = spawnSync('bash', [path.join(ROOT, 'bin', 'fm-failover.sh'), 'missing-state-task'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, FM_HOME: missingStateHome, FM_DISABLE_LIVE_QUOTA: '1' }
  });
  assert.notEqual(missingState.status, 0);
  assert.match(missingState.stderr, /state dir .* is missing/);
  assert.equal(fs.existsSync(path.join(missingStateHome, 'state')), false);

  console.log('Worker quota failover E2E passed: Router V2 -> control relaunch -> same worktree -> completion');
} finally {
  fs.rmSync(lab, { recursive: true, force: true });
}
