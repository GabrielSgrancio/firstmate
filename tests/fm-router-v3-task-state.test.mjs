import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRouterFixtureHome } from './router-v2-fixture.mjs';

const home = makeRouterFixtureHome();

const taskStateModule = await import('../bin/fm-task-state.mjs');
const {
  TASK_STATE_SCHEMA_VERSION,
  FAILURE_CLASSIFICATIONS,
  ACTIVE_DATA_CLASSES,
  SECRET_PATTERNS,
  scrubSecrets,
  createTaskStateCapsule,
  validateTaskStateCapsule,
  getTaskCapsulePath,
  atomicWriteJson,
  saveTaskStateCapsule,
  loadTaskStateCapsule,
  updateTaskStateCapsule,
  resolveEscalationParameters,
  selectContinuationRoute,
  formatContinuationPrompt,
  measureContextMetrics,
  recordRouteFailureAndHandoff,
  recordContinuationDispatch,
  recordContinuationCompletion
} = taskStateModule;

const router = await import('../bin/fm-router-v2.mjs');

console.log('--- Router V3 WP8 Task State Capsule & Continuation Engine Tests ---');

// ============================================================================
// 1. Schema Definition & Validation
// ============================================================================
console.log('Test 1: Conceptual Schema and 25-field verification');
assert.equal(TASK_STATE_SCHEMA_VERSION, 1);
assert.deepEqual(Object.keys(FAILURE_CLASSIFICATIONS), [
  'CONTEXT_FAILURE',
  'TOOL_FOLLOW_THROUGH_FAILURE',
  'REASONING_FAILURE',
  'ARCHITECTURAL_UNCERTAINTY',
  'HARD_RUNTIME_FAILURE',
  'POLICY_FAILURE',
  'QUOTA_FAILURE'
]);

const initialCapsule = createTaskStateCapsule({
  logical_task_id: 'task-test-001',
  route_execution_id: 'rex-init-1',
  objective: 'Fix race condition in LRU cache eviction',
  constraints: ['mode=local-only', 'no remote push'],
  task_class: 'targeted_edit',
  data_class: 'PRIVATE_CODE',
  repo_state: {
    commit_sha: 'abc1234',
    branch: 'fm/cache-fix',
    clean: false,
    base_sha: 'main-base'
  },
  discovered_files: ['src/cache.js', 'src/mutex.js', 'tests/cache.test.js'],
  relevant_interfaces: [
    { name: 'Cache.evict', path: 'src/cache.js', summary: 'Evicts oldest item when size exceeds limit' }
  ],
  evidence_refs: [{ ref_type: 'log', uri: 'data/logs/run-1.log', description: 'Initial failure log' }],
  decisions_made: [{ decision: 'Keep lock-free reads', rationale: 'Read performance must not degrade' }],
  commands_executed: [{ command: 'npm test tests/cache.test.js', exit_code: 1, stdout_snippet: 'AssertionError' }],
  test_results: [{ test_suite: 'cache.test.js', test_name: 'test_concurrent_eviction', status: 'failed', error_message: 'size 105 != 100' }],
  current_diff: '+ // added mutex acquire\n+ this.lock.acquire();',
  files_modified: ['src/cache.js'],
  failed_hypotheses: [{ hypothesis: 'Simple volatile flag prevents race', reason_refuted: 'Node event loop interleaving still races' }],
  failure_classification: null,
  unresolved_questions: ['Should we use double-checked locking?'],
  next_recommended_action: 'Inspect Mutex queue implementation',
  current_route: {
    route_id: 'codex:gpt-5.6-luna:low',
    harness: 'codex',
    model: 'gpt-5.6-luna',
    effort: 'low',
    quota_pool: 'codex_plus'
  },
  previous_routes: [],
  attempt_count: 1,
  context_pack_refs: ['cp-001-cache-spec']
});

// Verify all 25 fields are present in the created capsule
const expectedFields = [
  'schema_version',
  'logical_task_id',
  'route_execution_id',
  'objective',
  'constraints',
  'task_class',
  'data_class',
  'repo_state',
  'discovered_files',
  'relevant_interfaces',
  'evidence_refs',
  'decisions_made',
  'commands_executed',
  'test_results',
  'current_diff',
  'files_modified',
  'failed_hypotheses',
  'failure_classification',
  'unresolved_questions',
  'next_recommended_action',
  'current_route',
  'previous_routes',
  'attempt_count',
  'context_pack_refs',
  'timestamps'
];

for (const field of expectedFields) {
  assert.ok(field in initialCapsule, `Field "${field}" must exist on TaskStateCapsule`);
}
assert.equal(validateTaskStateCapsule(initialCapsule).valid, true);

// Validation errors on malformed capsule
assert.throws(() => {
  createTaskStateCapsule({ logical_task_id: '', objective: 'obj', data_class: 'PUBLIC' });
}, /logical_task_id is required/);
assert.throws(() => {
  createTaskStateCapsule({ logical_task_id: 't1', objective: '', data_class: 'PUBLIC' });
}, /objective is required/);
assert.throws(() => {
  createTaskStateCapsule({ logical_task_id: 't1', objective: 'obj', data_class: 'INVALID_DATA_CLASS' });
}, /data_class must be one of/);

console.log('✓ Test 1 passed: conceptual schema and validation verified');

// ============================================================================
// 2. Secret Scrubbing & Defense-in-Depth
// ============================================================================
console.log('Test 2: Secret Scrubbing and Policy Defense-in-Depth');

const dirtyContent = {
  diff: 'Index: file.js\n+ const key = "sk-ant-api03-abcdef1234567890abcdef1234567890";\n+ const token = "ghp_1234567890abcdef1234567890abcdef1234";',
  commands: [
    { command: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef" https://api.example.com?api_key=AIzaSyA1234567890abcdef1234567890abcde', exit_code: 0 }
  ],
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Y...\n-----END RSA PRIVATE KEY-----',
  nested: {
    password_assignment: 'password = "supersecretpassword123"'
  }
};

const scrubbed = scrubSecrets(dirtyContent);
assert.ok(!scrubbed.diff.includes('sk-ant-'), 'Anthropic key must be scrubbed');
assert.ok(!scrubbed.diff.includes('ghp_'), 'GitHub token must be scrubbed');
assert.ok(scrubbed.diff.includes('[REDACTED_SECRET]'), 'Scrubbed text must carry redact marker');
assert.ok(!scrubbed.commands[0].command.includes('Bearer ey'), 'Bearer token must be scrubbed');
assert.ok(!scrubbed.commands[0].command.includes('AIzaSy'), 'Google API key must be scrubbed');
assert.ok(!scrubbed.private_key.includes('MIIEow'), 'Private key block must be scrubbed');
assert.ok(!scrubbed.nested.password_assignment.includes('supersecretpassword123'), 'Password assignment must be scrubbed');

// Structured credentials are redacted by key, whatever the value's shape.
const structured = scrubSecrets({
  api_key: 'SYNTHETIC_CREDENTIAL_123456',
  password: 'SYNTHETIC_PASSWORD_123456',
  nested: { clientSecret: 'SYNTHETIC_CLIENT_SECRET', 'X-Access-Token': 'short', refresh_token: { value: 'SYNTHETIC_REFRESH' } },
  headers: [{ authorization: 'SYNTHETIC_AUTH_HEADER' }],
  token_savings: 42,
  max_tokens: 1000
});
assert.equal(JSON.stringify(structured).includes('SYNTHETIC'), false, 'credential-shaped keys must be redacted');
assert.equal(structured.nested['X-Access-Token'], '[REDACTED_SECRET]');
assert.equal(structured.token_savings, 42, 'non-credential keys that mention tokens are left alone');
assert.equal(structured.max_tokens, 1000);
const credentialCapsule = createTaskStateCapsule({
  logical_task_id: 'task-structured-credential',
  objective: 'Rotate a fixture integration',
  data_class: 'PRIVATE_CODE',
  evidence_refs: [{ source: 'config', api_key: 'SYNTHETIC_CREDENTIAL_123456' }]
});
saveTaskStateCapsule('task-structured-credential', credentialCapsule, { fmHome: home });
const credentialPath = getTaskCapsulePath('task-structured-credential', { fmHome: home });
assert.equal(fs.readFileSync(credentialPath, 'utf8').includes('SYNTHETIC_CREDENTIAL'), false);

// A SECRET capsule is refused outright; nothing reaches disk.
const secretTaskCapsule = createTaskStateCapsule({
  logical_task_id: 'task-secret-002',
  objective: 'CLASSIFIED_OBJECTIVE_MUST_NOT_PERSIST',
  data_class: 'SECRET',
  evidence_refs: [{ text: 'CLASSIFIED_EVIDENCE_MUST_NOT_PERSIST' }],
  current_diff: '+ some secret algorithm code',
  commands_executed: [{ command: 'echo CLASSIFIED_COMMAND_MUST_NOT_PERSIST', exit_code: 0, stdout_snippet: 'classified stdout' }]
});
assert.throws(() => saveTaskStateCapsule('task-secret-002', secretTaskCapsule, { fmHome: home }), /SECRET .*never persisted/);
assert.equal(fs.existsSync(getTaskCapsulePath('task-secret-002', { fmHome: home })), false, 'a SECRET capsule never reaches disk');

console.log('✓ Test 2 passed: secret scrubbing and defense-in-depth verified');

// ============================================================================
// 3. Escalation Rules: Failure Type -> Route Class Mapping
// ============================================================================
console.log('Test 3: Escalation by Failure Type (All 7 Classifications)');

const baseCapsule = createTaskStateCapsule({
  logical_task_id: 'task-escalation-test',
  objective: 'General engineering task',
  task_class: 'targeted_edit',
  data_class: 'PUBLIC',
  current_route: {
    route_id: 'codex:gpt-5.6-luna:low',
    harness: 'codex',
    model: 'gpt-5.6-luna',
    effort: 'low',
    quota_pool: 'codex_plus'
  }
});

// (a) CONTEXT_FAILURE -> context specialist / improved ContextPack
const escContext = resolveEscalationParameters(baseCapsule, FAILURE_CLASSIFICATIONS.CONTEXT_FAILURE, {
  contextPack: { pack_id: 'cp-wp7-extra-context', path: 'data/cp.json' }
});
assert.equal(escContext.role, 'deep_context');
assert.equal(escContext.taskClass, 'large_context_repository_retrieval');
assert.equal(escContext.targetEffort, 'high');
assert.ok(escContext.attachedContextPackRefs.includes('cp-wp7-extra-context'));
assert.ok(escContext.excludeRoutes.includes('codex:gpt-5.6-luna:low'));

// (b) TOOL_FOLLOW_THROUGH_FAILURE -> stronger autonomous worker
const escTool = resolveEscalationParameters(baseCapsule, FAILURE_CLASSIFICATIONS.TOOL_FOLLOW_THROUGH_FAILURE);
assert.equal(escTool.role, 'autonomous_engineer');
assert.equal(escTool.taskClass, 'multi_file_feature');
assert.ok(escTool.excludeRoutes.includes('codex:gpt-5.6-luna:low'));

// (c) REASONING_FAILURE -> deep reasoner
const escReasoning = resolveEscalationParameters(baseCapsule, FAILURE_CLASSIFICATIONS.REASONING_FAILURE);
assert.equal(escReasoning.role, 'deep_engineer');
assert.equal(escReasoning.taskClass, 'brownfield_debugging');
assert.equal(escReasoning.targetEffort, 'high');
assert.ok(escReasoning.excludeRoutes.includes('codex:gpt-5.6-luna:low'));

// (d) ARCHITECTURAL_UNCERTAINTY -> high-judgment model
const escArch = resolveEscalationParameters(baseCapsule, FAILURE_CLASSIFICATIONS.ARCHITECTURAL_UNCERTAINTY);
assert.equal(escArch.role, 'architect_synthesizer');
assert.equal(escArch.taskClass, 'architecture_reasoning');
assert.equal(escArch.targetEffort, 'high');
assert.ok(escArch.excludeRoutes.includes('codex:gpt-5.6-luna:low'));

// (e) HARD_RUNTIME_FAILURE -> retry/fix infrastructure, not premium reasoning
const escRuntime = resolveEscalationParameters(baseCapsule, FAILURE_CLASSIFICATIONS.HARD_RUNTIME_FAILURE);
assert.equal(escRuntime.role, 'fast_precise', 'Must NOT escalate to bigger model on infrastructure failure');
assert.equal(escRuntime.taskClass, 'targeted_edit');
assert.equal(escRuntime.retryTolerant, true);
assert.ok(escRuntime.excludeRoutes.includes('codex:gpt-5.6-luna:low'));

// (f) POLICY_FAILURE -> choose eligible route, not bigger route
const escPolicy = resolveEscalationParameters(baseCapsule, FAILURE_CLASSIFICATIONS.POLICY_FAILURE);
assert.equal(escPolicy.role, 'fast_precise', 'Must NOT upgrade model size on policy violation');
assert.equal(escPolicy.taskClass, 'targeted_edit');
assert.ok(escPolicy.excludeRoutes.includes('codex:gpt-5.6-luna:low'));

// (g) QUOTA_FAILURE -> equivalent capable pool
const escQuota = resolveEscalationParameters(baseCapsule, FAILURE_CLASSIFICATIONS.QUOTA_FAILURE, {
  exhaustedPool: 'codex_plus'
});
assert.equal(escQuota.role, 'fast_precise', 'Must maintain role tier on quota failure');
assert.equal(escQuota.taskClass, 'targeted_edit');
assert.ok(escQuota.quotaOverrides?.codex_plus?.status === 'EXHAUSTED', 'Exhausted pool must be overridden');

console.log('✓ Test 3 passed: all 7 failure escalations correctly mapped without naive bigger-model fallback');

// ============================================================================
// 4. Real Scheduler Wiring (WP5/WP6 Integration)
// ============================================================================
console.log('Test 4: Real Scheduler Wiring with scoreAndSelectRoute');

// Test continuation route selection for REASONING_FAILURE
const continuationReasoning = selectContinuationRoute(baseCapsule, {
  failureClassification: FAILURE_CLASSIFICATIONS.REASONING_FAILURE,
  useLiveAxi: false
});
assert.ok(continuationReasoning.selectedRoute, 'Scheduler must return selectedRoute');
assert.equal(continuationReasoning.decision.role, 'deep_engineer');
assert.equal(continuationReasoning.decision.taskClass, 'brownfield_debugging');
assert.ok(continuationReasoning.decision.qualityFloor >= 0.90, 'Brownfield debugging quality floor enforced');
assert.notEqual(continuationReasoning.selectedRoute.route_id, 'codex:gpt-5.6-luna:low', 'Failed route was excluded');

// Test continuation route selection for QUOTA_FAILURE
const toolWorkerCapsule = createTaskStateCapsule({
  logical_task_id: 'task-tool-worker-quota',
  objective: 'Run automated lint and formatting migration',
  task_class: 'mechanical_tool_work',
  data_class: 'PUBLIC',
  current_route: {
    route_id: 'codex:gpt-5.6-luna:low',
    harness: 'codex',
    model: 'gpt-5.6-luna',
    effort: 'low',
    quota_pool: 'codex_plus'
  }
});

const continuationQuota = selectContinuationRoute(toolWorkerCapsule, {
  failureClassification: FAILURE_CLASSIFICATIONS.QUOTA_FAILURE,
  exhaustedPool: 'codex_plus',
  useLiveAxi: false
});
assert.ok(continuationQuota.selectedRoute, 'Scheduler must pick alternative pool route');
assert.equal(continuationQuota.decision.role, 'cheap_tool_worker');
assert.notEqual(continuationQuota.selectedRoute.quota_pool, 'codex_plus', 'Must not select exhausted pool');
assert.equal(continuationQuota.selectedRoute.quota_pool, 'opencode_go', 'Fails over to equivalent capable opencode_go pool');

console.log('✓ Test 4 passed: real WP5/WP6 scheduler selected continuation routes');

// ============================================================================
// 5. State Compression and Token Context Measurement
// ============================================================================
console.log('Test 5: State Compression and Token Measurement');

// Generate simulated raw multi-turn conversation transcript (~25,000 characters)
const rawTurns = [];
for (let i = 1; i <= 20; i++) {
  rawTurns.push(`Turn ${i}: User asks for status update and explores directory tree.`);
  rawTurns.push(`Assistant runs 'find . -name "*.js"' and receives 450 file paths:`);
  for (let j = 0; j < 25; j++) {
    rawTurns.push(`  ./node_modules/dep-${j}/sub/file-${j}.js`);
  }
  rawTurns.push(`Assistant runs 'git status', 'git diff', reads multiple irrelevant files, inspects package.json, and deliberates.`);
}
const rawTranscript = rawTurns.join('\n');

const compressedPrompt = formatContinuationPrompt(initialCapsule);
const metrics = measureContextMetrics(initialCapsule, rawTranscript);

console.log(`  Raw context chars: ${metrics.raw_chars} (~${metrics.raw_tokens} tokens)`);
console.log(`  Compressed continuation prompt chars: ${metrics.compressed_chars} (~${metrics.compressed_tokens} tokens)`);
console.log(`  Token savings: ${metrics.token_savings} tokens (${metrics.reduction_percent}% reduction, ratio ${metrics.compression_ratio}x)`);

assert.ok(metrics.raw_tokens > metrics.compressed_tokens * 3, 'Compressed state must be significantly smaller than raw transcript');
assert.ok(metrics.reduction_percent > 70, 'Token reduction should be at least 70%');
assert.ok(compressedPrompt.includes('Fix race condition in LRU cache eviction'), 'Objective must be preserved in prompt');
assert.ok(compressedPrompt.includes('src/cache.js'), 'Discovered files must be present');
assert.ok(compressedPrompt.includes('test_concurrent_eviction'), 'Test results must be present');
assert.ok(compressedPrompt.includes('added mutex acquire'), 'Diff must be present');
assert.ok(compressedPrompt.includes('Keep lock-free reads'), 'Settled decisions must be present');

console.log('✓ Test 5 passed: measured state compression and token savings');

// ============================================================================
// 6. Durability & Process Restart Survival
// ============================================================================
console.log('Test 6: Durability and Process Restart Survival');

const taskId = 'task-durability-proof';
const originalCapsule = createTaskStateCapsule({
  logical_task_id: taskId,
  objective: 'Survive supervisor crash and resume seamlessly',
  task_class: 'refactor',
  data_class: 'PRIVATE_CODE',
  current_diff: '+ const durable = true;',
  discovered_files: ['lib/durability.js'],
  files_modified: ['lib/durability.js']
});

saveTaskStateCapsule(taskId, originalCapsule, { fmHome: home });
const capsulePath = getTaskCapsulePath(taskId, { fmHome: home });
assert.ok(fs.existsSync(capsulePath), 'Capsule file must exist on disk');

// Verify atomic write mode permissions
const stat = fs.statSync(capsulePath);
// Mode check: 0o600 (user read/write only)
assert.equal(stat.mode & 0o777, 0o600, 'Capsule file must have 0o600 permissions');

// Re-read from disk (simulating cold process restart)
const reloadedCapsule = loadTaskStateCapsule(taskId, { fmHome: home });
assert.equal(reloadedCapsule.logical_task_id, taskId);
assert.equal(reloadedCapsule.objective, 'Survive supervisor crash and resume seamlessly');
assert.equal(reloadedCapsule.current_diff, '+ const durable = true;');
assert.deepEqual(reloadedCapsule.discovered_files, ['lib/durability.js']);

console.log('✓ Test 6 passed: atomic persistence, 0o600 permissions, and restart recovery verified');

// ============================================================================
// 7. Full WP8 Acceptance Handoff (Route A -> Failure -> Route B Continuation)
// ============================================================================
console.log('Test 7: Full Two-Route Handoff Lifecycle (Route A -> Route B)');

const demoTaskId = 'task-wp8-acceptance-handoff';

// (1) Route A starts working on the task
const routeA = {
  route_id: 'codex:gpt-5.6-luna:low',
  harness: 'codex',
  model: 'gpt-5.6-luna',
  effort: 'low',
  quota_pool: 'codex_plus'
};

const routeA_capsule = createTaskStateCapsule({
  logical_task_id: demoTaskId,
  route_execution_id: 'rex-route-A-001',
  objective: 'Fix high-concurrency race in database transaction coordinator',
  task_class: 'mechanical_tool_work',
  data_class: 'PRIVATE_CODE',
  repo_state: {
    commit_sha: '1111aaa',
    branch: 'fm/txn-fix',
    clean: false,
    base_sha: 'main'
  },
  discovered_files: ['src/coordinator.js', 'src/wal.js', 'tests/txn.test.js'],
  relevant_interfaces: [
    { name: 'Coordinator.commit', path: 'src/coordinator.js', summary: 'Two-phase commit coordinator' }
  ],
  evidence_refs: [{ ref_type: 'log', uri: 'data/logs/routeA.log', description: 'Route A stdout' }],
  current_route: routeA,
  attempt_count: 1
});
saveTaskStateCapsule(demoTaskId, routeA_capsule, { fmHome: home });

// (2) Route A works, edits files, executes tests, and hits REASONING_FAILURE
const routeA_diff = '+ // optimistic commit attempt\n+ if (this.pendingTxns.length > 0) this.flush();';
const routeA_commands = [{ command: 'npm test tests/txn.test.js', exit_code: 1, stdout_snippet: 'SplitBrainError' }];
const routeA_tests = [{ test_suite: 'txn.test.js', test_name: 'test_concurrent_split_brain', status: 'failed', error_message: 'SplitBrainError: multiple coordinators elected' }];
const routeA_hypotheses = [{ hypothesis: 'Optimistic flush avoids split brain', reason_refuted: 'Network partition triggers dual leaders' }];

recordRouteFailureAndHandoff(demoTaskId, {
  failureClassification: FAILURE_CLASSIFICATIONS.REASONING_FAILURE,
  failureReason: 'Optimistic approach failed; distributed consensus reasoning required',
  currentDiff: routeA_diff,
  filesModified: ['src/coordinator.js'],
  commandsExecuted: routeA_commands,
  testResults: routeA_tests,
  failedHypotheses: routeA_hypotheses,
  unresolvedQuestions: ['Does Raft term validation prevent partition divergence?'],
  nextRecommendedAction: 'Implement strict leader election term validation before commit approval'
}, { fmHome: home });

const postRouteACapsule = loadTaskStateCapsule(demoTaskId, { fmHome: home });
assert.equal(postRouteACapsule.attempt_count, 2);
assert.equal(postRouteACapsule.previous_routes.length, 1);
assert.equal(postRouteACapsule.previous_routes[0].route_id, 'codex:gpt-5.6-luna:low');
assert.equal(postRouteACapsule.previous_routes[0].failure_classification, 'REASONING_FAILURE');

// (3) Route B is selected using WP5/WP6 scheduler based on REASONING_FAILURE
const routeBSelection = selectContinuationRoute(postRouteACapsule, { useLiveAxi: false });
const routeB = routeBSelection.selectedRoute;
assert.ok(routeB, 'Route B must be selected');
assert.equal(routeBSelection.decision.role, 'deep_engineer', 'REASONING_FAILURE promoted to deep_engineer');
assert.ok(routeBSelection.decision.qualityFloor >= 0.90, 'Quality floor for deep_engineer applied');
assert.notEqual(routeB.route_id, routeA.route_id, 'Route B must not be failed Route A');

// (4) Dispatch Route B and verify continuation state
const routeBExecId = 'rex-route-B-002';
recordContinuationDispatch(demoTaskId, {
  nextRoute: routeB,
  nextRouteExecutionId: routeBExecId
}, { fmHome: home });

const routeBCapsule = loadTaskStateCapsule(demoTaskId, { fmHome: home });
assert.equal(routeBCapsule.route_execution_id, routeBExecId);
assert.equal(routeBCapsule.current_route.route_id, routeB.route_id);

// Verify (4) Route B does not repeat repository discovery:
assert.deepEqual(routeBCapsule.discovered_files, ['src/coordinator.js', 'src/wal.js', 'tests/txn.test.js']);
assert.equal(routeBCapsule.relevant_interfaces.length, 1);

// Verify (5) Previous commands, tests, and diff are preserved:
assert.equal(routeBCapsule.current_diff, routeA_diff);
assert.deepEqual(routeBCapsule.files_modified, ['src/coordinator.js']);
assert.equal(routeBCapsule.commands_executed.length, 1);
assert.equal(routeBCapsule.test_results.length, 1);
assert.equal(routeBCapsule.failed_hypotheses.length, 1);

// Verify (6) Data classification remains preserved:
assert.equal(routeBCapsule.data_class, 'PRIVATE_CODE');

// Verify (7) Evidence provenance remains available:
assert.equal(routeBCapsule.evidence_refs.length, 1);
assert.equal(routeBCapsule.previous_routes[0].route_execution_id, 'rex-route-A-001');

// (8) Route B completes the task
const finalDiff = routeA_diff + '\n+ if (this.currentTerm <= incomingTerm) this.stepDown();';
updateTaskStateCapsule(demoTaskId, (cap) => {
  cap.current_diff = finalDiff;
  cap.test_results.push({ test_suite: 'txn.test.js', test_name: 'test_concurrent_split_brain', status: 'passed', error_message: 'passed' });
  cap.commands_executed.push({ command: 'npm test tests/txn.test.js', exit_code: 0, stdout_snippet: 'All 12 tests passed' });
}, { fmHome: home });

const completedCapsule = recordContinuationCompletion(demoTaskId, {
  terminalState: 'SUCCESS',
  resultSummary: 'Strict term validation fixed split brain issue across partition',
  exitCode: 0,
  tokensConsumed: 1200
}, { fmHome: home });

assert.ok(completedCapsule.timestamps.completed_at !== null, 'completed_at timestamp must be recorded');
assert.equal(completedCapsule.current_diff, finalDiff);
assert.equal(completedCapsule.test_results.length, 2);
assert.equal(completedCapsule.commands_executed.length, 2);
assert.equal(completedCapsule.previous_routes.length, 1);

console.log('✓ Test 7 passed: full Route A -> failure -> Route B continuation lifecycle verified');

console.log('\nAll Router V3 WP8 Task State tests passed successfully!');
