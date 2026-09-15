import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRouterFixtureHome } from './router-v2-fixture.mjs';

const ROUTER_BIN = fileURLToPath(new URL('../bin/fm-router-v2.mjs', import.meta.url));
const home = makeRouterFixtureHome();
const router = await import('../bin/fm-router-v2.mjs');
const {
  dispatchThroughHerdr,
  ingressDispatchStarted,
  ingressDispatchDispatched,
  ingressDispatchFailed,
  recordTaskCompletion
} = router;

const logPath = path.join(home, 'data', 'routing-executions.jsonl');

function readTelemetry() {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function provisionBrief(taskId) {
  const dir = path.join(home, 'data', taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'brief.md'), `# synthetic brief for ${taskId}\n`);
}

console.log('--- Test 1: Path A (Router V2 / Orchestrator API) full lifecycle ---');
{
  const taskId = 'test-path-a-lifecycle';
  provisionBrief(taskId);

  let capturedSpawnArgs = null;
  const result = dispatchThroughHerdr({
    taskId,
    role: 'general_engineer',
    dataClass: 'PUBLIC',
    useLiveAxi: false,
    spawnRunner: (args) => {
      capturedSpawnArgs = args;
      fs.mkdirSync(path.join(home, 'state'), { recursive: true });
      fs.writeFileSync(
        path.join(home, 'state', `${taskId}.meta`),
        [
          'backend=herdr',
          'harness=codex',
          'model=gpt-5.6-terra',
          'effort=medium',
          'window=synthetic-win-1',
          'worktree=/tmp/wt-path-a',
          'pid=12345',
          `route_execution_id=${args[args.indexOf('--route-execution-id') + 1] || ''}`,
          `parent_route_execution_id=${args[args.indexOf('--parent-execution-id') + 1] || ''}`
        ].join('\n') + '\n'
      );
      return { success: true, output: 'synthetic herdr launch success' };
    }
  });

  assert.equal(result.success, true);
  const routeExecId = result.routeExecutionId;
  assert.ok(routeExecId, 'must have routeExecutionId');
  assert.equal(result.executionId, routeExecId);

  // Check spawn args passed route-execution-id and parent-execution-id
  assert.ok(capturedSpawnArgs.includes('--route-execution-id'));
  assert.equal(capturedSpawnArgs[capturedSpawnArgs.indexOf('--route-execution-id') + 1], routeExecId);
  assert.ok(capturedSpawnArgs.includes('--parent-execution-id'));
  assert.equal(capturedSpawnArgs[capturedSpawnArgs.indexOf('--parent-execution-id') + 1], routeExecId);

  // Now record task completion
  const completion = recordTaskCompletion(taskId, { terminalState: 'SUCCESS', resultSummary: 'all done' });
  assert.equal(completion.route_execution_id, routeExecId, 'completion must reuse stable route_execution_id');
  assert.equal(completion.parent_route_execution_id, routeExecId);
  assert.equal(completion.dispatch_status, 'completed');
  assert.equal(completion.lifecycle_state, 'COMPLETED');
  assert.equal(completion.terminal_state, 'SUCCESS');
  assert.ok(completion.quota_snapshot_after, 'quota_snapshot_after must be recorded');

  // Verify telemetry log entries for Path A
  const records = readTelemetry().filter(r => r.task_id === taskId);
  assert.equal(records.length, 5, 'selected, launching, dispatched, running, completed');

  const [started, launching, dispatched, running, completed] = records;

  // Verify started record
  assert.equal(started.route_execution_id, routeExecId);
  assert.equal(started.parent_route_execution_id, routeExecId);
  assert.equal(started.dispatch_path, 'A');
  assert.equal(started.dispatch_status, 'started');
  assert.equal(started.lifecycle_state, 'SELECTED');
  assert.equal(started.task_classification, 'general_engineer');
  assert.equal(started.data_class, 'PUBLIC');
  assert.ok(Array.isArray(started.candidate_routes), 'candidate_routes must be array');
  assert.ok(started.candidate_routes.length > 0, 'must have considered candidates');
  assert.equal(started.candidate_route_set_marker, null);
  assert.equal(started.route_decision.decision_type, 'router_v2');
  assert.equal(started.route_decision.route_id, started.selected_route_id);
  assert.ok(started.quota_snapshot_before, 'quota snapshot before must be captured');
  assert.ok(started.started_at, 'started_at timestamp must be present');

  assert.equal(launching.route_execution_id, routeExecId);
  assert.equal(launching.dispatch_status, 'launching');
  assert.equal(launching.lifecycle_state, 'LAUNCHING');
  assert.ok(launching.launching_at, 'launching_at timestamp must be present');

  // Verify dispatched record
  assert.equal(dispatched.route_execution_id, routeExecId);
  assert.equal(dispatched.parent_route_execution_id, routeExecId);
  assert.equal(dispatched.dispatch_status, 'dispatched');
  assert.equal(dispatched.lifecycle_state, 'DISPATCHED');
  assert.equal(dispatched.actual_harness, 'codex');
  assert.equal(dispatched.actual_model, 'gpt-5.6-terra');
  assert.equal(dispatched.actual_effort, 'medium');
  assert.equal(dispatched.worktree, '/tmp/wt-path-a');
  assert.equal(dispatched.pid, 12345);
  assert.ok(dispatched.dispatched_at, 'dispatched_at timestamp must be present');

  assert.equal(running.route_execution_id, routeExecId);
  assert.equal(running.dispatch_status, 'running');
  assert.equal(running.lifecycle_state, 'RUNNING');
  assert.equal(running.actual_model, 'gpt-5.6-terra');
  assert.ok(running.running_at, 'running_at timestamp must be present');

  // Verify completed record
  assert.equal(completed.route_execution_id, routeExecId);
  assert.equal(completed.parent_route_execution_id, routeExecId);
  assert.equal(completed.dispatch_status, 'completed');
  assert.equal(completed.lifecycle_state, 'COMPLETED');
  assert.equal(completed.terminal_state, 'SUCCESS');
  assert.ok(completed.quota_snapshot_after, 'quota snapshot after must be captured');
  assert.ok(completed.completed_at, 'completed_at timestamp must be present');

  // Test idempotency: calling completion again returns existing without duplicating log
  const beforeLen = readTelemetry().length;
  const completionDup = recordTaskCompletion(taskId, { terminalState: 'SUCCESS' });
  assert.equal(completionDup.route_execution_id, routeExecId);
  assert.equal(readTelemetry().length, beforeLen, 'idempotent completion must not duplicate records');
}

console.log('--- Test 2: Path A recursive retry on launch failure ---');
{
  const taskId = 'test-path-a-retry-linking';
  provisionBrief(taskId);

  let attempt = 0;
  const result = dispatchThroughHerdr({
    taskId,
    role: 'autonomous_engineer',
    dataClass: 'PUBLIC',
    useLiveAxi: false,
    spawnRunner: (args) => {
      attempt++;
      if (attempt === 1) {
        return { success: false, error: 'first route failed to launch' };
      }
      fs.mkdirSync(path.join(home, 'state'), { recursive: true });
      fs.writeFileSync(
        path.join(home, 'state', `${taskId}.meta`),
        'backend=herdr\nharness=claude\nmodel=claude-sonnet-4-6\neffort=medium\nwindow=win-retry\n'
      );
      return { success: true, output: 'second route launch success' };
    }
  });

  assert.equal(result.success, true);
  assert.equal(attempt, 2);

  const records = readTelemetry().filter(r => r.task_id === taskId);
  assert.equal(records.length, 7, 'attempt 1 selected/launching/failed, attempt 2 selected/launching/dispatched/running');

  const [attempt1Started, attempt1Launching, attempt1Failed, attempt2Started, attempt2Launching, attempt2Dispatched, attempt2Running] = records;
  const parentId = attempt1Started.route_execution_id;

  assert.equal(attempt1Started.attempt_number, 1);
  assert.equal(attempt1Started.retry_count, 0);
  assert.equal(attempt1Started.parent_route_execution_id, parentId);
  assert.equal(attempt1Launching.lifecycle_state, 'LAUNCHING');

  assert.equal(attempt1Failed.route_execution_id, parentId);
  assert.equal(attempt1Failed.parent_route_execution_id, parentId);
  assert.equal(attempt1Failed.dispatch_status, 'launch_failed');
  assert.equal(attempt1Failed.lifecycle_state, 'FAILED');
  assert.equal(attempt1Failed.attempt_number, 1);
  assert.equal(attempt1Failed.retry_count, 0);

  // Attempt 2 must be explicitly linked via parent_route_execution_id and have retry counter
  assert.equal(attempt2Started.parent_route_execution_id, parentId, 'must link to parent execution id');
  assert.equal(attempt2Started.attempt_number, 2, 'attempt number must be 2');
  assert.equal(attempt2Started.retry_count, 1, 'retry count must be 1');
  assert.equal(attempt2Started.route_execution_id, `${parentId}:retry-1`);
  assert.equal(attempt2Launching.route_execution_id, `${parentId}:retry-1`);
  assert.equal(attempt2Launching.lifecycle_state, 'LAUNCHING');

  assert.equal(attempt2Dispatched.parent_route_execution_id, parentId);
  assert.equal(attempt2Dispatched.route_execution_id, `${parentId}:retry-1`);
  assert.equal(attempt2Dispatched.dispatch_status, 'dispatched');
  assert.equal(attempt2Dispatched.lifecycle_state, 'DISPATCHED');
  assert.equal(attempt2Dispatched.attempt_number, 2);
  assert.equal(attempt2Dispatched.retry_count, 1);
  assert.equal(attempt2Running.route_execution_id, `${parentId}:retry-1`);
  assert.equal(attempt2Running.lifecycle_state, 'RUNNING');
}

console.log('--- Test 3: Path B (Legacy / Manual) unified ingress ---');
{
  const taskId = 'test-path-b-legacy-manual';

  // Test CLI invocation of ingress-start (as fm-spawn.sh does)
  const startOut = execFileSync(
    process.execPath,
    [
      ROUTER_BIN,
      'ingress-start',
      '--task-id', taskId,
      '--route-execution-id', 'rex-path-b-001',
      '--parent-execution-id', 'rex-path-b-001',
      '--path', 'B',
      '--task-classification', 'crewmate',
      '--harness', 'claude',
      '--model', 'claude-sonnet-5',
      '--effort', 'medium'
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, FM_HOME: home }
    }
  );
  const startObj = JSON.parse(startOut);
  assert.equal(startObj.route_execution_id, 'rex-path-b-001');
  assert.equal(startObj.dispatch_path, 'B');
  assert.equal(startObj.dispatch_status, 'started');
  assert.equal(startObj.lifecycle_state, 'SELECTED');
  assert.equal(startObj.candidate_routes, null);
  assert.equal(startObj.candidate_route_set_marker, 'legacy/manual decision, no candidate set evaluated');
  assert.equal(startObj.route_decision.decision_type, 'legacy_manual');
  assert.equal(startObj.route_decision.marker, 'legacy/manual decision, no candidate set evaluated');
  assert.equal(startObj.route_decision.harness, 'claude');
  assert.equal(startObj.route_decision.model, 'claude-sonnet-5');
  assert.ok(startObj.quota_snapshot_before, 'quota snapshot before must be captured in Path B');
  assert.equal(startObj.data_class, null);
  assert.equal(startObj.classification_status, 'UNCLASSIFIED_LEGACY');

  const launchingOut = execFileSync(
    process.execPath,
    [
      ROUTER_BIN,
      'ingress-launching',
      '--task-id', taskId,
      '--route-execution-id', 'rex-path-b-001',
      '--parent-execution-id', 'rex-path-b-001',
      '--path', 'B',
      '--harness', 'claude',
      '--model', 'claude-sonnet-5',
      '--effort', 'medium'
    ],
    { encoding: 'utf8', env: { ...process.env, FM_HOME: home } }
  );
  const launchingObj = JSON.parse(launchingOut);
  assert.equal(launchingObj.lifecycle_state, 'LAUNCHING');

  // Test CLI invocation of ingress-dispatched
  const dispOut = execFileSync(
    process.execPath,
    [
      ROUTER_BIN,
      'ingress-dispatched',
      '--task-id', taskId,
      '--route-execution-id', 'rex-path-b-001',
      '--parent-execution-id', 'rex-path-b-001',
      '--path', 'B',
      '--actual-harness', 'claude',
      '--actual-model', 'claude-sonnet-5',
      '--actual-effort', 'medium',
      '--worker-id', 'win-path-b',
      '--worktree', '/tmp/wt-path-b',
      '--backend', 'tmux',
      '--pid', '65432'
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, FM_HOME: home }
    }
  );
  const dispObj = JSON.parse(dispOut);
  assert.equal(dispObj.route_execution_id, 'rex-path-b-001');
  assert.equal(dispObj.dispatch_status, 'dispatched');
  assert.equal(dispObj.lifecycle_state, 'DISPATCHED');
  assert.equal(dispObj.actual_harness, 'claude');
  assert.equal(dispObj.actual_model, 'claude-sonnet-5');
  assert.equal(dispObj.herdr_worker_id, 'win-path-b');
  assert.equal(dispObj.pid, 65432);

  const runningOut = execFileSync(
    process.execPath,
    [
      ROUTER_BIN,
      'ingress-running',
      '--task-id', taskId,
      '--route-execution-id', 'rex-path-b-001',
      '--parent-execution-id', 'rex-path-b-001',
      '--path', 'B',
      '--harness', 'claude',
      '--model', 'claude-sonnet-5',
      '--effort', 'medium',
      '--actual-harness', 'claude',
      '--actual-model', 'claude-sonnet-5',
      '--actual-effort', 'medium',
      '--worker-id', 'win-path-b',
      '--worktree', '/tmp/wt-path-b',
      '--backend', 'tmux',
      '--pid', '65432'
    ],
    { encoding: 'utf8', env: { ...process.env, FM_HOME: home } }
  );
  const runningObj = JSON.parse(runningOut);
  assert.equal(runningObj.lifecycle_state, 'RUNNING');

  // Write meta for completion read
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'state', `${taskId}.meta`),
    [
      'backend=tmux',
      'harness=claude',
      'model=claude-sonnet-5',
      'effort=medium',
      'route_execution_id=rex-path-b-001',
      'parent_route_execution_id=rex-path-b-001'
    ].join('\n') + '\n'
  );

  // Complete task via CLI
  const compOut = execFileSync(
    process.execPath,
    [
      ROUTER_BIN,
      'complete',
      taskId,
      'SUCCESS',
      'Path B task completed cleanly'
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, FM_HOME: home }
    }
  );
  const compObj = JSON.parse(compOut);
  assert.equal(compObj.route_execution_id, 'rex-path-b-001');
  assert.equal(compObj.dispatch_status, 'completed');
  assert.equal(compObj.lifecycle_state, 'COMPLETED');
  assert.equal(compObj.terminal_state, 'SUCCESS');
  assert.ok(compObj.quota_snapshot_after);

  const bRecords = readTelemetry().filter(r => r.task_id === taskId);
  assert.equal(bRecords.length, 5);
  assert.ok(bRecords.every(r => r.route_execution_id === 'rex-path-b-001'), 'all records must share stable route_execution_id');
  assert.equal(bRecords[0].candidate_route_set_marker, 'legacy/manual decision, no candidate set evaluated');
  assert.equal(bRecords[0].route_decision.decision_type, 'legacy_manual');
  assert.equal(bRecords[0].data_class, null);
  assert.equal(bRecords[0].classification_status, 'UNCLASSIFIED_LEGACY');
}

console.log('--- Test 4: Secondmate Relaunch (Bootstrap Bypass Closure) ---');
{
  const taskId = 'test-secondmate-relaunch';

  const startOut = execFileSync(
    process.execPath,
    [
      ROUTER_BIN,
      'ingress-start',
      '--task-id', taskId,
      '--route-execution-id', 'rex-sm-001',
      '--parent-execution-id', 'rex-sm-001',
      '--path', 'B',
      '--task-classification', 'secondmate',
      '--harness', 'claude',
      '--model', 'default',
      '--effort', 'default',
      '--secondmate-relaunch'
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, FM_HOME: home }
    }
  );
  const startObj = JSON.parse(startOut);
  assert.equal(startObj.route_execution_id, 'rex-sm-001');
  assert.equal(startObj.dispatch_type, 'system_internal_relaunch');
  assert.equal(startObj.candidate_route_set_marker, 'system-internal relaunch, no candidate set evaluated');
  assert.equal(startObj.route_decision.decision_type, 'system_internal_relaunch');

  const dispOut = execFileSync(
    process.execPath,
    [
      ROUTER_BIN,
      'ingress-dispatched',
      '--task-id', taskId,
      '--route-execution-id', 'rex-sm-001',
      '--parent-execution-id', 'rex-sm-001',
      '--path', 'B',
      '--actual-harness', 'claude',
      '--actual-model', 'default',
      '--actual-effort', 'default',
      '--worker-id', 'win-sm',
      '--secondmate-relaunch'
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, FM_HOME: home }
    }
  );
  const dispObj = JSON.parse(dispOut);
  assert.equal(dispObj.route_execution_id, 'rex-sm-001');
  assert.equal(dispObj.dispatch_type, 'system_internal_relaunch');
  assert.equal(dispObj.dispatch_status, 'dispatched');
}

console.log('--- Test 5: End-to-end real dispatches through fm-spawn.sh and fm-router-v2.mjs ---');
{
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const SPAWN_SH = path.join(ROOT, 'bin', 'fm-spawn.sh');
  const TEARDOWN_SH = path.join(ROOT, 'bin', 'fm-teardown.sh');
  const HOLD_SH = path.join(ROOT, 'bin', 'fm-captain-hold.sh');

  const realHome = makeRouterFixtureHome();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-real-dispatch-e2e-'));
  const repoDir = path.join(tempDir, 'repo');
  const fakeBin = path.join(tempDir, 'bin');
  const currentWtFile = path.join(tempDir, 'current-wt');

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });

  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Firstmate Test'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@firstmate.invalid'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-qm', 'initial commit'], { cwd: repoDir });

  // Treehouse stub
  const treehouseStub = path.join(fakeBin, 'treehouse');
  fs.writeFileSync(treehouseStub, `#!/usr/bin/env bash
case "\$1" in
  get)
    if [ -f "${currentWtFile}" ]; then
      cd "\$(cat "${currentWtFile}")"
    fi
    exec bash -l
    ;;
  return)
    target="\${2:-\$1}"
    git -C "${repoDir}" worktree remove --force "\$target" 2>/dev/null || true
    exit 0
    ;;
  status)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
  fs.chmodSync(treehouseStub, 0o755);

  // Tmux stub
  const tmuxStub = path.join(fakeBin, 'tmux');
  fs.writeFileSync(tmuxStub, `#!/usr/bin/env bash
case "\$1" in
  display-message)
    for arg in "\$@"; do
      case "\$arg" in
        *cursor_y*) printf '1\\n'; exit 0 ;;
        *pane_current_command*) printf 'zsh\\n'; exit 0 ;;
        *pane_current_path*)
          if [ -f "${currentWtFile}" ]; then
            cat "${currentWtFile}"
            printf '\\n'
            exit 0
          fi
          printf '%s\\n' "${repoDir}"
          exit 0 ;;
      esac
    done
    printf 'win-1\\n'
    exit 0 ;;
  new-window|new-session)
    exit 0 ;;
  send-keys)
    exit 0 ;;
  capture-pane)
    printf 'ready\\n'
    exit 0 ;;
  has-session)
    exit 0 ;;
  kill-window|kill-session)
    exit 0 ;;
  *)
    exit 0 ;;
esac
`);
  fs.chmodSync(tmuxStub, 0o755);

  const prevPath = process.env.PATH;
  const prevFmHome = process.env.FM_HOME;
  const prevNoGuard = process.env.FM_SPAWN_NO_GUARD;

  process.env.PATH = `${fakeBin}:${process.env.PATH}`;
  process.env.FM_SPAWN_NO_GUARD = '1';
  process.env.FM_HOME = realHome;

  const realEnv = { ...process.env };

  try {
    // 5a: Real Path B dispatch via fm-spawn.sh
    const taskIdB = 'real-path-b-e2e';
    const dirB = path.join(realHome, 'data', taskIdB);
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(
      path.join(dirB, 'brief.md'),
      '# Task\n\n## Captain\'s intent\nReal Path B dispatch.\n\n## Firstmate spec\nVerify telemetry ingress.\n'
    );

    const wtB = path.join(tempDir, 'wt-b');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt-b', wtB, 'HEAD'], { cwd: repoDir });
    fs.writeFileSync(currentWtFile, wtB);

    const spawnRefused = (args) => {
      try {
        execFileSync('bash', [SPAWN_SH, ...args], { encoding: 'utf8', env: realEnv, stdio: 'pipe' });
      } catch (error) {
        return String(error.stderr);
      }
      assert.fail(`spawn unexpectedly succeeded: ${args.join(' ')}`);
    };

    // A home carrying Router V3 inputs is enforced by default: a legacy spawn is
    // refused before any endpoint exists, and so is a hand-passed router execution
    // id with no recorded router selection behind it.
    assert.match(
      spawnRefused([taskIdB, repoDir, '--scout', 'bash -c "sleep 1"', '--backend', 'tmux']),
      /router dispatch authority is enforced/
    );
    assert.match(
      spawnRefused([taskIdB, repoDir, '--scout', 'bash -c "sleep 1"', '--backend', 'tmux',
        '--route-id', 'codex:gpt-5.6-terra:medium', '--route-execution-id', 'rex-forged-1', '--data-class', 'PUBLIC']),
      /router selection could not be verified: .*no router selection is recorded/
    );
    assert.match(
      spawnRefused([taskIdB, repoDir, '--scout', 'bash -c "sleep 1"', '--backend', 'tmux', '--manual-override', 'captain picked it']),
      /needs --data-class/
    );
    assert.match(
      spawnRefused([taskIdB, repoDir, '--scout', '--harness', 'codex', '--backend', 'tmux',
        '--manual-override', 'captain picked it', '--data-class', 'SECRET']),
      /SECRET data is strictly excluded/
    );
    assert.match(
      spawnRefused([taskIdB, repoDir, '--scout', '--harness', 'claude', '--model', 'claude-fable-5-1', '--backend', 'tmux',
        '--manual-override', 'captain picked it', '--data-class', 'PUBLIC']),
      /refused by the subscription-only spend policy/
    );
    assert.match(
      spawnRefused([taskIdB, repoDir, '--scout', '--harness', 'opencode', '--model', 'opencode-go/payg-sentinel-model', '--backend', 'tmux',
        '--manual-override', 'captain picked it', '--data-class', 'PRIVATE_CODE']),
      /refused by the subscription-only spend policy/
    );
    // A recorded PUBLIC router selection cannot be replayed as a SECRET or
    // differently classified spawn.
    router.ingressDispatchStarted({
      taskId: 'replayed-provenance-e2e', routeExecutionId: 'rex-replayed-public', path: 'A',
      dataClass: 'PUBLIC', quotaSnapshotBefore: {}, routeDecision: { decision_type: 'router_v2' },
      selectedRouteId: 'codex:gpt-5.6-terra:medium', selectedHarness: 'codex', selectedModel: 'gpt-5.6-terra',
      selectedEffort: 'medium'
    });
    const replay = (dataClass) => ['replayed-provenance-e2e', repoDir, '--scout', '--harness', 'codex', '--model', 'gpt-5.6-terra',
      '--effort', 'medium', '--backend', 'tmux', '--route-id', 'codex:gpt-5.6-terra:medium',
      '--route-execution-id', 'rex-replayed-public', '--data-class', dataClass];
    assert.match(spawnRefused(replay('SECRET')), /SECRET data is strictly excluded/);
    assert.match(spawnRefused(replay('PRIVATE_CODE')), /router selection could not be verified: .*data class PUBLIC/);
    assert.ok(!fs.existsSync(path.join(realHome, 'state', `${taskIdB}.meta`)), 'refused spawns create no task record');

    // Advisory authority keeps the legacy path.
    const authorityFile = path.join(realHome, 'config', 'router-authority');
    fs.writeFileSync(authorityFile, 'advisory\n');
    const spawnOutB = execFileSync(
      'bash',
      [SPAWN_SH, taskIdB, repoDir, '--scout', 'bash -c "sleep 1"', '--backend', 'tmux'],
      { encoding: 'utf8', env: realEnv }
    );
    assert.match(spawnOutB, new RegExp(`spawned ${taskIdB}`));
    fs.rmSync(authorityFile);

    const metaB = fs.readFileSync(path.join(realHome, 'state', `${taskIdB}.meta`), 'utf8');
    assert.match(metaB, /route_execution_id=rex-/);

    fs.writeFileSync(path.join(realHome, 'data', taskIdB, 'report.md'), '# Scout Report\n\nCompleted.\n');
    execFileSync('bash', [HOLD_SH, 'complete', taskIdB, '--none'], { env: realEnv });

    const teardownOutB = execFileSync(
      'bash',
      [TEARDOWN_SH, taskIdB],
      { cwd: tempDir, encoding: 'utf8', env: realEnv }
    );
    assert.match(teardownOutB, new RegExp(`teardown ${taskIdB} complete`));

    // 5a': Explicit manual override under enforced authority.
    const taskIdO = 'real-override-e2e';
    fs.mkdirSync(path.join(realHome, 'data', taskIdO), { recursive: true });
    fs.writeFileSync(
      path.join(realHome, 'data', taskIdO, 'brief.md'),
      '# Task\n\n## Captain\'s intent\nManual override dispatch.\n\n## Firstmate spec\nVerify override audit.\n'
    );
    const wtO = path.join(tempDir, 'wt-o');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt-o', wtO, 'HEAD'], { cwd: repoDir });
    fs.writeFileSync(currentWtFile, wtO);
    const spawnOutO = execFileSync(
      'bash',
      [SPAWN_SH, taskIdO, repoDir, '--scout', '--harness', 'codex', '--model', 'gpt-5.6-terra', '--backend', 'tmux',
        '--manual-override', 'captain chose this worker explicitly', '--data-class', 'PUBLIC'],
      { encoding: 'utf8', env: realEnv, stdio: 'pipe' }
    );
    assert.match(spawnOutO, new RegExp(`spawned ${taskIdO}`));
    fs.writeFileSync(path.join(realHome, 'data', taskIdO, 'report.md'), '# Scout Report\n\nCompleted.\n');
    execFileSync('bash', [HOLD_SH, 'complete', taskIdO, '--none'], { env: realEnv });
    execFileSync('bash', [TEARDOWN_SH, taskIdO], { cwd: tempDir, encoding: 'utf8', env: realEnv });

    // 5b: Real Path A dispatch via dispatchThroughHerdr
    const taskIdA = 'real-path-a-e2e';
    const dirA = path.join(realHome, 'data', taskIdA);
    fs.mkdirSync(dirA, { recursive: true });
    fs.writeFileSync(
      path.join(dirA, 'brief.md'),
      '# Task\n\n## Captain\'s intent\nReal Path A dispatch.\n\n## Firstmate spec\nVerify telemetry ingress.\n'
    );

    const wtA = path.join(tempDir, 'wt-a');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt-a', wtA, 'HEAD'], { cwd: repoDir });
    fs.writeFileSync(currentWtFile, wtA);

    const resultA = dispatchThroughHerdr({
      taskId: taskIdA,
      role: 'general_engineer',
      dataClass: 'PUBLIC',
      projectDir: repoDir,
      useLiveAxi: false,
      backend: 'tmux'
    });
    if (!resultA.success) {
      console.error('RESULT A FAILED:', JSON.stringify(resultA, null, 2));
    }
    assert.equal(resultA.success, true);
    assert.ok(resultA.routeExecutionId.startsWith('rex-'));

    fs.writeFileSync(path.join(realHome, 'data', taskIdA, 'report.md'), '# Scout Report\n\nCompleted.\n');
    execFileSync('bash', [HOLD_SH, 'complete', taskIdA, '--none'], { env: realEnv });

    const teardownOutA = execFileSync(
      'bash',
      [TEARDOWN_SH, taskIdA],
      { cwd: tempDir, encoding: 'utf8', env: realEnv }
    );
    assert.match(teardownOutA, new RegExp(`teardown ${taskIdA} complete`));

    // 5c: Verify Telemetry Store
    const realLog = path.join(realHome, 'data', 'routing-executions.jsonl');
    const realRecords = fs.readFileSync(realLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));

    const pathBRecs = realRecords.filter(r => r.task_id === taskIdB);
    assert.equal(pathBRecs.length, 5, 'Path B must have selected, launched, dispatched, run, completed');
    const [startB, launchB, dispB, runB, compB] = pathBRecs;
    assert.equal(startB.dispatch_path, 'B');
    assert.equal(startB.candidate_route_set_marker, 'legacy/manual decision, no candidate set evaluated');
    assert.equal(startB.candidate_routes, null);
    assert.equal(startB.route_decision.decision_type, 'legacy_manual');
    assert.equal(startB.data_class, null);
    assert.equal(startB.classification_status, 'UNCLASSIFIED_LEGACY');
    assert.equal(launchB.lifecycle_state, 'LAUNCHING');
    assert.equal(startB.route_execution_id, dispB.route_execution_id);
    assert.equal(startB.route_execution_id, runB.route_execution_id);
    assert.equal(startB.route_execution_id, compB.route_execution_id);
    assert.equal(dispB.dispatch_status, 'dispatched');
    assert.equal(runB.dispatch_status, 'running');
    assert.equal(compB.dispatch_status, 'completed');

    const overrideStart = realRecords.find(r => r.task_id === taskIdO && r.dispatch_status === 'started');
    assert.equal(overrideStart.dispatch_path, 'B');
    assert.equal(overrideStart.route_decision.decision_type, 'manual_override');
    assert.equal(overrideStart.route_decision.override_reason, 'captain chose this worker explicitly');
    assert.equal(overrideStart.route_decision.router_authority, 'enforced');
    assert.equal(overrideStart.data_class, 'PUBLIC');
    assert.equal(realRecords.find(r => r.task_id === taskIdB && r.dispatch_status === 'started').route_decision.router_authority, 'advisory');

    const pathARecs = realRecords.filter(r => r.task_id === taskIdA);
    assert.equal(pathARecs.length, 5, 'Path A must have selected, launched, dispatched, run, completed');
    const [startA, launchA, dispA, runA, compA] = pathARecs;
    assert.equal(startA.dispatch_path, 'A');
    assert.equal(startA.candidate_route_set_marker, null);
    assert.ok(startA.candidate_routes.length > 0);
    assert.equal(startA.route_decision.decision_type, 'router_v2');
    assert.equal(startA.classification_status, 'CLASSIFIED');
    assert.equal(launchA.lifecycle_state, 'LAUNCHING');
    assert.equal(startA.route_execution_id, dispA.route_execution_id);
    assert.equal(startA.route_execution_id, runA.route_execution_id);
    assert.equal(startA.route_execution_id, compA.route_execution_id);
    assert.equal(dispA.dispatch_status, 'dispatched');
    assert.equal(runA.dispatch_status, 'running');
    assert.equal(compA.dispatch_status, 'completed');
  } finally {
    process.env.PATH = prevPath;
    if (prevFmHome !== undefined) process.env.FM_HOME = prevFmHome;
    else delete process.env.FM_HOME;
    if (prevNoGuard !== undefined) process.env.FM_SPAWN_NO_GUARD = prevNoGuard;
    else delete process.env.FM_SPAWN_NO_GUARD;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

console.log('--- All Router V3 WP1A Ingress Tests Passed Successfully ---');
