import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createContextBroker,
  readTargetedSlice,
  renderContextPack
} from '../bin/fm-context-broker.mjs';
import { makeRouterFixtureHome } from './router-v2-fixture.mjs';

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-context-repo-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-context-home-'));
git(repo, 'init', '-q');
git(repo, 'config', 'user.name', 'context-test');
git(repo, 'config', 'user.email', 'context-test@example.invalid');
const source = Array.from({ length: 5000 }, (_, index) =>
  index === 2718
    ? 'export function needleHandler(input) { return input.trim(); }'
    : `const generatedValue${index} = ${index};`
).join('\n');
write(path.join(repo, 'src', 'large.js'), source);
write(path.join(repo, 'src', 'small.js'), 'export function target() {\n  return 42;\n}\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'context broker fixture');

let routeSelections = 0;
let workerCalls = 0;
const dynamicRoute = {
  route_id: 'mimo:context-fast',
  resolved_runtime_model: 'mimo/context-fast',
  quota_pool: 'mimo_pool',
  data_profile: 'claude_consumer',
  harness: 'muse',
  reasoning_effort: 'low'
};
const routeSelector = (request) => {
  routeSelections += 1;
  assert.equal(request.role, 'fast_context');
  assert.equal(request.taskClass, 'large_context_repository_retrieval');
  return { selectedRoute: dynamicRoute };
};
const allowGate = (dataClass, profile, context) => {
  assert.equal(profile, dynamicRoute.data_profile);
  assert.ok(context.resolvedRuntimeModel);
  return { allowed: dataClass !== 'SECRET', reason: 'test policy' };
};
const broker = createContextBroker({
  homeDir: home,
  routeSelector,
  dataGate: allowGate,
  shuntWorker: (request, context) => {
    workerCalls += 1;
    assert.equal(context.route.route_id, dynamicRoute.route_id);
    assert.ok(['oversized_file_read', 'large_multi_file_read', 'large_symbol_reference_search'].includes(request.operation));
    assert.equal(request.files[0].source_hash.length, 64);
    return {
      summary: 'The requested handler is the only matching symbol.',
      relevant_files: ['src/large.js'],
      relevant_symbols: [{ path: 'src/large.js', name: 'needleHandler', line: 2719, why: 'worker confirmation' }]
    };
  }
});

const direct = broker.requestContext({
  repoDir: repo,
  operation: 'read',
  filePath: 'src/small.js',
  lineRange: { start: 1, end: 3 },
  query: 'target function',
  dataClass: 'PRIVATE_CODE'
});
assert.equal(direct.operation, 'read');
assert.equal(direct.provenance.operation_classification.intercepted, false);
assert.equal(direct.telemetry.context_worker_route, null);
assert.match(direct.findings.find((finding) => finding.kind === 'direct_source').text, /target/);

const huge = broker.requestContext({
  repoDir: repo,
  operation: 'read',
  filePath: 'src/large.js',
  query: 'needleHandler',
  dataClass: 'PRIVATE_CODE'
});
assert.equal(huge.provenance.operation_classification.intercepted, true);
assert.equal(huge.telemetry.context_worker_route, dynamicRoute.route_id);
assert.equal(huge.telemetry.context_worker_pool, dynamicRoute.quota_pool);
assert.equal(workerCalls, 1);
assert.ok(huge.telemetry.premium_context_avoided > 0);
assert.ok(huge.telemetry.reasoner_context_tokens_delivered < huge.telemetry.raw_candidate_context_tokens);
assert.ok(huge.telemetry.total_model_tokens_spent > huge.telemetry.shunt_worker_input_tokens);
assert.match(renderContextPack(huge), /needleHandler/);

const multi = broker.requestContext({
  repoDir: repo,
  operation: 'multi_read',
  paths: ['src/large.js', 'src/small.js'],
  query: 'needleHandler',
  dataClass: 'PRIVATE_CODE'
});
assert.equal(multi.operation, 'large_multi_file_read');
assert.equal(multi.telemetry.context_worker_route, dynamicRoute.route_id);
assert.equal(workerCalls, 2);

const references = broker.requestContext({
  repoDir: repo,
  operation: 'references',
  query: 'needleHandler',
  dataClass: 'PRIVATE_CODE'
});
assert.equal(references.operation, 'large_symbol_reference_search');
assert.equal(references.telemetry.context_worker_route, dynamicRoute.route_id);
assert.ok(references.commands_used.some((command) => command.startsWith('rg ')));
assert.equal(workerCalls, 3);

const cached = broker.requestContext({
  repoDir: repo,
  operation: 'read',
  filePath: 'src/large.js',
  query: 'needleHandler',
  dataClass: 'PRIVATE_CODE'
});
assert.equal(cached.telemetry.context_cache_hit, true);
assert.equal(cached.telemetry.context_cache_miss, false);
assert.equal(cached.telemetry.shunt_worker_input_tokens, 0);
assert.equal(cached.telemetry.shunt_worker_output_tokens, 0);
assert.equal(cached.telemetry.total_model_tokens_spent, cached.telemetry.reasoner_context_tokens_delivered);
assert.equal(workerCalls, 3, 'a repeated repository question must reuse the context pack');

const giantOutput = Array.from({ length: 6000 }, (_, index) =>
  index % 997 === 0 ? `ERROR worker ${index}: failed assertion` : 'debug: repetitive output'
).join('\n');
const condensed = broker.requestContext({
  repoDir: repo,
  operation: 'grep',
  output: giantOutput,
  query: 'worker failure',
  dataClass: 'PUBLIC'
});
assert.equal(condensed.operation, 'giant_grep_output');
assert.equal(condensed.telemetry.context_worker_route, null);
assert.ok(condensed.telemetry.deterministic_context_tokens < condensed.telemetry.raw_candidate_context_tokens);
assert.match(condensed.findings.find((finding) => finding.kind === 'deterministic_output_condensation').summary, /6000 output lines/);

const deterministic = broker.requestContext({
  repoDir: repo,
  operation: 'scan',
  query: 'large.js',
  dataClass: 'PUBLIC'
});
assert.equal(deterministic.operation, 'broad_repository_scan');
assert.equal(deterministic.telemetry.context_worker_route, null);
assert.deepEqual(deterministic.relevant_files, ['src/large.js']);

const fixtureHome = makeRouterFixtureHome();
const router = await import('../bin/fm-router-v2.mjs');
const routedBroker = createContextBroker({
  homeDir: fixtureHome,
  routeSelector: (params) => router.scoreAndSelectRoute({ ...params, useLiveAxi: false }),
  dataGate: router.evaluateDataGate,
  shuntWorker: () => ({ summary: 'Router-selected context worker condensed the source.' })
});
const routed = routedBroker.requestContext({
  repoDir: fixtureHome,
  operation: 'read',
  content: source,
  path: 'src/routed.js',
  query: 'needleHandler',
  dataClass: 'PUBLIC',
  useLiveAxi: false
});
assert.equal(routed.telemetry.context_worker_route, 'agy:gemini-3.8-flash-low');
assert.equal(routed.telemetry.context_worker_pool, 'antigravity_gemini');

const sensitive = createContextBroker({
  homeDir: home,
  routeSelector: () => ({ selectedRoute: {
    route_id: 'opencode:muse-spark',
    resolved_runtime_model: 'opencode-go/muse-spark-1.3-contributor',
    quota_pool: 'opencode_go',
    data_profile: 'opencode_go'
  } }),
  dataGate: () => ({ allowed: false, reason: 'training_use=used' }),
  shuntWorker: () => { throw new Error('must not run after a policy refusal'); }
});
const refused = sensitive.requestContext({
  repoDir: repo,
  operation: 'read',
  content: source,
  path: 'src/private.js',
  query: 'needleHandler',
  dataClass: 'PERSONAL_SENSITIVE'
});
assert.equal(refused.telemetry.context_worker_route, null);
assert.equal(refused.worker_refusal, 'training_use=used');
assert.equal(workerCalls, 3, 'the refused context worker must not execute');

const actualPolicyBroker = createContextBroker({
  homeDir: fixtureHome,
  routeSelector: () => ({ selectedRoute: {
    route_id: 'opencode:muse-spark',
    resolved_runtime_model: 'opencode-go/muse-spark-1.3-contributor',
    quota_pool: 'opencode_go',
    data_profile: 'opencode_go'
  } }),
  dataGate: router.evaluateDataGate,
  shuntWorker: () => { throw new Error('actual policy refusal must happen before worker input'); }
});
const actualRefused = actualPolicyBroker.requestContext({
  repoDir: repo,
  operation: 'read',
  content: source,
  path: 'src/personal.js',
  query: 'needleHandler',
  dataClass: 'PERSONAL_SENSITIVE'
});
assert.match(actualRefused.worker_refusal, /training on prompts\/completions/);
assert.equal(actualRefused.telemetry.context_worker_route, null);

for (const [operation, output] of [
  ['test', `${giantOutput}\nPASS: suite complete`],
  ['build', `${giantOutput}\nBuild succeeded`],
  ['log', `${giantOutput}\ninfo: retry completed`]
]) {
  const outputPack = broker.requestContext({
    repoDir: repo,
    operation,
    output,
    query: 'worker failure',
    dataClass: 'PUBLIC'
  });
  assert.equal(outputPack.telemetry.context_worker_route, null);
  assert.ok(outputPack.telemetry.deterministic_context_tokens < outputPack.telemetry.raw_candidate_context_tokens);
}

// SECRET and any class outside the five-class taxonomy refuse the whole
// operation: no query echo, source read, cache entry, slice, or artifact write.
write(path.join(repo, 'classified.txt'), 'CLASSIFIED_SOURCE_MUST_NOT_DELIVER\n');
const cacheDir = path.join(home, 'state', 'context-cache');
const cacheEntries = () => (fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).length : 0);
const cacheBefore = cacheEntries();
assert.throws(() => sensitive.requestContext({
  repoDir: repo,
  operation: 'file_read',
  filePath: 'classified.txt',
  query: 'CLASSIFIED_QUERY_MUST_NOT_DELIVER',
  dataClass: 'SECRET'
}), /refuses SECRET data/);
assert.throws(() => broker.requestContext({
  repoDir: repo,
  operation: 'generated_boilerplate',
  artifactPath: 'classified-artifact.txt',
  generatedContent: 'CLASSIFIED_GENERATED_PAYLOAD',
  dataClass: 'SECRET'
}), /refuses SECRET data/);
assert.equal(fs.existsSync(path.join(repo, 'classified-artifact.txt')), false, 'a SECRET generated payload is never written');
assert.throws(() => broker.requestContext({
  repoDir: repo,
  operation: 'file_read',
  filePath: 'src/small.js',
  query: 'target',
  dataClass: 'WORK_CORPORATE'
}), /unknown data class WORK_CORPORATE/);
assert.equal(cacheEntries(), cacheBefore, 'refused operations persist no cache scope');
const publicPack = broker.requestContext({ repoDir: repo, operation: 'read', filePath: 'classified.txt', query: 'x', dataClass: 'PUBLIC' });
const secretScopedPack = structuredClone(publicPack);
secretScopedPack.provenance.data_policy_scope = 'SECRET';
assert.throws(() => readTargetedSlice({ pack: secretScopedPack, repoDir: repo, filePath: 'classified.txt' }), /refuses SECRET data/);
assert.throws(() => readTargetedSlice({ pack: publicPack, repoDir: repo, filePath: 'classified.txt', dataClass: 'SECRET' }), /differs from the ContextPack scope/);
assert.throws(() => readTargetedSlice({ pack: {}, repoDir: repo, filePath: 'classified.txt' }), /requires a classified dataClass/);
assert.throws(() => readTargetedSlice({ repoDir: repo, filePath: 'classified.txt', dataClass: 'SECRET' }), /refuses SECRET data/);

// Without a worker adapter no worker ran, so no worker tokens are counted as spent.
const noAdapter = createContextBroker({ homeDir: home, routeSelector, dataGate: allowGate });
const noAdapterPack = noAdapter.requestContext({
  repoDir: repo,
  operation: 'read',
  content: source,
  path: 'src/no-adapter.js',
  query: 'needleHandler',
  dataClass: 'PUBLIC'
});
assert.equal(noAdapterPack.telemetry.fallback_to_direct_reasoner, true);
assert.equal(noAdapterPack.telemetry.shunt_worker_input_tokens, 0);
assert.equal(noAdapterPack.telemetry.shunt_worker_output_tokens, 0);
assert.equal(noAdapterPack.telemetry.total_model_tokens_spent, noAdapterPack.telemetry.reasoner_context_tokens_delivered);

const slice = readTargetedSlice({
  pack: huge,
  repoDir: repo,
  filePath: 'src/large.js',
  startLine: 2719,
  endLine: 2719
});
assert.equal(slice.content, 'export function needleHandler(input) { return input.trim(); }');
assert.equal(slice.source_hash, huge.source_hashes['src/large.js']);

const artifact = broker.requestContext({
  repoDir: repo,
  operation: 'generated',
  artifactPath: 'generated/fixture.test.js',
  generatedContent: 'export const fixture = true;\n',
  query: 'generated fixture',
  dataClass: 'PRIVATE_CODE'
});
assert.equal(artifact.operation, 'generated_boilerplate');
assert.equal(artifact.telemetry.context_worker_route, null);
assert.equal(fs.readFileSync(path.join(repo, 'generated', 'fixture.test.js'), 'utf8'), 'export const fixture = true;\n');
assert.ok(artifact.artifact.sha256);

const dispatchTask = 'context-dispatch-integration';
fs.mkdirSync(path.join(fixtureHome, 'data', dispatchTask), { recursive: true });
write(path.join(fixtureHome, 'data', dispatchTask, 'brief.md'), '# context dispatch\n');
let dispatchArgs = null;
const dispatched = router.dispatchThroughHerdr({
  taskId: dispatchTask,
  role: 'general_engineer',
  dataClass: 'PUBLIC',
  useLiveAxi: false,
  projectDir: repo,
  spawnRunner: (args) => {
    dispatchArgs = args;
    write(path.join(fixtureHome, 'state', `${dispatchTask}.meta`), 'harness=codex\nmodel=test\neffort=medium\n');
    return { success: true, output: 'integration spawn' };
  }
});
assert.equal(dispatched.success, true);
assert.ok(dispatchArgs.includes('--context-pack'), 'Router dispatch must hand the pack into fm-spawn');
assert.equal(dispatched.contextPack.telemetry.context_cache_miss, true);
assert.ok(fs.existsSync(path.join(fixtureHome, 'state', 'context-telemetry.jsonl')));

const telemetryLines = fs.readFileSync(path.join(fixtureHome, 'state', 'context-telemetry.jsonl'), 'utf8').trim().split('\n');
const telemetry = JSON.parse(telemetryLines.at(-1));
console.log(JSON.stringify({
  direct: direct.telemetry,
  huge: huge.telemetry,
  cached: cached.telemetry,
  condensed: condensed.telemetry,
  refused: { worker_refusal: refused.worker_refusal, worker_route: refused.telemetry.context_worker_route },
  actual_policy_refused: { worker_refusal: actualRefused.worker_refusal, worker_route: actualRefused.telemetry.context_worker_route },
  no_adapter: noAdapterPack.telemetry,
  generated_artifact_bytes: artifact.artifact.bytes,
  routed_context_route: routed.telemetry.context_worker_route,
  dispatch_context_route: dispatched.contextPack.telemetry.context_worker_route,
  dispatch_telemetry_records: telemetryLines.length
}, null, 2));
console.log('Context Broker deterministic, policy, cache, artifact, slice, and dispatch integration tests passed');
