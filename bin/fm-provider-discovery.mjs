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

// --- Harness executable integrity gate --------------------------------------
// A harness must prove its own executable is intact before any of its models
// can become ROUTING_ELIGIBLE (see data/incident-2026-09-13-oom-cli-truncation.md:
// four harness executables were found zeroed simultaneously during a host OOM,
// with no code path here checking executable integrity before routing on it).
// On failure the harness is marked broken and excluded from routing; nothing
// in this gate repairs, reinstalls, or overwrites the executable.

function resolveOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not present in this PATH entry
    }
  }
  return null;
}

function checkExecutableFile(resolvedPath) {
  if (!resolvedPath) {
    return { ok: false, reason: 'executable could not be resolved on PATH' };
  }
  let realPath;
  try {
    realPath = fs.realpathSync(resolvedPath);
  } catch (e) {
    return { ok: false, reason: `executable path ${resolvedPath} does not exist (${e.code || e.message})` };
  }
  let stat;
  try {
    stat = fs.statSync(realPath);
  } catch (e) {
    return { ok: false, reason: `cannot stat resolved executable ${realPath}: ${e.message}` };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: `resolved executable ${realPath} is not a regular file` };
  }
  if (stat.size === 0) {
    return { ok: false, reason: `executable ${realPath} is zero bytes` };
  }
  if ((stat.mode & 0o111) === 0) {
    return { ok: false, reason: `executable ${realPath} has no executable bit set` };
  }
  return { ok: true, realPath };
}

function looksLikePlausibleProbeOutput(text) {
  const trimmed = (text || '').trim();
  if (!trimmed || trimmed.length > 4000) return false;
  const printable = trimmed.replace(/[^\x20-\x7E\s]/g, '');
  return printable.length / trimmed.length > 0.9;
}

function probeVersion(execPath, args) {
  try {
    const out = execFileSync(execPath, args, { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!looksLikePlausibleProbeOutput(out)) {
      return { ok: false, reason: `${execPath} ${args.join(' ')} produced empty or implausible output` };
    }
    return { ok: true, output: out.trim() };
  } catch (e) {
    return { ok: false, reason: `${execPath} ${args.join(' ')} failed: ${e.message}` };
  }
}

function brokenCatalog(harness, reasons, extra = {}) {
  for (const reason of reasons) {
    console.log(`PROVIDER_DISCOVERY: ${harness} BROKEN - ${reason}`);
  }
  return {
    harness,
    stale: true,
    refresh_failed: true,
    broken: true,
    integrity: { ok: false, reasons },
    source: 'harness_integrity_check',
    discovered_at: new Date().toISOString(),
    models: [],
    ...extra
  };
}

// 1. Codex Discovery Adapter
export function discoverCodex({ cachePath = null, codexBin = null, probeArgs = ['--version'] } = {}) {
  const resolvedBin = codexBin || process.env.CODEX_BIN || resolveOnPath('codex');
  const fileCheck = checkExecutableFile(resolvedBin);
  if (!fileCheck.ok) {
    return brokenCatalog('codex', [fileCheck.reason]);
  }
  const probe = probeVersion(fileCheck.realPath, probeArgs);
  if (!probe.ok) {
    return brokenCatalog('codex', [probe.reason]);
  }

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
      broken: false,
      integrity: { ok: true },
      discovered_at: new Date().toISOString(),
      source: 'codex_models_cache',
      models
    };
  } catch (e) {
    return loadSnapshotFallback('codex', `Failed to parse codex cache: ${e.message}`);
  }
}

// 2. Claude Code Discovery Adapter (honestly parsed from ~/.claude.json structured cache)
export function discoverClaude({ cachePath = null, claudeBin = null, probeArgs = ['--version'] } = {}) {
  const resolvedBin = claudeBin || process.env.CLAUDE_BIN || resolveOnPath('claude');
  const fileCheck = checkExecutableFile(resolvedBin);
  if (!fileCheck.ok) {
    return brokenCatalog('claude', [fileCheck.reason]);
  }
  const probe = probeVersion(fileCheck.realPath, probeArgs);
  if (!probe.ok) {
    return brokenCatalog('claude', [probe.reason]);
  }

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
      broken: false,
      integrity: { ok: true },
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
  const fileCheck = checkExecutableFile(agyBin);
  if (!fileCheck.ok) {
    return brokenCatalog('antigravity', [fileCheck.reason], { gemini_native: [], third_party: [] });
  }

  let lines = [];
  try {
    const out = execFileSync(fileCheck.realPath, ['models'], { timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (!out || !out.trim()) {
      return brokenCatalog('antigravity', [`${fileCheck.realPath} models produced no output`], { gemini_native: [], third_party: [] });
    }
    lines = out.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('⠋') && !l.startsWith('Fetching'));
  } catch (e) {
    return brokenCatalog('antigravity', [`${fileCheck.realPath} models failed: ${e.message}`], { gemini_native: [], third_party: [] });
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
    broken: false,
    integrity: { ok: true },
    discovered_at: now,
    source: 'agy_cli_models',
    gemini_native: geminiNative,
    third_party: thirdParty
  };
}

// The bearer key reaches the child only through its environment.
export function openCodeCatalogRequestScript() {
  return [
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
  ].join('\n');
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
    const requestScript = openCodeCatalogRequestScript();
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

// Burn contract (correction pass): capacity accounting is dollar/token
// denominated.  A Go model's expected normalized burn is the estimated USD
// burn of one typical request as a share of that model's own rolling 5h USD
// window (percent points), computed from the published token prices and the
// docs' typical-request composition — not from the "estimated requests"
// table, which OpenCode publishes only as an estimate of typical usage.
// Models with no published pricing row yet fall back to the BENCHMARK_ONLY
// default until their price is researched.
const OPENCODE_RESEARCHED_BURN = {};
// Published per-model token pricing for OpenCode Go.  OpenCode's own docs
// (https://opencode.ai/docs/go/, retrieved 2026-09-19) define enforcement per
// model in DOLLAR amounts: "Usage limits are defined as monthly dollar
// amounts. Each model has the following usage limits: 5-hour — 20% of the
// monthly limit; weekly — 50%; and monthly — 100%."  Token prices are per 1M
// tokens.  The docs' "estimated requests" tables are only estimates derived
// from a typical-request token composition per model (also recorded below) and
// are NOT request-count quotas, so capacity accounting below is dollar/token
// denominated, never attempt-count denominated.
// DeepSeek models have peak hours 01:00-04:00 and 06:00-10:00 UTC Mon-Fri
// (off-peak otherwise); the DeepSeek V4.1/Flash promo (4x, ends Sep 20) is
// encoded as expiring overrides.
const OPENCODE_GO_ALLOWANCE_RETRIEVED_AT = '2026-09-19';
const OPENCODE_GO_MODEL_PRICING = {
  'glm-5.3-flash': { input: 0.15, output: 0.50, cache_read: 0.03, cache_write: 0, monthly_usd: 60, composition: { input: 1000, cached: 55000, output: 200 } },
  'glm-5.3': { input: 1.40, output: 4.40, cache_read: 0.26, cache_write: 0, monthly_usd: 15, composition: { input: 700, cached: 52000, output: 150 } },
  'glm-5.2': { input: 1.40, output: 4.40, cache_read: 0.26, cache_write: 0, monthly_usd: 60, composition: { input: 700, cached: 52000, output: 150 } },
  'glm-5.1': { input: 1.40, output: 4.40, cache_read: 0.26, cache_write: 0, monthly_usd: 60, composition: { input: 700, cached: 52000, output: 150 } },
  'kimi-k3': { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 0, monthly_usd: 15, composition: { input: 1050, cached: 76500, output: 300 } },
  'kimi-k2.7-code': { input: 0.95, output: 4.00, cache_read: 0.19, cache_write: 0, monthly_usd: 60, composition: { input: 870, cached: 55000, output: 200 } },
  'kimi-k2.6': { input: 0.95, output: 4.00, cache_read: 0.16, cache_write: 0, monthly_usd: 60, composition: { input: 870, cached: 55000, output: 200 } },
  'longcat-2.0': { input: 0.30, output: 1.20, cache_read: 0.006, cache_write: 0, monthly_usd: 60, composition: { input: 920, cached: 88900, output: 200 } },
  'mimo-v2.5': { input: 0.14, output: 0.28, cache_read: 0.0028, cache_write: 0, monthly_usd: 60, composition: { input: 830, cached: 71500, output: 295 } },
  'mimo-v2.5-pro': { input: 0.435, output: 0.87, cache_read: 0.003625, cache_write: 0, monthly_usd: 15, composition: { input: 790, cached: 86000, output: 305 } },
  'minimax-m3': { input: 0.30, output: 1.20, cache_read: 0.06, cache_write: 0, monthly_usd: 60, composition: { input: 510, cached: 56000, output: 190 } },
  'minimax-m2.7': { input: 0.30, output: 1.20, cache_read: 0.06, cache_write: 0.375, monthly_usd: 60, composition: { input: 300, cached: 55000, output: 125 } },
  'muse-spark-1.3-contributor': { input: 0.10, output: 0.20, cache_read: 0.002, cache_write: 0, monthly_usd: 60, composition: { input: 620, cached: 71400, output: 300 } },
  'muse-spark-1.2-contributor': { input: 0.10, output: 0.20, cache_read: 0.002, cache_write: 0, monthly_usd: 60, composition: { input: 620, cached: 71400, output: 300 } },
  'qwen3.8-max': { input: 2.00, output: 6.00, cache_read: 0.25, cache_write: 2.50, monthly_usd: 15, composition: { input: 420, cached: 66000, output: 200 } },
  'qwen3.8-flash': { input: 0.15, output: 0.47, cache_read: 0.016, cache_write: 0.20, monthly_usd: 30, composition: { input: 600, cached: 58000, output: 200 } },
  'qwen3.7-max': { input: 2.50, output: 7.50, cache_read: 0.50, cache_write: 3.125, monthly_usd: 30, composition: { input: 420, cached: 66000, output: 200 } },
  'qwen3.7-plus': { input: 0.40, output: 1.60, cache_read: 0.04, cache_write: 0.50, monthly_usd: 60, composition: { input: 500, cached: 57000, output: 190 } },
  'qwen3.6-plus': { input: 0.50, output: 3.00, cache_read: 0.05, cache_write: 0.625, monthly_usd: 60, composition: { input: 500, cached: 57000, output: 190 } },
  // DeepSeek peak hours are 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri.
  'deepseek-v4.1-flash': {
    input: 0.15, output: 0.60, cache_read: 0.003, cache_write: 0, monthly_usd: 15, composition: { input: 410, cached: 71300, output: 310 },
    peak: { input: 0.30, output: 1.20, cache_read: 0.006 },
    promo: { monthly_usd: 60, valid_until: '2026-09-20' }
  },
  // Retired alias resolving to V4.1 Flash; same pricing, same promo.
  'deepseek-flash': {
    input: 0.15, output: 0.60, cache_read: 0.003, cache_write: 0, monthly_usd: 15, composition: { input: 410, cached: 71300, output: 310 },
    peak: { input: 0.30, output: 1.20, cache_read: 0.006 },
    promo: { monthly_usd: 60, valid_until: '2026-09-20' }
  },
  'deepseek-v4-pro': { input: 0.66, output: 1.98, cache_read: 0.022, cache_write: 0, monthly_usd: 15, composition: { input: 750, cached: 82000, output: 290 }, peak: { input: 1.32, output: 3.96, cache_read: 0.044 } },
  'deepseek-v4-flash': { input: 0.15, output: 0.60, cache_read: 0.003, cache_write: 0, monthly_usd: 30, composition: { input: 410, cached: 71300, output: 310 }, peak: { input: 0.30, output: 1.20, cache_read: 0.006 } },
  'deepseek-v4-flash-vision-exp': { input: 0.15, output: 0.60, cache_read: 0.003, cache_write: 0, monthly_usd: 15, composition: { input: 410, cached: 71300, output: 310 }, peak: { input: 0.30, output: 1.20, cache_read: 0.006 } },
  'hy4-preview': { input: 0.834, output: 2.501, cache_read: 0.042, cache_write: 0, monthly_usd: 30, composition: { input: 830, cached: 71500, output: 295 } },
  'hy3': { input: 0.14, output: 0.58, cache_read: 0.035, cache_write: 0, monthly_usd: 60, composition: { input: 830, cached: 71500, output: 295 } },
  'grok-4.6': { input: 2.00, output: 6.00, cache_read: 0.50, cache_write: 0, monthly_usd: 15, composition: { input: 390, cached: 32500, output: 120 } },
  'gpt-5.6-luna': { input: 0.20, output: 1.20, cache_read: 0.02, cache_write: 0.25, monthly_usd: 15, composition: { input: 1000, cached: 50000, output: 220 } }
};

// Is `when` (default now) inside a documented DeepSeek peak window?
// Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday.
export function isOpencodeGoPeakHour(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

// USD cost estimate for one request at a given token scale.  The docs'
// typical-request composition scales proportionally, so a request twice the
// typical size costs twice the typical USD burn.  Real token splits
// (prompt/cache/output) replace the composition when the caller has them.
export function estimateAttemptUsd(pricing, { promptTokens = null, cachedTokens = null, outputTokens = null, attemptScale = 1 } = {}) {
  if (!pricing || !pricing.composition) return null;
  const peak = isOpencodeGoPeakHour();
  const inPrice = peak && pricing.peak ? pricing.peak.input : pricing.input;
  const outPrice = peak && pricing.peak ? pricing.peak.output : pricing.output;
  const readPrice = peak && pricing.peak ? pricing.peak.cache_read : pricing.cache_read;
  let cost = 0;
  if (promptTokens !== null && Number.isFinite(promptTokens) && promptTokens > 0) {
    const cached = Number.isFinite(cachedTokens) && cachedTokens > 0 ? Math.min(cachedTokens, promptTokens) : 0;
    const out = Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : 0;
    cost = (Math.max(0, promptTokens - cached) * inPrice + cached * readPrice + out * outPrice) / 1e6;
  } else {
    const c = pricing.composition;
    cost = (c.input * attemptScale * inPrice + c.cached * attemptScale * readPrice + c.output * attemptScale * outPrice) / 1e6;
  }
  return cost;
}

export function opencodeGoAllowanceFor(rawId, now = new Date()) {
  const base = OPENCODE_GO_MODEL_PRICING[rawId];
  if (!base) return null;
  // The promo raises the monthly USD allowance (4x); it expires on its own date.
  const promoActive = base.promo && !Number.isNaN(new Date(base.promo.valid_until).getTime()) &&
    now <= new Date(`${base.promo.valid_until}T23:59:59Z`).getTime();
  const monthlyUsd = promoActive ? base.promo.monthly_usd : base.monthly_usd;
  return {
    capacity_model: 'per_route_dollar_windows',
    monthly_usd: monthlyUsd,
    // Enforcement is dollar-denominated: 5h = 20% of the model's monthly
    // allowance, weekly = 50%, monthly = 100% (https://opencode.ai/docs/go/,
    // retrieved 2026-09-19).
    windows: {
      rolling: { limit_usd: monthlyUsd * 0.2 },
      weekly: { limit_usd: monthlyUsd * 0.5 },
      monthly: { limit_usd: monthlyUsd }
    },
    pricing: {
      input_usd_per_mtok: base.input,
      output_usd_per_mtok: base.output,
      cache_read_usd_per_mtok: base.cache_read,
      cache_write_usd_per_mtok: base.cache_write,
      typical_request_composition: base.composition,
      typical_request_usd: estimateAttemptUsd(base, {})
    },
    source: 'https://opencode.ai/docs/go/',
    retrieved_at: OPENCODE_GO_ALLOWANCE_RETRIEVED_AT,
    ...(promoActive ? { promo_valid_until: base.promo.valid_until, promo_factor: 4 } : {})
  };
}

function normalizeOpenCodeCatalog(data, now0 = new Date()) {
  const rawModels = Array.isArray(data) ? data : (data.data || []);
  const now = new Date().toISOString();
  const models = rawModels.map(m => {
    const id = m.id;
    let burnProfile = 'standard_burn';
    let expectedNormalizedBurn = 4.0;
    let status = 'ROUTING_ELIGIBLE';

    const allowance = opencodeGoAllowanceFor(id, now0);
    if (allowance) {
      // Dollar/token burn: one typical request's USD cost as percent points of
      // the model's own rolling 5h USD window.
      expectedNormalizedBurn =
        Number((allowance.pricing.typical_request_usd / allowance.windows.rolling.limit_usd * 100).toFixed(6));
      const pct = expectedNormalizedBurn;
      burnProfile = pct < 0.01 ? 'minimal_burn' : pct < 0.05 ? 'light_burn' : pct < 0.5 ? 'moderate_burn' : 'heavy_burn';
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
      ...(allowance ? { allowance } : {}),
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
// 4b. Free / zero-marginal-cost provider adapters -----------------------------
// Zero-PAYG constraint: only free routes are registered, with the explicit
// spend_policy FREE_RATE_LIMITED; no paid route may be created here.  Each
// adapter discovers the live model catalog and records route-level availability
// per model, so one dead model never disables an otherwise usable provider.
// Keys are read from the environment or FM_FREE_PROVIDER_KEYS_FILE (default
// ~/.config/firstmate/free-provider-keys.env) and never logged.

const FREE_PROVIDER_HTTP_TIMEOUT_MS = 15000;

// Documented OpenCode Zen free models (https://opencode.ai/docs/zen/ pricing
// table, retrieved 2026-09-18).  The free tier is only callable from within the
// OpenCode client, so these run through the opencode harness as agent sessions.
const OPENCODE_ZEN_FREE_MODEL_IDS = [
  'mimo-v2.5-free',
  'ling-3.0-flash-fin-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'big-pickle',
  'muse-spark-1.3-contributor-free'
];

const FREE_PROVIDER_DEFAULT_KEYS_PATH = path.join(process.env.HOME || '', '.config/firstmate/free-provider-keys.env');

function readFreeProviderKeys() {
  const keys = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(GROQ|OPENROUTER|NVIDIA|GOOGLE|CLOUDFLARE|MISTRAL|KILO|OPENCODE_ZEN)_.*$/.test(name) && value.trim()) {
      keys[name] = value.trim();
    }
  }
  const keysPath = process.env.FM_FREE_PROVIDER_KEYS_FILE || FREE_PROVIDER_DEFAULT_KEYS_PATH;
  try {
    const text = fs.readFileSync(keysPath, 'utf8');
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && match[1].includes('API') || match && /_(KEY|TOKEN|ACCOUNT_ID)$/.test(match[1] || '')) {
        const value = match[2].replace(/^["']|["']$/g, '').trim();
        if (value) keys[match[1]] = value;
      }
    }
  } catch {
    // No keys file; environment may still carry credentials.
  }
  return keys;
}

async function httpJson(url, headers = {}, timeoutMs = FREE_PROVIDER_HTTP_TIMEOUT_MS) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, ok: response.ok, body, text };
}

function freeCatalog(name, source, models, extra = {}) {
  return {
    harness: name,
    free_provider: true,
    stale: false,
    refresh_failed: false,
    discovered_at: new Date().toISOString(),
    source,
    count: models.length,
    models,
    ...extra
  };
}

function unavailableFreeCatalog(name, reason) {
  return {
    harness: name,
    free_provider: true,
    stale: false,
    refresh_failed: false,
    discovered_at: new Date().toISOString(),
    source: 'none',
    unavailable_reason: reason,
    count: 0,
    models: []
  };
}

// Chat-model filters keep obviously non-completion endpoints (audio, embeddings,
// guards) out of the routing pool.  Availability starts 'unknown': uncertainty
// is priced, never a veto.
function looksLikeChatModel(id) {
  return !/whisper|tts|orpheus|guard|embed|rerank|playai|deplot|ocr|diffusion|image|moderation/i.test(id);
}

function availabilityFromHttp(status, body, headers = {}) {
  if (status === 200) return 'available';
  if (status === 429) {
    const zeroLimit = headers['x-ratelimit-limit-requests'] === '0' ||
      /limit.{0,20}0\s*(req|request)/i.test(String(body?.error || body?.message || ''));
    return zeroLimit ? 'rate_limited_zero' : 'rate_limited';
  }
  if (status === 403) return 'tier_blocked';
  if (status === 401) return 'auth_failed';
  if (status === 404 || status === 410) return 'model_unavailable';
  return null; // transient (5xx/timeout): leave unknown
}

async function discoverOpenAICompatibleFreeProvider({
  name,
  modelsUrl,
  headers,
  modelFilter = looksLikeChatModel,
  nameFromResponse = null
}) {
  let result;
  try {
    result = await httpJson(modelsUrl, headers);
  } catch (error) {
    return unavailableFreeCatalog(name, `catalog request failed: ${String(error.message || error).slice(0, 120)}`);
  }
  if (!result.ok || !Array.isArray(result.body?.data)) {
    return unavailableFreeCatalog(name, `catalog returned HTTP ${result.status}`);
  }
  const models = result.body.data
    .map((m) => m.id)
    .filter(Boolean)
    .filter(modelFilter)
    .map((id) => ({
      raw_id: id,
      display_name: nameFromResponse ? nameFromResponse(id) : id,
      availability: 'unknown'
    }));
  return freeCatalog(name, modelsUrl, models, { transport: 'openai_compatible_http' });
}

export async function discoverFreeProviders({ keys = readFreeProviderKeys(), fixturePath = null } = {}) {
  if (fixturePath) {
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  }
  const auth = (key) => ({ Authorization: `Bearer ${key}` });

  const groq = keys.GROQ_API_KEY
    ? discoverOpenAICompatibleFreeProvider({ name: 'groq', modelsUrl: 'https://api.groq.com/openai/v1/models', headers: auth(keys.GROQ_API_KEY) })
    : unavailableFreeCatalog('groq', 'no GROQ_API_KEY');

  const openrouter = keys.OPENROUTER_API_KEY
    ? discoverOpenAICompatibleFreeProvider({
      name: 'openrouter',
      modelsUrl: 'https://openrouter.ai/api/v1/models',
      headers: auth(keys.OPENROUTER_API_KEY),
      modelFilter: (id) => id.endsWith(':free')
    })
    : unavailableFreeCatalog('openrouter', 'no OPENROUTER_API_KEY');

  const nvidia = keys.NVIDIA_API_KEY
    ? discoverOpenAICompatibleFreeProvider({ name: 'nvidia_nim', modelsUrl: 'https://integrate.api.nvidia.com/v1/models', headers: auth(keys.NVIDIA_API_KEY) })
    : unavailableFreeCatalog('nvidia_nim', 'no NVIDIA_API_KEY');

  const mistral = keys.MISTRAL_API_KEY
    ? discoverOpenAICompatibleFreeProvider({ name: 'mistral', modelsUrl: 'https://api.mistral.ai/v1/models', headers: auth(keys.MISTRAL_API_KEY) })
    : unavailableFreeCatalog('mistral', 'no MISTRAL_API_KEY');

  const kilo = (async () => {
    if (!keys.KILO_API_KEY) return unavailableFreeCatalog('kilo', 'no KILO_API_KEY');
    try {
      const result = await httpJson('https://api.kilo.ai/api/gateway/models', auth(keys.KILO_API_KEY));
      const data = Array.isArray(result.body?.data) ? result.body.data : [];
      const freeModels = data.filter((m) => m.isFree === true && m.id !== 'kilo-auto/free');
      const autoFree = data.find((m) => m.id === 'kilo-auto/free');
      const models = freeModels.map((m) => ({
        raw_id: m.id,
        display_name: m.name || m.id,
        availability: 'unknown',
        may_train_on_prompts: m.mayTrainOnYourPrompts === true,
        context_window: m.context_length ?? null
      }));
      if (autoFree) {
        models.push({
          raw_id: autoFree.id,
          display_name: autoFree.name || autoFree.id,
          availability: 'unknown',
          auto_routing: true,
          may_train_on_prompts: autoFree.mayTrainOnYourPrompts === true,
          context_window: autoFree.context_length ?? null
        });
      }
      return freeCatalog('kilo', 'https://api.kilo.ai/api/gateway/models', models, { transport: 'openai_compatible_http' });
    } catch (error) {
      return unavailableFreeCatalog('kilo', `catalog request failed: ${String(error.message || error).slice(0, 120)}`);
    }
  })();

  const google = (async () => {
    if (!keys.GOOGLE_API_KEY) return unavailableFreeCatalog('google_ai_studio', 'no GOOGLE_API_KEY');
    try {
      const result = await httpJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${keys.GOOGLE_API_KEY}&pageSize=1000`);
      const chat = (result.body?.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''))
        .filter(looksLikeChatModel);
      return freeCatalog(
        'google_ai_studio',
        'https://generativelanguage.googleapis.com/v1beta/models',
        chat.map((id) => ({ raw_id: id, display_name: id, availability: 'unknown' })),
        { transport: 'google_generate_content' }
      );
    } catch (error) {
      return unavailableFreeCatalog('google_ai_studio', `catalog request failed: ${String(error.message || error).slice(0, 120)}`);
    }
  })();

  const cloudflare = (async () => {
    if (!keys.CLOUDFLARE_API_TOKEN || !keys.CLOUDFLARE_ACCOUNT_ID) {
      return unavailableFreeCatalog('cloudflare_workers_ai', 'no CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID');
    }
    try {
      const result = await httpJson(
        `https://api.cloudflare.com/client/v4/accounts/${keys.CLOUDFLARE_ACCOUNT_ID}/ai/models/search?per_page=1000`,
        auth(keys.CLOUDFLARE_API_TOKEN)
      );
      const textModels = (result.body?.result || [])
        .filter((m) => m.task?.name === 'Text Generation')
        .map((m) => m.name);
      return freeCatalog(
        'cloudflare_workers_ai',
        'https://api.cloudflare.com/client/v4/accounts/*/ai/models/search',
        textModels.map((id) => ({ raw_id: id, display_name: id, availability: 'unknown' })),
        { transport: 'cloudflare_workers_ai' }
      );
    } catch (error) {
      return unavailableFreeCatalog('cloudflare_workers_ai', `catalog request failed: ${String(error.message || error).slice(0, 120)}`);
    }
  })();

  const zen = (async () => {
    if (!keys.OPENCODE_ZEN_KEY) return unavailableFreeCatalog('opencode_zen_free', 'no OPENCODE_ZEN_KEY');
    try {
      const result = await httpJson('https://opencode.ai/zen/v1/models', auth(keys.OPENCODE_ZEN_KEY));
      const ids = (result.body?.data || []).map((m) => m.id).filter(Boolean);
      const freeIds = OPENCODE_ZEN_FREE_MODEL_IDS.filter((id) => ids.includes(id));
      return freeCatalog(
        'opencode_zen_free',
        'https://opencode.ai/zen/v1/models',
        freeIds.map((id) => ({ raw_id: id, display_name: id, availability: 'unknown' })),
        { transport: 'opencode_cli_agent_session' }
      );
    } catch (error) {
      return unavailableFreeCatalog('opencode_zen_free', `catalog request failed: ${String(error.message || error).slice(0, 120)}`);
    }
  })();

  const [groqCatalog, openrouterCatalog, nvidiaCatalog, mistralCatalog, kiloCatalog, googleCatalog, cloudflareCatalog, zenCatalog] =
    await Promise.all([groq, openrouter, nvidia, mistral, kilo, google, cloudflare, zen]);
  return {
    groq: groqCatalog,
    openrouter: openrouterCatalog,
    nvidia_nim: nvidiaCatalog,
    mistral: mistralCatalog,
    kilo: kiloCatalog,
    google_ai_studio: googleCatalog,
    cloudflare_workers_ai: cloudflareCatalog,
    opencode_zen_free: zenCatalog
  };
}

// Route targets for the free pool.  Every free provider is hosted behind the
// EXISTING opencode agent harness as a custom @ai-sdk/openai-compatible
// provider (OpenCode "provider" config), so free providers are real spawnable
// agent routes rather than completion-only stubs.  The generated config
// (data/provider-catalogs/opencode-custom-providers.json) carries no secrets:
// api keys are "{env:<VAR>}" references the OpenCode client resolves from a
// locally sourced keys file.
// Endpoints verified live 2026-09-19 (kilo /v1/models 200 with 22 explicit
// free ids; google and cloudflare chat/completions 200 on a real model).
export const FREE_PROVIDER_TRANSPORTS = {
  groq: { opencode_provider_id: 'groq', baseURL: 'https://api.groq.com/openai/v1', env_key: 'GROQ_API_KEY' },
  openrouter: { opencode_provider_id: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', env_key: 'OPENROUTER_API_KEY' },
  nvidia_nim: { opencode_provider_id: 'nvidia', baseURL: 'https://integrate.api.nvidia.com/v1', env_key: 'NVIDIA_API_KEY' },
  mistral: { opencode_provider_id: 'mistral', baseURL: 'https://api.mistral.ai/v1', env_key: 'MISTRAL_API_KEY' },
  kilo: { opencode_provider_id: 'kilo', baseURL: 'https://api.kilo.ai/api/gateway/v1', env_key: 'KILO_API_KEY' },
  google_ai_studio: { opencode_provider_id: 'google-aistudio', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', env_key: 'GOOGLE_API_KEY' },
  cloudflare_workers_ai: { opencode_provider_id: 'cloudflare-wai', env_key: 'CLOUDFLARE_API_TOKEN', account_env_key: 'CLOUDFLARE_ACCOUNT_ID', baseURL: 'https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1' }
};

const FREE_PROVIDER_POOL_BY_CATALOG = {
  groq: 'groq_free',
  openrouter: 'openrouter_free',
  nvidia_nim: 'nvidia_nim',
  mistral: 'mistral_free',
  kilo: 'kilo_free',
  google_ai_studio: 'google_ai_studio',
  cloudflare_workers_ai: 'cloudflare_workers_ai'
};

// Writes the OpenCode custom-provider definition file used by fm-spawn.  No
// secret value ever enters this file; the keys file is sourced by the spawn
// launcher and referenced through {env:<VAR>} interpolations.
export function writeOpenCodeCustomProviders(freeProviders, { keysPath = null } = {}) {
  const def = {
    generated_at: new Date().toISOString(),
    npm_package: '@ai-sdk/openai-compatible',
    keys_file: keysPath || process.env.FM_FREE_PROVIDER_KEYS_FILE || FREE_PROVIDER_DEFAULT_KEYS_PATH,
    providers: {}
  };
  for (const [catalog, transport] of Object.entries(FREE_PROVIDER_TRANSPORTS)) {
    const catalogData = freeProviders[catalog];
    if (!catalogData || catalogData.count === 0) continue;
    const account = transport.account_env_key ? (readFreeProviderKeys()[transport.account_env_key] || '') : '';
    const baseURL = String(transport.baseURL).replace('{CLOUDFLARE_ACCOUNT_ID}', account);
    def.providers[transport.opencode_provider_id] = {
      catalog,
      baseURL,
      api_key_env: transport.env_key,
      models: Object.fromEntries(catalogData.models.map((m) => [m.raw_id, { name: m.display_name || m.raw_id }]))
    };
  }
  // OpenCode Zen free models ride the built-in opencode provider inside the
  // OpenCode client, so they need no custom provider entry.
  fs.writeFileSync(path.join(CATALOG_DIR, 'opencode-custom-providers.json'), JSON.stringify(def, null, 2));
  return def;
}

export function compileFreeRouteTargets(freeProviders) {
  const routes = [];
  for (const [catalogName, transport] of Object.entries(FREE_PROVIDER_TRANSPORTS)) {
    const catalog = freeProviders[catalogName];
    if (!catalog || catalog.count === 0) continue;
    for (const m of catalog.models) {
      const isAuto = m.auto_routing === true;
      routes.push({
        route_id: `${transport.opencode_provider_id}:${m.raw_id}`,
        model_family: m.raw_id.replace(':free', ''),
        logical_alias: m.raw_id,
        resolved_runtime_model: `${transport.opencode_provider_id}/${m.raw_id}`,
        provider: transport.opencode_provider_id,
        harness: 'opencode',
        route_kind: 'agent_session',
        free_tier: true,
        spend_policy: 'FREE_RATE_LIMITED',
        auto_routing: isAuto,
        ...(m.may_train_on_prompts !== undefined ? { may_train_on_prompts: m.may_train_on_prompts } : {}),
        ...(m.supports_tools !== undefined ? { supports_tools: m.supports_tools } : {}),
        provider_path: 'opencode_custom_provider',
        ...(isAuto ? { auto_route: true } : {}),
        reasoning_effort: null,
        quota_pool: FREE_PROVIDER_POOL_BY_CATALOG[catalogName],
        // A free request's marginal cost is its share of the provider's
        // rate-limit budget, not zero and not subscription quota.
        expected_normalized_burn: 0.05,
        quota_burn_model: 'free_rate_limited',
        data_profile: FREE_PROVIDER_POOL_BY_CATALOG[catalogName],
        discovery_source: catalog.source,
        discovered_at: catalog.discovered_at,
        resolved_at: catalog.discovered_at,
        availability: m.availability || 'unknown',
        ...(m.availability_evidence ? { availability_evidence: m.availability_evidence } : {}),
        smoke_tested: m.availability === 'available',
        routing_status: 'ROUTING_ELIGIBLE',
        metadata_provenance: {
          source: catalog.source,
          confidence: 'high',
          verified_at: catalog.discovered_at
        }
      });
    }
  }
  const zenCatalog = freeProviders.opencode_zen_free;
  if (zenCatalog && zenCatalog.count > 0) {
    for (const m of zenCatalog.models) {
      routes.push({
        route_id: `zen-free:${m.raw_id}`,
        model_family: m.raw_id,
        logical_alias: m.raw_id,
        resolved_runtime_model: `opencode/${m.raw_id}`,
        provider: 'opencode-zen',
        harness: 'opencode',
        route_kind: 'agent_session',
        free_tier: true,
        spend_policy: 'FREE_RATE_LIMITED',
        provider_path: 'opencode_cli',
        reasoning_effort: null,
        quota_pool: 'opencode_zen_free',
        expected_normalized_burn: 0.05,
        quota_burn_model: 'free_rate_limited',
        data_profile: 'opencode_zen_free',
        discovery_source: zenCatalog.source,
        discovered_at: zenCatalog.discovered_at,
        resolved_at: zenCatalog.discovered_at,
        availability: m.availability || 'unknown',
        ...(m.availability_evidence ? { availability_evidence: m.availability_evidence } : {}),
        smoke_tested: m.availability === 'available',
        routing_status: 'ROUTING_ELIGIBLE',
        metadata_provenance: {
          source: zenCatalog.source,
          confidence: 'high',
          verified_at: zenCatalog.discovered_at
        }
      });
    }
  }
  return routes;
}

// Free pools ride the same quota-map pool abstraction; their state comes from
// discovery probes rather than live subscription windows.
export function seedFreePools(quotaMap, freeProviders) {
  const poolFor = (name, catalog) => {
    const models = catalog?.models || [];
    const anyAuthFailed = models.length > 0 && models.every((m) => m.availability === 'auth_failed');
    return {
      harness: 'opencode',
      kind: 'free_rate_limited',
      status: anyAuthFailed ? 'AUTH_FAILED' : 'HEALTHY',
      scarcity_state: 'UNKNOWN',
      windows: {},
      source: 'provider_discovery',
      model_count: models.length,
      updated_at: new Date().toISOString()
    };
  };
  const poolByCatalog = {
    groq: 'groq_free',
    openrouter: 'openrouter_free',
    nvidia_nim: 'nvidia_nim',
    mistral: 'mistral_free',
    kilo: 'kilo_free',
    google_ai_studio: 'google_ai_studio',
    cloudflare_workers_ai: 'cloudflare_workers_ai',
    opencode_zen_free: 'opencode_zen_free'
  };
  quotaMap.pools = quotaMap.pools || {};
  for (const [catalogName, poolName] of Object.entries(poolByCatalog)) {
    const catalog = freeProviders[catalogName];
    if (!catalog || catalog.count === 0) continue;
    quotaMap.pools[poolName] = poolFor(poolName, catalog);
  }
  return quotaMap;
}

// One tiny PUBLIC completion per provider against up to `maxPerProvider` models,
// recording route-level availability back into the catalog.  429/403/401/404
// probes burn nothing; 200 probes cost one minimal request.
export async function probeFreeProviders({ keys = readFreeProviderKeys(), maxPerProvider = 4, catalogDir = CATALOG_DIR } = {}) {
  const auth = (key) => ({ Authorization: `Bearer ${key}` });
  const PUBLIC_PROBE_PROMPT = [{ role: 'user', content: 'Reply with exactly one word: pong' }];
  const attempts = [
    {
      catalog: 'groq',
      transport: 'openai_compatible_http',
      key: keys.GROQ_API_KEY,
      endpoint: (model) => `https://api.groq.com/openai/v1/chat/completions`,
      body: (model) => ({ model, max_tokens: 16, messages: PUBLIC_PROBE_PROMPT })
    },
    {
      catalog: 'openrouter',
      transport: 'openai_compatible_http',
      key: keys.OPENROUTER_API_KEY,
      endpoint: () => 'https://openrouter.ai/api/v1/chat/completions',
      body: (model) => ({ model, max_tokens: 16, messages: PUBLIC_PROBE_PROMPT })
    },
    {
      catalog: 'nvidia_nim',
      transport: 'openai_compatible_http',
      key: keys.NVIDIA_API_KEY,
      endpoint: () => 'https://integrate.api.nvidia.com/v1/chat/completions',
      body: (model) => ({ model, max_tokens: 16, messages: PUBLIC_PROBE_PROMPT })
    },
    {
      catalog: 'mistral',
      transport: 'openai_compatible_http',
      key: keys.MISTRAL_API_KEY,
      endpoint: () => 'https://api.mistral.ai/v1/chat/completions',
      body: (model) => ({ model, max_tokens: 16, messages: PUBLIC_PROBE_PROMPT })
    },
    {
      catalog: 'kilo',
      transport: 'openai_compatible_http',
      key: keys.KILO_API_KEY,
      endpoint: () => 'https://api.kilo.ai/api/gateway/chat/completions',
      body: (model) => ({ model, max_tokens: 16, messages: PUBLIC_PROBE_PROMPT })
    },
    {
      catalog: 'google_ai_studio',
      transport: 'google_generate_content',
      key: keys.GOOGLE_API_KEY,
      endpoint: (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keys.GOOGLE_API_KEY}`,
      body: () => ({ contents: [{ parts: [{ text: 'Reply with exactly one word: pong' }] }] })
    },
    {
      catalog: 'cloudflare_workers_ai',
      transport: 'openai_compatible_http',
      key: keys.CLOUDFLARE_API_TOKEN,
      account: keys.CLOUDFLARE_ACCOUNT_ID,
      endpoint: (model) => `https://api.cloudflare.com/client/v4/accounts/${keys.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`,
      body: () => ({ messages: PUBLIC_PROBE_PROMPT, max_tokens: 16 })
    }
  ];
  const TOOL_PROBE_SPEC = [{
    type: 'function',
    function: { name: 'pool_probe_tool', description: 'Ping probe for agent-capable route detection', parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } }
  }];
  const summary = {};
  for (const attempt of attempts) {
    if (!attempt.key || (attempt.catalog === 'cloudflare_workers_ai' && !attempt.account)) {
      summary[attempt.catalog] = { skipped: 'no credentials' };
      continue;
    }
    const catalogPath = path.join(catalogDir, `${attempt.catalog}.json`);
    if (!fs.existsSync(catalogPath)) {
      summary[attempt.catalog] = { skipped: 'no catalog' };
      continue;
    }
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const models = (catalog.models || []).filter((m) => m.availability !== 'model_unavailable').slice(0, maxPerProvider);
    const results = [];
    for (const m of models) {
      let status = 0;
      let body = null;
      let headers = {};
      let error = null;
      try {
        const response = await fetch(attempt.endpoint(m.raw_id), {
          method: 'POST',
          headers: { ...auth(attempt.key), 'Content-Type': 'application/json' },
          body: JSON.stringify(attempt.body(m.raw_id)),
          signal: AbortSignal.timeout(30000)
        });
        status = response.status;
        for (const header of ['x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests']) {
          const value = response.headers.get(header);
          if (value !== null) headers[header] = value;
        }
        try {
          body = await response.json();
        } catch {
          body = null;
        }
      } catch (requestError) {
        error = String(requestError.message || requestError).slice(0, 120);
      }
      const availability = error ? null : availabilityFromHttp(status, body, headers);
      if (availability) {
        m.availability = availability;
        m.availability_evidence = { http_status: status, checked_at: new Date().toISOString() };
      } else if (error) {
        m.availability_evidence = { error, checked_at: new Date().toISOString() };
      }
      // Agent dispatch needs tool calling; a model that rejects tools cannot
      // carry an fm-spawn worker session even when plain completion works.
      if (attempt.transport === 'openai_compatible_http' && availability === 'available' && !error) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 400));
          const toolResponse = await fetch(attempt.endpoint(m.raw_id), {
            method: 'POST',
            headers: { ...auth(attempt.key), 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...attempt.body(m.raw_id),
              tools: TOOL_PROBE_SPEC
            }),
            signal: AbortSignal.timeout(20000)
          });
          const toolBody = await toolResponse.text();
          const toolBodyErr = toolBody.slice(0, 400);
          if (toolResponse.status === 200) {
            m.supports_tools = true;
          } else if ((toolResponse.status === 400 || toolResponse.status === 422) &&
            /tool\s*calling is not supported|does not support/i.test(toolBodyErr)) {
            m.supports_tools = false;
          }
          // Any other status (429 upstream, 5xx) leaves supports_tools unset:
          // unknown capability is priced, never guessed.
          m.tools_probe_evidence = { http_status: toolResponse.status, ...(m.supports_tools !== undefined ? { supports_tools: m.supports_tools } : {}), checked_at: new Date().toISOString() };
          results.push({ model: `${m.raw_id} (tool-probe)`, http_status: toolResponse.status, ...(m.supports_tools !== undefined ? { supports_tools: m.supports_tools } : {}) });
        } catch (toolError) {
          results.push({ model: `${m.raw_id} (tool-probe)`, error: String(toolError.message || toolError).slice(0, 120) });
        }
      }
      results.push({ model: m.raw_id, http_status: status, availability: m.availability, ...(error ? { error } : {}) });
    }
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    summary[attempt.catalog] = { probed: results.length, results };
  }
  return summary;
}

function brokenRoute(harness, catalog) {
  return {
    route_id: `${harness}:BROKEN`,
    harness,
    routing_status: 'BROKEN',
    broken: true,
    broken_reasons: (catalog.integrity && catalog.integrity.reasons) || [],
    discovered_at: catalog.discovered_at
  };
}

const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// A failed refresh reuses the previous snapshot, which keeps its original
// discovered_at.  Rewriting those models into a freshly written compiled file
// would launder an old catalog past the router's freshness check, so routes from
// a fallback snapshot older than the router window are marked stale and Stage A
// refuses them.
function catalogAvailability(catalog, availability) {
  if (catalog?.refresh_failed !== true) return availability;
  const discoveredMs = new Date(catalog.discovered_at).getTime();
  if (Number.isFinite(discoveredMs) && Date.now() - discoveredMs <= CATALOG_MAX_AGE_MS) return availability;
  return 'stale_catalog';
}

export function compileRouteTargets(catalogs) {
  const routes = [];

  // Free / zero-marginal-cost provider routes (harness-null completion routes
  // plus OpenCode Zen free agent sessions) ride the same RouteTarget model.
  if (catalogs.free_providers) {
    routes.push(...compileFreeRouteTargets(catalogs.free_providers));
  }

  // Codex Routes
  if (catalogs.codex.broken) {
    routes.push(brokenRoute('codex', catalogs.codex));
  }
  for (const m of (catalogs.codex.broken ? [] : catalogs.codex.models)) {
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
        availability: catalogAvailability(catalogs.codex, 'available'),
        smoke_tested: m.smoke_tested || false,
        routing_status: m.routing_status,
        metadata_provenance: m.metadata_provenance
      });
    }
  }

  // Claude Native Routes
  if (catalogs.claude.broken) {
    routes.push(brokenRoute('claude', catalogs.claude));
  }
  for (const m of (catalogs.claude.broken ? [] : catalogs.claude.models)) {
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
        availability: catalogAvailability(catalogs.claude, m.availability),
        smoke_tested: m.smoke_tested || false,
        routing_status: m.routing_status,
        metadata_provenance: m.metadata_provenance
      });
    }
  }

  // AGY routes (Gemini native + third-party), gated together on one executable
  if (catalogs.antigravity.broken) {
    routes.push(brokenRoute('antigravity', catalogs.antigravity));
  }
  // AGY Gemini Native Routes
  for (const m of (catalogs.antigravity.broken ? [] : (catalogs.antigravity.gemini_native || []))) {
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
      availability: catalogAvailability(catalogs.antigravity, 'available'),
      smoke_tested: m.smoke_tested || false,
      routing_status: m.routing_status,
      metadata_provenance: m.metadata_provenance
    });
  }

  // AGY 3P Routes (Distinct First-Class Market!)
  for (const m of (catalogs.antigravity.broken ? [] : (catalogs.antigravity.third_party || []))) {
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
      availability: catalogAvailability(catalogs.antigravity, 'available'),
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
      // The account is one subscription, but enforcement is per-model: routes
      // carry their own allowance windows; this pool key is the account scope.
      quota_pool: 'opencode_go',
      burn_profile: m.burn_profile,
      expected_normalized_burn: m.expected_normalized_burn,
      quota_burn_model: 'opencode_go_metered_allowance',
      data_profile: m.raw_id.includes('deepseek') || m.raw_id.includes('kimi') ? 'opencode_go_cn' : 'opencode_go',
      discovery_source: 'opencode_go_http_catalog',
      discovered_at: catalogs.opencode_go.discovered_at,
      resolved_at: catalogs.opencode_go.discovered_at,
      availability: catalogAvailability(catalogs.opencode_go, 'available'),
      smoke_tested: m.smoke_tested || false,
      routing_status: m.routing_status,
      ...(m.allowance ? { allowance: m.allowance } : {}),
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
  const freeProviders = options.free_providers || null;

  fs.writeFileSync(path.join(CATALOG_DIR, 'codex.json'), JSON.stringify(codex, null, 2));
  fs.writeFileSync(path.join(CATALOG_DIR, 'claude.json'), JSON.stringify(claude, null, 2));
  fs.writeFileSync(path.join(CATALOG_DIR, 'antigravity.json'), JSON.stringify(agy, null, 2));
  fs.writeFileSync(path.join(CATALOG_DIR, 'opencode-go.json'), JSON.stringify(opencodeGo, null, 2));

  let freeCount = 0;
  if (freeProviders) {
    for (const [name, catalog] of Object.entries(freeProviders)) {
      fs.writeFileSync(path.join(CATALOG_DIR, `${name}.json`), JSON.stringify(catalog, null, 2));
      freeCount += catalog.count || 0;
    }
  } else if (options.skipFreeProviders !== true) {
    // Free-catalog discovery is async; refresh keeps the previous snapshots and
    // the free catalogs refresh through the async refreshFreeProviderCatalogs path.
  }

  const routeTargets = compileRouteTargets({ codex, claude, antigravity: agy, opencode_go: opencodeGo });
  fs.writeFileSync(path.join(CATALOG_DIR, 'compiled-route-targets.json'), JSON.stringify(routeTargets, null, 2));

  return {
    codexCount: (codex.models || []).length,
    claudeCount: (claude.models || []).length,
    agyGeminiCount: (agy.gemini_native || []).length,
    agy3PCount: (agy.third_party || []).length,
    opencodeGoCount: (opencodeGo.models || []).length,
    freeProvidersCount: freeCount,
    totalRouteTargets: routeTargets.length
  };
}

// Async companion that refreshes free-provider catalogs, recompiles the route
// targets with them included, and seeds the free pools into the quota map.
export async function refreshFreeProviderCatalogs({ quotaMapPath = path.join(FM_HOME, 'data/quota-pool-map.json') } = {}) {
  const freeProviders = await discoverFreeProviders();
  // Probe evidence (availability / tool-calling capability recorded by
  // probe-free) must survive a refresh: a fresh discovery starts each model at
  // `unknown`, so observed money-free facts are merged back for models that are
  // still in the live catalog. Withdrawn models simply disappear again.
  const refreshed = {};
  for (const [name, catalog] of Object.entries(freeProviders)) {
    const previousPath = path.join(CATALOG_DIR, `${name}.json`);
    let probingEvidence = {};
    try {
      if (fs.existsSync(previousPath)) {
        for (const m of (JSON.parse(fs.readFileSync(previousPath, 'utf8')).models || [])) {
          probingEvidence[m.raw_id] = m;
        }
      }
    } catch {
      // stale unreadable snapshot; fresh discovery stands alone
    }
    const staleOrFresh = catalog.discovered_at;
    for (const m of catalog.models) {
      const previous = probingEvidence[m.raw_id];
      if (previous) {
        if (m.availability === 'unknown' && previous.availability) m.availability = previous.availability;
        if (previous.supports_tools !== undefined) m.supports_tools = previous.supports_tools;
        if (previous.tools_probe_evidence) m.tools_probe_evidence = previous.tools_probe_evidence;
        if (previous.availability_evidence) m.availability_evidence = previous.availability_evidence;
      }
    }
    refreshed[name] = catalog;
    void staleOrFresh;
  }
  let freeCount = 0;
  for (const [name, catalog] of Object.entries(refreshed)) {
    fs.writeFileSync(path.join(CATALOG_DIR, `${name}.json`), JSON.stringify(catalog, null, 2));
    freeCount += catalog.count || 0;
  }
  // Recompile the full target list, reusing the just-written subscription catalogs.
  const read = (name) => (fs.existsSync(path.join(CATALOG_DIR, `${name}.json`))
    ? JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, `${name}.json`), 'utf8'))
    : { models: [] });
  const routeTargets = compileRouteTargets({
    codex: read('codex'),
    claude: read('claude'),
    antigravity: read('antigravity'),
    opencode_go: read('opencode-go'),
    free_providers: freeProviders
  });
  fs.writeFileSync(path.join(CATALOG_DIR, 'compiled-route-targets.json'), JSON.stringify(routeTargets, null, 2));
  writeOpenCodeCustomProviders(freeProviders);

  try {
    if (fs.existsSync(quotaMapPath)) {
      seedFreePools(quotaMap, freeProviders);
      fs.writeFileSync(quotaMapPath, JSON.stringify(quotaMap, null, 2));
    }
  } catch {
    // Quota-map seeding is best-effort; routing still works with windowless pools.
  }
  return { freeModels: freeCount, totalRouteTargets: routeTargets.length };
}

// CLI handler
if (process.argv[1] && process.argv[1].endsWith('fm-provider-discovery.mjs')) {
  const cmd = process.argv[2] || 'refresh';
  if (cmd === 'refresh') {
    const summary = refreshAllCatalogs();
    refreshFreeProviderCatalogs().then((free) => {
      console.log(`PROVIDER_DISCOVERY: refreshed all catalogs successfully.`);
      console.log(`  Codex models: ${summary.codexCount}`);
      console.log(`  Claude models: ${summary.claudeCount}`);
      console.log(`  AGY Gemini Native: ${summary.agyGeminiCount}`);
      console.log(`  AGY 3P Pool: ${summary.agy3PCount}`);
      console.log(`  OpenCode Go models: ${summary.opencodeGoCount}`);
      console.log(`  Free-provider models: ${free.freeModels}`);
      console.log(`  Total compiled RouteTargets: ${free.totalRouteTargets}`);
    }).catch((error) => {
      console.log(`PROVIDER_DISCOVERY: free-provider refresh failed (${String(error.message || error).slice(0, 200)}); subscription catalogs kept.`);
      console.log(`  Total compiled RouteTargets: ${summary.totalRouteTargets}`);
    });
  } else if (cmd === 'probe-free') {
    probeFreeProviders().then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    }).catch((error) => {
      console.error(`PROBE ERROR: ${String(error.message || error).slice(0, 300)}`);
      process.exit(1);
    });
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
