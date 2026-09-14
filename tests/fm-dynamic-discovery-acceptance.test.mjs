import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRouterFixtureHome } from './router-v2-fixture.mjs';

const home = makeRouterFixtureHome();
const discovery = await import('../bin/fm-provider-discovery.mjs');
const quota = await import('../bin/fm-opencode-quota.mjs');

const codex = discovery.discoverCodex({
  cachePath: path.join(home, 'home', '.codex', 'models_cache.json')
});
assert.equal(codex.source, 'codex_models_cache');
assert.equal(codex.models[0].smoke_tested, false);

const claude = discovery.discoverClaude({
  cachePath: path.join(home, 'home', '.claude.json')
});
assert.equal(claude.models[0].logical_alias, 'sonnet');
assert.equal(claude.models[0].metadata_provenance.source, '~/.claude.json#clientDataCacheSlots');

const openCode = discovery.discoverOpenCodeGo({
  fixturePath: path.join(home, 'home', 'opencode-models.json')
});
assert.ok(openCode.models.some(model => model.raw_id === 'qwen3.7-max'));
assert.equal(openCode.models.find(model => model.raw_id === 'qwen3.7-max').expected_normalized_burn, 12.5);
assert.ok(openCode.models.some(model => model.routing_status === 'BENCHMARK_ONLY'));

const compiled = discovery.compileRouteTargets({
  codex,
  claude,
  antigravity: {
    harness: 'antigravity',
    discovered_at: '2030-01-01T00:00:00Z',
    gemini_native: [{ slug: 'gemini-3.8-flash-low', smoke_tested: false, routing_status: 'ROUTING_ELIGIBLE', metadata_provenance: {} }],
    third_party: [{ slug: 'claude-sonnet-4-6', provider: 'anthropic', smoke_tested: false, routing_status: 'ROUTING_ELIGIBLE', metadata_provenance: {} }]
  },
  opencode_go: openCode
});
assert.ok(compiled.some(route => route.reasoning_effort === 'low'));
assert.ok(compiled.some(route => route.provider_path === 'antigravity_3p_gateway'));
assert.ok(compiled.every(route => route.route_id && route.quota_pool));

const refreshed = discovery.refreshAllCatalogs({
  codex: { cachePath: path.join(home, 'home', '.codex', 'models_cache.json') },
  claude: { cachePath: path.join(home, 'home', '.claude.json') },
  antigravity: { agyBin: path.join(home, 'missing-agy') },
  opencode_go: { fixturePath: path.join(home, 'home', 'opencode-models.json') }
});
assert.equal(refreshed.codexCount, 1);
assert.ok(fs.existsSync(path.join(home, 'data', 'provider-catalogs', 'compiled-route-targets.json')));

const noCredential = discovery.discoverOpenCodeGo({
  authPath: path.join(home, 'missing-auth.json')
});
assert.equal(noCredential.stale, true);
assert.equal(noCredential.refresh_failed, true);

const fallback = discovery.discoverCodex({ cachePath: path.join(home, 'missing-cache.json') });
assert.equal(fallback.stale, true);
assert.equal(fallback.refresh_failed, true);
assert.equal(fallback.source, 'codex_models_cache');

// Harness executable integrity gate: a synthetic zero-byte fixture must be
// classified BROKEN and excluded from ROUTING_ELIGIBLE, never silently
// omitted and never auto-repaired (data/incident-2026-09-13-oom-cli-truncation.md).
const zeroByteBin = path.join(home, 'zero-byte-codex');
fs.writeFileSync(zeroByteBin, '');
fs.chmodSync(zeroByteBin, 0o755);
const brokenCodex = discovery.discoverCodex({
  cachePath: path.join(home, 'home', '.codex', 'models_cache.json'),
  codexBin: zeroByteBin
});
assert.equal(brokenCodex.broken, true);
assert.equal(brokenCodex.integrity.ok, false);
assert.ok(brokenCodex.integrity.reasons[0].includes('zero bytes'));
assert.equal(brokenCodex.models.length, 0);

// A healthy real harness already discovered on this host (no codexBin/claudeBin
// override -> resolved from PATH) must still classify ROUTING_ELIGIBLE: the gate
// must not exclude everything.
assert.equal(codex.broken, false);
assert.equal(codex.integrity.ok, true);
assert.equal(codex.models[0].routing_status, 'ROUTING_ELIGIBLE');
assert.equal(claude.broken, false);
assert.equal(claude.integrity.ok, true);

// BROKEN harnesses must never appear in the compiled ROUTING_ELIGIBLE list
// consumed downstream by dispatch/routing - only a BROKEN marker route, and
// no ROUTING_ELIGIBLE route for that harness.
const compiledWithBrokenCodex = discovery.compileRouteTargets({
  codex: brokenCodex,
  claude,
  antigravity: { harness: 'antigravity', discovered_at: now(), gemini_native: [], third_party: [] },
  opencode_go: openCode
});
assert.ok(compiledWithBrokenCodex.some(route => route.harness === 'codex' && route.routing_status === 'BROKEN'));
assert.ok(!compiledWithBrokenCodex.some(route => route.harness === 'codex' && route.routing_status === 'ROUTING_ELIGIBLE'));

function now() {
  return new Date().toISOString();
}

const diff = discovery.diffCatalogs(
  { codex: { models: [{ slug: 'same', context_window: 1 }] } },
  { codex: { models: [{ slug: 'same', context_window: 2 }, { slug: 'new' }] } }
);
assert.deepEqual(diff.harness_diffs.codex.added, ['new']);
assert.equal(diff.harness_diffs.codex.modified[0].changes[0].property, 'context_window');
const normalized = quota.normalizeUsageResponse({
  rolling: { percent: 10 },
  weekly: { percent: 20 },
  monthly: { percent: 30 }
});
assert.equal(normalized.rolling_5h.percent_remaining, 90);
assert.equal(quota.deriveScarcityState(normalized), 'ABUNDANT');
assert.equal(quota.normalizeUsageResponse({ rolling: { percent: 10 } }).scarcity_state, 'UNKNOWN');
assert.equal(quota.loadSnapshotFallback('no credential').scarcity_state, 'UNKNOWN');
console.log('Dynamic discovery and generated-state lifecycle fixtures passed');
