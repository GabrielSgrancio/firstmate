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
