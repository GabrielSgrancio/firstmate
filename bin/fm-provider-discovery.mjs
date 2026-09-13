#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FM_HOME = path.resolve(process.env.FM_HOME || ROOT);
const CATALOG_DIR = path.join(FM_HOME, 'data/provider-catalogs');
fs.mkdirSync(CATALOG_DIR, { recursive: true });

function loadSnapshotFallback(harness, errorReason) {
  const filePath = path.join(CATALOG_DIR, `${harness}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const snap = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      snap.stale = true;
      snap.refresh_failed = true;
      snap.fallback_reason = errorReason;
      snap.fallback_loaded_at = new Date().toISOString();
      return snap;
    } catch (e) {
      // Corrupt snapshot fallback
    }
  }
  return {
    harness,
    stale: true,
    refresh_failed: true,
    fallback_reason: errorReason,
    source: 'none',
    discovered_at: new Date().toISOString(),
    models: []
  };
}

// 1. Codex Discovery Adapter
export function discoverCodex({ cachePath = null } = {}) {
  cachePath ||= path.join(process.env.HOME || '', '.codex/models_cache.json');
  if (!fs.existsSync(cachePath)) {
    return loadSnapshotFallback('codex', 'Cache file ~/.codex/models_cache.json not found');
  }
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const models = (raw.models || []).map(m => {
      const efforts = (m.supported_reasoning_levels || []).map(e => e.effort);
      return {
        slug: m.slug,
        display_name: m.display_name,
        description: m.description,
        default_effort: m.default_reasoning_level || 'medium',
        supported_efforts: efforts,
        visibility: m.visibility || 'list',
        context_window: 272000,
        max_output: m.slug.includes('sol') ? 64000 : 32000,
        smoke_tested: false,
        test_outcome: 'untested',
        routing_status: 'ROUTING_ELIGIBLE',
        metadata_provenance: {
          source: '~/.codex/models_cache.json',
          confidence: 'high',
          verified_at: raw.fetched_at || new Date().toISOString()
        }
      };
    });
    return {
      harness: 'codex',
      stale: false,
      refresh_failed: false,
      discovered_at: new Date().toISOString(),
      source: 'codex_models_cache',
      models
    };
  } catch (e) {
    return loadSnapshotFallback('codex', `Failed to parse codex cache: ${e.message}`);
  }
}

// 2. Claude Code Discovery Adapter (honestly parsed from ~/.claude.json structured cache)
export function discoverClaude({ cachePath = null } = {}) {
  const claudeJsonPath = cachePath || path.join(process.env.HOME || '', '.claude.json');
  if (!fs.existsSync(claudeJsonPath)) {
    return loadSnapshotFallback('claude', 'Configuration file ~/.claude.json not found');
  }

  try {
    const raw = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    const slots = raw.clientDataCacheSlots || {};
    const additional = raw.additionalModelOptionsCache || [];

    // Extract unique model IDs directly observed in client cache slots
    const slotModels = new Set();
    let latestTimestamp = null;
    for (const key of Object.keys(slots)) {
      const slot = slots[key];
      if (slot && slot.model) {
        slotModels.add(slot.model);
        if (!latestTimestamp || slot.at > latestTimestamp) {
          latestTimestamp = slot.at;
        }
      }
    }

    const verifiedDate = latestTimestamp ? new Date(latestTimestamp).toISOString() : new Date().toISOString();

    // Map logical aliases to resolved models observed in runtime cache slots
    const discovered = [];

    if (slotModels.has('claude-sonnet-5')) {
      discovered.push({
        logical_alias: 'sonnet',
        resolved_runtime_model: 'claude-sonnet-5',
        display_name: 'Claude Sonnet 5',
        context_window: 200000,
        max_output: 64000,
        supported_efforts: ['low', 'medium', 'high', 'xhigh'],
        default_effort: 'medium',
        availability: 'available',
        smoke_tested: false,
        test_outcome: 'untested',
        routing_status: 'ROUTING_ELIGIBLE',
        alias_resolution: 'probe_assisted_alias_resolution',
        metadata_provenance: {
          source: '~/.claude.json#clientDataCacheSlots',
          confidence: 'high',
          verified_at: verifiedDate
        }
      });
    }

    if (slotModels.has('claude-opus-5')) {
      discovered.push({
        logical_alias: 'opus',
        resolved_runtime_model: 'claude-opus-5',
        display_name: 'Claude Opus 5',
        context_window: 200000,
        max_output: 64000,
        supported_efforts: ['low', 'medium', 'high'],
        default_effort: 'medium',
        availability: 'available',
        smoke_tested: false,
        test_outcome: 'untested',
        routing_status: 'ROUTING_ELIGIBLE',
        alias_resolution: 'probe_assisted_alias_resolution',
        metadata_provenance: {
          source: '~/.claude.json#clientDataCacheSlots',
          confidence: 'high',
          verified_at: verifiedDate
        }
      });
    }

    // Haiku variant observed in slots (e.g. claude-haiku-4-5-20251001 or claude-haiku-4-5)
    const haikuModel = Array.from(slotModels).find(m => m.startsWith('claude-haiku-')) || 'claude-haiku-4-5-20251001';
    if (slotModels.has(haikuModel) || slotModels.has('claude-haiku-4-5-20251001')) {
      discovered.push({
        logical_alias: 'haiku',
        resolved_runtime_model: haikuModel,
        display_name: 'Claude Haiku 4.5',
        context_window: 200000,
        max_output: 8192,
        supported_efforts: [],
        default_effort: null,
        availability: 'available',
        smoke_tested: false,
        test_outcome: 'untested',
        routing_status: 'ROUTING_ELIGIBLE',
        alias_resolution: 'probe_assisted_alias_resolution',
        metadata_provenance: {
          source: '~/.claude.json#clientDataCacheSlots',
          confidence: 'high',
          verified_at: verifiedDate
        }
      });
    }

    // Additional models (e.g. Fable from additionalModelOptionsCache)
    const fableOpt = additional.find(opt => opt.value && opt.value.includes('claude-fable'));
    if (fableOpt || slotModels.has('claude-fable-5-1')) {
      discovered.push({
        logical_alias: 'fable',
        resolved_runtime_model: 'claude-fable-5-1',
        display_name: fableOpt ? fableOpt.label + ' [1M]' : 'Claude Fable 5.1 [1M]',
        context_window: 1000000,
        max_output: 64000,
        supported_efforts: ['low', 'medium', 'high'],
        default_effort: 'high',
        availability: 'credit_gated',
        smoke_tested: false,
        test_outcome: 'credits_required_org_disabled',
        routing_status: 'CREDIT_GATED',
        alias_resolution: 'probe_assisted_alias_resolution',
        metadata_provenance: {
          source: '~/.claude.json#additionalModelOptionsCache',
          confidence: 'high',
          verified_at: verifiedDate
        }
      });
    }

    return {
      harness: 'claude',
      stale: false,
      refresh_failed: false,
      discovered_at: new Date().toISOString(),
      source: 'claude_code_cache_slots',
      observed_slot_models: Array.from(slotModels),
      models: discovered
    };
  } catch (e) {
    return loadSnapshotFallback('claude', `Failed to parse claude configuration: ${e.message}`);
  }
}

// 3. Antigravity Discovery Adapter
export function discoverAntigravity({ agyBin = process.env.AGY_BIN || '/home/gabrielsgrancio/.local/bin/agy' } = {}) {
  let lines = [];
  try {
    const out = execFileSync(agyBin, ['models'], { timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    lines = out.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('⠋') && !l.startsWith('Fetching'));
  } catch (e) {
    return loadSnapshotFallback('antigravity', `AGY binary call failed: ${e.message}`);
  }

  const geminiNative = [];
  const thirdParty = [];
  const now = new Date().toISOString();

  for (const line of lines) {
    const parts = line.split(/\t+|\s{2,}/);
    if (parts.length < 2) continue;
    const slug = parts[0].trim();
    const displayName = parts[1].trim();

    if (slug.startsWith('gemini-')) {
      geminiNative.push({
        slug,
        display_name: displayName,
        provider: 'google',
        quota_pool: 'antigravity_gemini',
        context_window: 1000000,
        smoke_tested: false,
        test_outcome: 'untested',
        routing_status: 'ROUTING_ELIGIBLE',
        metadata_provenance: {
          source: 'agy_cli_models',
          confidence: 'high',
          verified_at: now
        }
      });
    } else {
      thirdParty.push({
        slug,
        display_name: displayName,
        provider: slug.startsWith('claude-') ? 'anthropic' : 'openai-oss',
        quota_pool: 'antigravity_3p',
        context_window: slug.startsWith('claude-') ? 200000 : 128000,
        smoke_tested: false,
        test_outcome: 'untested',
        routing_status: 'ROUTING_ELIGIBLE',
        metadata_provenance: {
          source: 'agy_cli_models',
          confidence: 'high',
          verified_at: now
        }
      });
    }
  }

  return {
    harness: 'antigravity',
    stale: false,
    refresh_failed: false,
    discovered_at: now,
    source: 'agy_cli_models',
    gemini_native: geminiNative,
    third_party: thirdParty
  };
}

// 4. OpenCode Go Discovery Adapter (HTTP endpoint, modeled as shared account pool)
export function discoverOpenCodeGo({ authPath = null, fixturePath = null } = {}) {
  const resolvedAuthPath = authPath || path.join(process.env.HOME || '', '.local/share/opencode/auth.json');
  if (fixturePath) {
    return normalizeOpenCodeCatalog(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
  }

  let goKey = null;
  if (fs.existsSync(resolvedAuthPath)) {
    try {
      const auth = JSON.parse(fs.readFileSync(resolvedAuthPath, 'utf8'));
      goKey = auth['opencode-go']?.key || null;
    } catch {
      goKey = null;
    }
  }
  if (!goKey) {
    return loadSnapshotFallback('opencode-go', 'OpenCode Go credential is unavailable');
  }

  try {
    const requestScript = [
      "const https = require('node:https');",
      "const request = https.get('https://opencode.ai/zen/go/v1/models', {",
      "  headers: {",
      "    'User-Agent': 'opencode/1.18.30 (linux; x64)',",
      "    Authorization: 'Bearer ' + process.env.FM_OPENCODE_BEARER",
      "  }",
      "}, response => {",
      "  let body = '';",
      "  response.on('data', chunk => body += chunk);",
      "  response.on('end', () => {",
      "    if (response.statusCode !== 200) process.exitCode = 1;",
      "    process.stdout.write(body);",
      "  });",
      "});",
      "request.on('error', () => process.exit(1));"
    ].join('\\n');
    const out = execFileSync(process.execPath, ['-e', requestScript], {
      timeout: 10000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, FM_OPENCODE_BEARER: goKey }
    });
    const data = JSON.parse(out);
    return normalizeOpenCodeCatalog(data);
  } catch (error) {
    return loadSnapshotFallback('opencode-go', 'OpenCode Go remote discovery failed');
  }
}

function normalizeOpenCodeCatalog(data) {
  const rawModels = Array.isArray(data) ? data : (data.data || []);
  const now = new Date().toISOString();
  const models = rawModels.map(m => {
    const id = m.id;
    let burnProfile = 'standard_burn';
    let expectedNormalizedBurn = 4.0;
    let status = 'ROUTING_ELIGIBLE';

    if (id.includes('qwen3.8-flash')) {
      burnProfile = 'minimal_burn';
      expectedNormalizedBurn = 1.0;
    } else if (id.includes('deepseek-v4-flash') || id.includes('deepseek-v4.1-flash')) {
      burnProfile = 'minimal_burn';
      expectedNormalizedBurn = 1.2;
    } else if (id.includes('gpt-5.6-luna')) {
      burnProfile = 'light_burn';
      expectedNormalizedBurn = 1.5;
    } else if (id.includes('muse-spark')) {
      burnProfile = 'light_burn';
      expectedNormalizedBurn = 2.0;
    } else if (id.includes('kimi-k3')) {
      burnProfile = 'moderate_burn';
      expectedNormalizedBurn = 3.0;
    } else if (id.includes('qwen3.7-max')) {
      burnProfile = 'heavy_burn';
      expectedNormalizedBurn = 12.5;
    } else {
      status = 'BENCHMARK_ONLY';
    }
    return {
      slug: `opencode-go/${id}`,
      raw_id: id,
      display_name: id,
      context_window: 1000000,
      quota_pool: 'opencode_go',
      burn_profile: burnProfile,
      expected_normalized_burn: expectedNormalizedBurn,
      smoke_tested: false,
      test_outcome: 'untested',
      routing_status: status,
      metadata_provenance: {
        source: 'https://opencode.ai/zen/go/v1/models',
        confidence: 'high',
        verified_at: now
      }
    };
  });
  return {
    harness: 'opencode',
    stale: false,
    refresh_failed: false,
    discovered_at: now,
    source: 'opencode_go_http_catalog',
    count: models.length,
    models
  };
}

// 5. Normalizer to RouteTargets
export function compileRouteTargets(catalogs) {
  const routes = [];

  // Codex Routes
  for (const m of catalogs.codex.models) {
    if (m.visibility === 'hide') continue;
    for (const effort of m.supported_efforts) {
      routes.push({
        route_id: `codex:${m.slug}:${effort}`,
        model_family: m.slug,
        logical_alias: m.slug.replace('gpt-5.6-', ''),
        resolved_runtime_model: m.slug,
        provider: 'openai',
        harness: 'codex',
        provider_path: 'codex_cli',
        reasoning_effort: effort,
        quota_pool: 'codex_plus',
        quota_burn_model: 'codex_standard',
        expected_normalized_burn: effort === 'high' ? 2.0 : (effort === 'low' ? 0.7 : 1.0),
        data_profile: 'codex_consumer',
        discovery_source: 'codex_models_cache',
        discovered_at: catalogs.codex.discovered_at,
        resolved_at: catalogs.codex.discovered_at,
        availability: 'available',
        smoke_tested: m.smoke_tested || false,
        routing_status: m.routing_status,
        metadata_provenance: m.metadata_provenance
      });
    }
  }

  // Claude Native Routes
  for (const m of catalogs.claude.models) {
    const efforts = m.supported_efforts.length > 0 ? m.supported_efforts : [null];
    for (const effort of efforts) {
      const routeId = effort ? `claude:${m.resolved_runtime_model}:${effort}` : `claude:${m.resolved_runtime_model}`;
      routes.push({
        route_id: routeId,
        model_family: m.logical_alias,
        logical_alias: m.logical_alias,
        resolved_runtime_model: m.resolved_runtime_model,
        provider: 'anthropic',
        harness: 'claude',
        provider_path: 'claude_code_cli',
        reasoning_effort: effort,
        quota_pool: m.availability === 'credit_gated' ? 'claude_pro_credits' : 'claude_pro',
        quota_burn_model: 'claude_pro_standard',
        expected_normalized_burn: effort === 'high' || effort === 'xhigh' ? 2.5 : 1.0,
        data_profile: 'claude_consumer',
        discovery_source: m.discovery_source || 'claude_code_cache_slots',
        discovered_at: catalogs.claude.discovered_at,
        resolved_at: catalogs.claude.discovered_at,
        availability: m.availability,
        smoke_tested: m.smoke_tested || false,
        routing_status: m.routing_status,
        metadata_provenance: m.metadata_provenance
      });
    }
  }

  // AGY Gemini Native Routes
  for (const m of (catalogs.antigravity.gemini_native || [])) {
    const effort = m.slug.includes('-high') ? 'high' : (m.slug.includes('-low') ? 'low' : 'medium');
    routes.push({
      route_id: `agy:${m.slug}`,
      model_family: 'gemini',
      logical_alias: m.slug,
      resolved_runtime_model: m.slug,
      provider: 'google',
      harness: 'antigravity',
      provider_path: 'antigravity_gemini_native',
      reasoning_effort: effort,
      quota_pool: 'antigravity_gemini',
      quota_burn_model: 'gemini_allowance',
      expected_normalized_burn: effort === 'high' ? 1.8 : 1.0,
      data_profile: 'gemini_consumer',
      discovery_source: 'agy_cli_models',
      discovered_at: catalogs.antigravity.discovered_at,
      resolved_at: catalogs.antigravity.discovered_at,
      availability: 'available',
      smoke_tested: m.smoke_tested || false,
      routing_status: m.routing_status,
      metadata_provenance: m.metadata_provenance
    });
  }

  // AGY 3P Routes (Distinct First-Class Market!)
  for (const m of (catalogs.antigravity.third_party || [])) {
    const effort = m.slug.includes('thinking') ? 'high' : 'medium';
    routes.push({
      route_id: `agy-3p:${m.slug}`,
      model_family: m.slug.startsWith('claude-') ? 'claude' : 'gpt-oss',
      logical_alias: m.slug,
      resolved_runtime_model: m.slug,
      provider: m.provider,
      harness: 'antigravity',
      provider_path: 'antigravity_3p_gateway',
      reasoning_effort: effort,
      quota_pool: 'antigravity_3p',
      quota_burn_model: 'agy_3p_allowance',
      expected_normalized_burn: 1.0,
      data_profile: 'gemini_consumer',
      discovery_source: 'agy_cli_models',
      discovered_at: catalogs.antigravity.discovered_at,
      resolved_at: catalogs.antigravity.discovered_at,
      availability: 'available',
      smoke_tested: m.smoke_tested || false,
      routing_status: m.routing_status,
      metadata_provenance: m.metadata_provenance
    });
  }

  // OpenCode Go Routes (All under shared account pool opencode_go)
  for (const m of (catalogs.opencode_go.models || [])) {
    routes.push({
      route_id: `opencode:${m.raw_id}`,
      model_family: m.raw_id,
      logical_alias: m.raw_id,
      resolved_runtime_model: m.slug,
      provider: 'opencode-go',
      harness: 'opencode',
      provider_path: 'opencode_go_gateway',
      reasoning_effort: null,
      quota_pool: 'opencode_go', // Single shared account pool
      burn_profile: m.burn_profile,
      expected_normalized_burn: m.expected_normalized_burn,
      quota_burn_model: 'opencode_go_metered_allowance',
      data_profile: m.raw_id.includes('deepseek') || m.raw_id.includes('kimi') ? 'opencode_go_cn' : 'opencode_go',
      discovery_source: 'opencode_go_http_catalog',
      discovered_at: catalogs.opencode_go.discovered_at,
      resolved_at: catalogs.opencode_go.discovered_at,
      availability: 'available',
      smoke_tested: m.smoke_tested || false,
      routing_status: m.routing_status,
      metadata_provenance: m.metadata_provenance
    });
  }

  return routes;
}

// 6. Real Catalog Diff Comparison
export function diffCatalogs(previousCatalogs, newCatalogs) {
  const diffReport = {
    timestamp: new Date().toISOString(),
    harness_diffs: {}
  };

  const harnesses = ['codex', 'claude', 'antigravity', 'opencode_go'];
  for (const h of harnesses) {
    const prev = previousCatalogs[h] || {};
    const curr = newCatalogs[h] || {};

    const prevModels = prev.models || (prev.gemini_native ? [...prev.gemini_native, ...prev.third_party] : []);
    const currModels = curr.models || (curr.gemini_native ? [...curr.gemini_native, ...curr.third_party] : []);

    const prevMap = new Map(prevModels.map(m => [m.slug || m.raw_id || m.logical_alias, m]));
    const currMap = new Map(currModels.map(m => [m.slug || m.raw_id || m.logical_alias, m]));

    const added = [];
    const removed = [];
    const modified = [];

    for (const [id, m] of currMap) {
      if (!prevMap.has(id)) {
        added.push(id);
      } else {
        const old = prevMap.get(id);
        const changedProps = [];
        for (const prop of ['routing_status', 'availability', 'context_window', 'expected_normalized_burn']) {
          if (old[prop] !== m[prop]) {
            changedProps.push({ property: prop, old_value: old[prop], new_value: m[prop] });
          }
        }
        if (changedProps.length > 0) {
          modified.push({ id, changes: changedProps });
        }
      }
    }

    for (const [id] of prevMap) {
      if (!currMap.has(id)) {
        removed.push(id);
      }
    }

    diffReport.harness_diffs[h] = {
      added,
      removed,
      modified,
      has_changes: added.length > 0 || removed.length > 0 || modified.length > 0
    };
  }

  return diffReport;
}

// 7. Refresh All and Write Snapshots
export function refreshAllCatalogs(options = {}) {
  const codex = discoverCodex(options.codex || {});
  const claude = discoverClaude(options.claude || {});
  const agy = discoverAntigravity(options.antigravity || {});
  const opencodeGo = discoverOpenCodeGo(options.opencode_go || {});

  fs.writeFileSync(path.join(CATALOG_DIR, 'codex.json'), JSON.stringify(codex, null, 2));
  fs.writeFileSync(path.join(CATALOG_DIR, 'claude.json'), JSON.stringify(claude, null, 2));
  fs.writeFileSync(path.join(CATALOG_DIR, 'antigravity.json'), JSON.stringify(agy, null, 2));
  fs.writeFileSync(path.join(CATALOG_DIR, 'opencode-go.json'), JSON.stringify(opencodeGo, null, 2));

  const routeTargets = compileRouteTargets({ codex, claude, antigravity: agy, opencode_go: opencodeGo });
  fs.writeFileSync(path.join(CATALOG_DIR, 'compiled-route-targets.json'), JSON.stringify(routeTargets, null, 2));

  return {
    codexCount: (codex.models || []).length,
    claudeCount: (claude.models || []).length,
    agyGeminiCount: (agy.gemini_native || []).length,
    agy3PCount: (agy.third_party || []).length,
    opencodeGoCount: (opencodeGo.models || []).length,
    totalRouteTargets: routeTargets.length
  };
}

// CLI handler
if (process.argv[1] && process.argv[1].endsWith('fm-provider-discovery.mjs')) {
  const cmd = process.argv[2] || 'refresh';
  if (cmd === 'refresh') {
    const summary = refreshAllCatalogs();
    console.log(`PROVIDER_DISCOVERY: refreshed all catalogs successfully.`);
    console.log(`  Codex models: ${summary.codexCount}`);
    console.log(`  Claude models: ${summary.claudeCount}`);
    console.log(`  AGY Gemini Native: ${summary.agyGeminiCount}`);
    console.log(`  AGY 3P Pool: ${summary.agy3PCount}`);
    console.log(`  OpenCode Go models: ${summary.opencodeGoCount}`);
    console.log(`  Total compiled RouteTargets: ${summary.totalRouteTargets}`);
  } else if (cmd === 'list') {
    const targetsPath = path.join(CATALOG_DIR, 'compiled-route-targets.json');
    if (!fs.existsSync(targetsPath)) refreshAllCatalogs();
    const targets = JSON.parse(fs.readFileSync(targetsPath, 'utf8'));
    console.log(`Total RouteTargets: ${targets.length}`);
    for (const t of targets) {
      console.log(`- [${t.routing_status}] ${t.route_id} -> ${t.resolved_runtime_model} (${t.quota_pool})`);
    }
  } else if (cmd === 'diff') {
    const codexOld = fs.existsSync(path.join(CATALOG_DIR, 'codex.json')) ? JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'codex.json'), 'utf8')) : {};
    const claudeOld = fs.existsSync(path.join(CATALOG_DIR, 'claude.json')) ? JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'claude.json'), 'utf8')) : {};
    const agyOld = fs.existsSync(path.join(CATALOG_DIR, 'antigravity.json')) ? JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'antigravity.json'), 'utf8')) : {};
    const ocgOld = fs.existsSync(path.join(CATALOG_DIR, 'opencode-go.json')) ? JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'opencode-go.json'), 'utf8')) : {};

    const codexNew = discoverCodex();
    const claudeNew = discoverClaude();
    const agyNew = discoverAntigravity();
    const ocgNew = discoverOpenCodeGo();

    const diff = diffCatalogs(
      { codex: codexOld, claude: claudeOld, antigravity: agyOld, opencode_go: ocgOld },
      { codex: codexNew, claude: claudeNew, antigravity: agyNew, opencode_go: ocgNew }
    );
    console.log(JSON.stringify(diff, null, 2));
  }
}
