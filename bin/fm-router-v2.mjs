#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeQuotaAxiSnapshot } from './fm-quota-normalize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const currentFmHome = () => path.resolve(process.env.FM_HOME || ROOT);
const homePath = (relPath) => path.join(currentFmHome(), relPath);
const getExecutionsLogPath = () => homePath('data/routing-executions.jsonl');

const OPENCODE_QUOTA_SCRIPT_PATH = path.join(ROOT, 'bin', 'fm-opencode-quota.mjs');

function setPoolWindowsFresh(pool, fresh) {
  Object.defineProperty(pool, '_windows_fresh', {
    configurable: true,
    enumerable: false,
    value: fresh,
    writable: true
  });
}

function poolWindowsFresh(pool) {
  return pool?._windows_fresh !== false;
}

function readOpenCodeGoQuota() {
  const scriptPath = process.env.FM_OPENCODE_QUOTA_SCRIPT || OPENCODE_QUOTA_SCRIPT_PATH;
  const output = execFileSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10000,
    env: { ...process.env, FM_HOME: currentFmHome() }
  });
  const quota = JSON.parse(output);
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) {
    throw new Error('OpenCode Go quota output must be an object');
  }
  return quota;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid at ${filePath}: ${error.message}`);
  }
}

function generatedStateFresh(filePath, value) {
  if (value?.fixture === 'synthetic-router-v2') return true;
  try {
    const ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
    return ageMs >= 0 && ageMs <= 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

const PRIVACY_METADATA_DEFAULT_MAX_AGE_DAYS = 30;
const ACTIVE_DATA_CLASSES = new Set(['PUBLIC', 'SANITIZED', 'PRIVATE_CODE', 'PERSONAL_SENSITIVE', 'SECRET']);

function normalizeTelemetryClassification(dataClass, classificationStatus = null) {
  if (dataClass === null || dataClass === undefined || dataClass === '' || dataClass === 'LEGACY_UNCLASSIFIED') {
    return {
      dataClass: null,
      classificationStatus: classificationStatus || 'UNCLASSIFIED_LEGACY'
    };
  }
  if (!ACTIVE_DATA_CLASSES.has(dataClass)) {
    throw new Error(`Unknown telemetry data class: ${dataClass}`);
  }
  return {
    dataClass,
    classificationStatus: classificationStatus || 'CLASSIFIED'
  };
}

// Route-owner privacy metadata is hand-verified documentation evidence, not generated telemetry,
// so it uses its own longer revalidation cadence instead of generatedStateFresh's 24h window.
// A provider-published valid_until always wins; otherwise the file's own revalidation_cadence_days
// (or the default above) bounds how long a retrieved_at timestamp may be trusted.
function isPrivacyMetadataStale(privacyMetadata, entry) {
  if (privacyMetadata?.fixture === 'synthetic-router-v2') return false;
  if (!entry) return true;
  if (entry.valid_until) {
    const validUntilMs = new Date(entry.valid_until).getTime();
    if (!Number.isNaN(validUntilMs)) return Date.now() > validUntilMs;
  }
  const retrievedAtMs = entry.retrieved_at ? new Date(entry.retrieved_at).getTime() : NaN;
  if (Number.isNaN(retrievedAtMs)) return true;
  const cadenceDays = privacyMetadata?.revalidation_cadence_days || PRIVACY_METADATA_DEFAULT_MAX_AGE_DAYS;
  return (Date.now() - retrievedAtMs) > cadenceDays * 24 * 60 * 60 * 1000;
}

function unknownQuotaMap(quotaMap, reason) {
  return {
    ...quotaMap,
    generated_state: { stale: true, reason },
    pools: Object.fromEntries(Object.keys(quotaMap.pools || {}).map((name) => [name, {
      ...(quotaMap.pools[name] || {}),
      scarcity_state: 'UNKNOWN',
      status: 'UNKNOWN'
    }]))
  };
}

export function loadConfigs() {
  const registryPath = homePath('config/model-registry.json');
  const policyPath = homePath('config/routing-policy.json');
  const priorsPath = homePath('config/routing-priors.json');
  const dataPolicyPath = homePath('config/data-policy.json');
  const privacyMetadataPath = homePath('config/provider-privacy-metadata.json');
  const quotaMapPath = homePath('data/quota-pool-map.json');
  const learnedRoutingPath = homePath('data/learned-routing.json');
  const compiledRoutesPath = homePath('data/provider-catalogs/compiled-route-targets.json');

  const registry = readJson(registryPath, 'model registry');
  const policy = readJson(policyPath, 'routing policy');
  const priors = readJson(priorsPath, 'routing priors');
  const dataPolicy = readJson(dataPolicyPath, 'data policy');
  const privacyMetadata = fs.existsSync(privacyMetadataPath)
    ? readJson(privacyMetadataPath, 'provider privacy metadata')
    : { models: {} };
  const quotaMapRaw = readJson(quotaMapPath, 'quota pool map');
  const quotaMap = generatedStateFresh(quotaMapPath, quotaMapRaw)
    ? quotaMapRaw
    : unknownQuotaMap(quotaMapRaw, 'quota pool map is stale');
  const learned = fs.existsSync(learnedRoutingPath)
    ? readJson(learnedRoutingPath, 'learned routing')
    : null;
  const compiledRoutes = fs.existsSync(compiledRoutesPath)
    ? (generatedStateFresh(compiledRoutesPath) ? readJson(compiledRoutesPath, 'compiled route targets') : [])
    : [];
  return { registry, policy, priors, dataPolicy, privacyMetadata, quotaMap, learned, compiledRoutes };
}

export function validateConfigs() {
  const { registry, policy, priors, dataPolicy } = loadConfigs();
  const canonicalRoles = new Set(registry.canonical_roles);

  // 1. Validate roles in model-registry
  for (const role of Object.keys(registry.roles)) {
    if (!canonicalRoles.has(role)) {
      throw new Error(`Unknown role in model-registry: "${role}"`);
    }
    const roleDef = registry.roles[role];
    if (!registry.models[roleDef.primary_champion]) {
      throw new Error(`Role "${role}" primary_champion "${roleDef.primary_champion}" not found in models`);
    }
    for (const ch of roleDef.challengers || []) {
      if (!registry.models[ch]) {
        throw new Error(`Role "${role}" challenger "${ch}" not found in models`);
      }
    }
  }

  // 2. Validate routing-policy canonical_roles
  for (const role of policy.canonical_roles) {
    if (!canonicalRoles.has(role)) {
      throw new Error(`Unknown canonical role in routing-policy: "${role}"`);
    }
  }

  // 3. Validate routing-priors recommended_roles
  for (const modelId of Object.keys(priors.priors)) {
    const prior = priors.priors[modelId];
    for (const role of prior.recommended_roles || []) {
      if (!canonicalRoles.has(role)) {
        throw new Error(`Prior "${modelId}" references unknown role: "${role}"`);
      }
    }
  }

  // 4. Validate data-policy absolute-exclusion rule
  if (!dataPolicy.data_classes.SECRET.fail_closed) {
    throw new Error('SECRET must have fail_closed: true');
  }

  return { valid: true, canonicalRolesCount: canonicalRoles.size, modelsCount: Object.keys(registry.models).length };
}

// dataClass classifies the actual payload being sent, never the repository or task it came from -
// a code-only task in a personal repo is PRIVATE_CODE (or PUBLIC/SANITIZED if genuinely generic),
// not PERSONAL_SENSITIVE by default. See docs/router-v2.md "Data classification" for the full rule.
export function evaluateDataGate(dataClass, targetProfileName, routeContext = {}) {
  const { dataPolicy, privacyMetadata } = loadConfigs();
  const dc = dataPolicy.data_classes[dataClass];
  if (!dc) throw new Error(`Unknown data class: ${dataClass}`);

  if (dataClass === 'SECRET') {
    return { allowed: false, reason: 'SECRET data is strictly excluded from all model context under any provider' };
  }

  const profile = dataPolicy.live_route_profiles[targetProfileName];
  if (!profile) throw new Error(`Unknown route profile: ${targetProfileName}`);

  if (!profile.allowed_data_classes.includes(dataClass)) {
    return { allowed: false, reason: `Data class ${dataClass} blocked on route profile ${targetProfileName}` };
  }

  // Multi-vendor pass-through gateways (e.g. opencode_go) cannot carry one blanket privacy claim
  // for every model behind them, so PERSONAL_SENSITIVE additionally requires real, current,
  // per-model route-owner privacy metadata rather than the profile's own coarse allow-list.
  if (profile.per_model_privacy_required && dataClass === 'PERSONAL_SENSITIVE') {
    const modelKey = routeContext.resolvedRuntimeModel || null;
    const meta = modelKey ? privacyMetadata?.models?.[modelKey] : null;
    if (!meta) {
      return {
        allowed: false,
        reason: `PERSONAL_SENSITIVE blocked on route profile ${targetProfileName}: no verified per-model privacy metadata for ${modelKey || '(unresolved model)'}`
      };
    }
    if (isPrivacyMetadataStale(privacyMetadata, meta)) {
      return {
        allowed: false,
        reason: `PERSONAL_SENSITIVE blocked: privacy metadata for ${modelKey} is stale (retrieved_at ${meta.retrieved_at || 'unknown'}) and needs revalidation before it can gate this data class`
      };
    }
    if (meta.training_use === 'used') {
      return {
        allowed: false,
        reason: `PERSONAL_SENSITIVE blocked: ${modelKey}'s route-owner policy permits training on prompts/completions (source: ${meta.source})`
      };
    }
    if ((meta.retention_days ?? 0) > 0) {
      return {
        allowed: false,
        reason: `PERSONAL_SENSITIVE blocked: ${modelKey} retains data for ${meta.retention_days} day(s) per route-owner policy (source: ${meta.source})`
      };
    }
  }

  return { allowed: true, reason: 'Data class permitted by profile policy' };
}

export function planContextShunting(rawTokenCount, taskComplexity) {
  const SHUNT_THRESHOLD = 50000;
  if (rawTokenCount > SHUNT_THRESHOLD) {
    return {
      shuntingRequired: true,
      bulkReaderRole: 'fast_context',
      bulkReaderModel: 'gemini-3.8-flash',
      codeWriterRole: taskComplexity === 'high' ? 'deep_engineer' : 'general_engineer',
      strategy: 'Bulk reader extracts high-density AST/diff brief; code writer receives target brief only',
      estimatedTokenSavingsPct: 88
    };
  }
  return {
    shuntingRequired: false,
    strategy: 'Direct context injection within normal bounds'
  };
}

// Capability index mapping canonical roles to model families / candidate slugs
export const CAPABILITY_INDEX = {
  fast_precise: ['gpt-5.6-luna', 'qwen3.8-flash', 'claude-haiku-4-5-20251001', 'deepseek-v4.1-flash', 'deepseek-v4-flash'],
  cheap_tool_worker: ['qwen3.8-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash', 'gpt-5.6-luna', 'muse-spark-1.3-contributor'],
  strong_cheap_worker: ['qwen3.7-max', 'qwen3.7-plus', 'muse-spark-1.3-contributor'],
  general_engineer: ['gpt-5.6-terra', 'qwen3.7-max', 'claude-sonnet-5', 'claude-sonnet-4-6'],
  fast_context: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'],
  deep_context: ['kimi-k3', 'kimi-k2.7-code', 'gemini-3.1-pro'],
  autonomous_engineer: ['claude-sonnet-5', 'claude-sonnet-4-6', 'gpt-5.6-terra'],
  deep_engineer: ['gpt-5.6-sol', 'claude-opus-5', 'claude-opus-4-6-thinking', 'qwen3.8-max'],
  architect_synthesizer: ['claude-opus-5', 'claude-opus-4-6-thinking', 'gpt-5.6-sol', 'claude-fable-5-1'],
  critical_auditor: ['claude-opus-5', 'gpt-5.6-sol']
};

export const ROLE_DEFAULT_EFFORT = {
  critical_auditor: 'high',
  architect_synthesizer: 'high',
  deep_engineer: 'high',
  deep_context: 'high',
  general_engineer: 'medium',
  autonomous_engineer: 'medium',
  strong_cheap_worker: 'medium',
  fast_context: 'low',
  fast_precise: 'low',
  cheap_tool_worker: 'low'
};

export function resolveLiveQuotaPools({ quotaOverrides = null, useLiveAxi = true } = {}) {
  const { quotaMap } = loadConfigs();
  const pools = JSON.parse(JSON.stringify(quotaMap.pools || {}));
  const initialWindowsFresh = quotaMap.generated_state?.stale !== true;
  for (const pool of Object.values(pools)) {
    setPoolWindowsFresh(pool, initialWindowsFresh);
  }

  const deriveScarcity = (pct) => {
    if (pct === null || pct === undefined || isNaN(pct)) return 'UNKNOWN';
    if (pct <= 0) return 'EXHAUSTED';
    if (pct <= 10) return 'CRITICAL';
    if (pct <= 25) return 'CONSERVE';
    if (pct <= 50) return 'NORMAL';
    return 'ABUNDANT';
  };

  if (useLiveAxi && process.env.FM_DISABLE_LIVE_QUOTA !== '1') {
    try {
      const axiOut = execFileSync('quota-axi', ['--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      });
      const data = normalizeQuotaAxiSnapshot(JSON.parse(axiOut));
      const providers = data.providers;

      for (const p of providers) {
        const name = p.provider;
        const pState = p.state || {};
        const isFresh = pState.status === 'fresh' || pState.status === 'cached' || (!pState.stale && pState.status !== 'auth_required' && pState.status !== 'error');
        const semantics = p.quotaSemantics || {};
        const isKnown = semantics.status === 'known';
        const effList = semantics.effectiveAvailability || [];

        const windowMap = {};
        for (const w of (p.windows || [])) {
          windowMap[w.id] = {
            percent_remaining: w.percentRemaining,
            reset_at: w.resetsAt
          };
          if (w.id === 'five_hour') windowMap['rolling_5h'] = windowMap[w.id];
        }

        if (name === 'codex') {
          if (pools.codex_plus) {
            if (isFresh && isKnown) {
              const item = effList.find(e => e.scope === 'all_models') || effList[0];
              const rem = item?.effectivePercentRemaining;
              pools.codex_plus.scarcity_state = deriveScarcity(rem);
              pools.codex_plus.status = pools.codex_plus.scarcity_state === 'EXHAUSTED' ? 'EXHAUSTED' : 'HEALTHY';
              pools.codex_plus.windows = { ...(pools.codex_plus.windows || {}), ...windowMap };
              setPoolWindowsFresh(pools.codex_plus, true);
            } else {
              pools.codex_plus.scarcity_state = 'UNKNOWN';
              pools.codex_plus.status = 'UNKNOWN';
              setPoolWindowsFresh(pools.codex_plus, false);
            }
          }
        } else if (name === 'claude') {
          if (pools.claude_pro) {
            if (isFresh && isKnown) {
              const item = effList.find(e => e.scope === 'all_models') || effList[0];
              const rem = item?.effectivePercentRemaining;
              pools.claude_pro.scarcity_state = deriveScarcity(rem);
              pools.claude_pro.status = pools.claude_pro.scarcity_state === 'EXHAUSTED' ? 'EXHAUSTED' : 'HEALTHY';
              pools.claude_pro.windows = { ...(pools.claude_pro.windows || {}), ...windowMap };
              setPoolWindowsFresh(pools.claude_pro, true);
            } else {
              pools.claude_pro.scarcity_state = 'UNKNOWN';
              pools.claude_pro.status = 'UNKNOWN';
              setPoolWindowsFresh(pools.claude_pro, false);
            }
          }
          if (pools.claude_pro_credits) {
            pools.claude_pro_credits.scarcity_state = 'UNKNOWN';
          }
        } else if (name === 'antigravity') {
          if (pools.antigravity_gemini) {
            if (isFresh && isKnown) {
              const geminiItem = effList.find(e => e.scope === 'gemini');
              const rem = geminiItem ? geminiItem.effectivePercentRemaining : null;
              pools.antigravity_gemini.scarcity_state = deriveScarcity(rem);
              pools.antigravity_gemini.status = pools.antigravity_gemini.scarcity_state === 'EXHAUSTED' ? 'EXHAUSTED' : 'HEALTHY';
              const geminiWindows = {};
              for (const [k, v] of Object.entries(windowMap)) {
                if (k.startsWith('gemini')) geminiWindows[k] = v;
              }
              pools.antigravity_gemini.windows = { ...(pools.antigravity_gemini.windows || {}), ...geminiWindows };
              setPoolWindowsFresh(pools.antigravity_gemini, true);
            } else {
              pools.antigravity_gemini.scarcity_state = 'UNKNOWN';
              pools.antigravity_gemini.status = 'UNKNOWN';
              setPoolWindowsFresh(pools.antigravity_gemini, false);
            }
          }
          if (pools.antigravity_3p) {
            if (isFresh && isKnown) {
              const p3Item = effList.find(e => e.scope === '3p');
              const rem = p3Item ? p3Item.effectivePercentRemaining : null;
              pools.antigravity_3p.scarcity_state = deriveScarcity(rem);
              pools.antigravity_3p.status = pools.antigravity_3p.scarcity_state === 'EXHAUSTED' ? 'EXHAUSTED' : 'HEALTHY';
              const p3Windows = {};
              for (const [k, v] of Object.entries(windowMap)) {
                if (k.startsWith('3p')) p3Windows[k] = v;
              }
              pools.antigravity_3p.windows = { ...(pools.antigravity_3p.windows || {}), ...p3Windows };
              setPoolWindowsFresh(pools.antigravity_3p, true);
            } else {
              pools.antigravity_3p.scarcity_state = 'UNKNOWN';
              pools.antigravity_3p.status = 'UNKNOWN';
              setPoolWindowsFresh(pools.antigravity_3p, false);
            }
          }
        }
      }
    } catch (err) {
      for (const k of Object.keys(pools)) {
        pools[k].scarcity_state = 'UNKNOWN';
        pools[k].status = 'UNKNOWN';
        setPoolWindowsFresh(pools[k], false);
      }
    }

    const openCodePool = pools.opencode_go;
    if (openCodePool) {
      try {
        const usage = readOpenCodeGoQuota();
        const windowNames = ['rolling_5h', 'weekly', 'monthly'];
        const hasFreshAuthoritativeWindows = usage.stale !== true &&
          usage.source === 'opencode_go_usage_api' &&
          windowNames.every((name) => Number.isFinite(usage[name]?.percent_remaining));

        if (hasFreshAuthoritativeWindows) {
          const windows = Object.fromEntries(windowNames.map((name) => [name, {
            percent_remaining: usage[name].percent_remaining,
            percent_used: usage[name].percent_used,
            reset_at: usage[name].reset_at
          }]));
          const remaining = Math.min(...windowNames.map((name) => usage[name].percent_remaining));
          openCodePool.windows = windows;
          openCodePool.scarcity_state = deriveScarcity(remaining);
          openCodePool.status = openCodePool.scarcity_state === 'EXHAUSTED' ? 'EXHAUSTED' : 'HEALTHY';
          setPoolWindowsFresh(openCodePool, true);
        } else {
          openCodePool.scarcity_state = 'UNKNOWN';
          openCodePool.status = 'UNKNOWN';
          setPoolWindowsFresh(openCodePool, false);
        }
      } catch (err) {
        openCodePool.scarcity_state = 'UNKNOWN';
        openCodePool.status = 'UNKNOWN';
        setPoolWindowsFresh(openCodePool, false);
      }
    }
  }

  if (quotaOverrides) {
    for (const [k, v] of Object.entries(quotaOverrides)) {
      const previousWindowsFresh = poolWindowsFresh(pools[k]);
      pools[k] = { ...(pools[k] || {}), ...v, _explicit_override: Boolean(v.scarcity_state) };
      setPoolWindowsFresh(pools[k], Object.prototype.hasOwnProperty.call(v, 'windows') || previousWindowsFresh);
    }
  }

  for (const k of Object.keys(pools)) {
    const p = pools[k];
    if (!p.scarcity_state || p.scarcity_state === 'UNKNOWN') {
      p.scarcity_state = 'UNKNOWN';
    }
  }

  return pools;
}

export function scoreAndSelectRoute({ role, dataClass, targetEffort = null, quotaOverrides = null, allowChallengers = false, excludeRoutes = [], useLiveAxi = true }) {
  if (!dataClass || dataClass === 'UNKNOWN') {
    throw new Error(`dataClass is required and must not be empty or UNKNOWN (fail-closed policy)`);
  }
  const { registry, learned, compiledRoutes } = loadConfigs();
  if (!registry.canonical_roles.includes(role)) {
    throw new Error(`Cannot route unknown role: "${role}"`);
  }

  const requiredEffort = targetEffort || ROLE_DEFAULT_EFFORT[role] || 'medium';

  // Use resolved live quota pools with optional overrides and fail-closed normalization
  const liveQuota = resolveLiveQuotaPools({ quotaOverrides, useLiveAxi });

  // 1. Gather Candidate RouteTargets from Capability Index
  const candidateFamilies = CAPABILITY_INDEX[role] || [];
  const candidateRoutes = compiledRoutes.filter(r => {
    return candidateFamilies.some(fam => r.resolved_runtime_model.includes(fam) || r.model_family.includes(fam));
  });

  const rejectedRoutes = [];
  const viableCandidates = [];

  for (const route of candidateRoutes) {
    // Stage 0: Exclude routes requested by fallback re-routing policy
    if (excludeRoutes && excludeRoutes.includes(route.route_id)) {
      rejectedRoutes.push({ route_id: route.route_id, reason: 'Excluded by fallback re-routing policy' });
      continue;
    }

    // Stage 1: Lifecycle & Status Enforcement
    if (route.routing_status === 'BENCHMARK_ONLY') {
      rejectedRoutes.push({ route_id: route.route_id, reason: 'Lifecycle Blocked: BENCHMARK_ONLY candidate cannot be auto-dispatched' });
      continue;
    }
    if (route.routing_status === 'MANUAL_ONLY') {
      rejectedRoutes.push({ route_id: route.route_id, reason: 'Lifecycle Blocked: MANUAL_ONLY candidate requires manual captain specification' });
      continue;
    }
    if (route.routing_status === 'CHALLENGER' && !allowChallengers) {
      rejectedRoutes.push({ route_id: route.route_id, reason: 'Lifecycle Blocked: CHALLENGER candidate blocked under non-exploratory policy' });
      continue;
    }
    if (route.routing_status === 'CREDIT_GATED' || route.availability === 'credit_gated') {
      rejectedRoutes.push({ route_id: route.route_id, reason: `Unavailable / Credit Gated (${route.routing_status})` });
      continue;
    }
    if (route.routing_status !== 'ROUTING_ELIGIBLE' && route.routing_status !== 'CHALLENGER') {
      rejectedRoutes.push({ route_id: route.route_id, reason: `Lifecycle Blocked: status "${route.routing_status}" not eligible for auto-dispatch` });
      continue;
    }

    // Stage 2: Data Policy Gate
    const gate = evaluateDataGate(dataClass, route.data_profile, { resolvedRuntimeModel: route.resolved_runtime_model });
    if (!gate.allowed) {
      rejectedRoutes.push({ route_id: route.route_id, reason: `Data Policy Rejected: ${gate.reason}` });
      continue;
    }

    // Stage 3: Quota Pool State
    let pool = liveQuota[route.quota_pool];
    // If route maps to shared opencode_go pool
    if (!pool && route.quota_pool.startsWith('opencode_go')) {
      pool = liveQuota['opencode_go'];
    }
    pool = pool || {};

    let scarcityState = pool.scarcity_state || 'UNKNOWN';
    // If pool has multi-window subscription quotas and no explicit override, evaluate all windows and pick the most restrictive
    if (!pool._explicit_override && poolWindowsFresh(pool) && pool.windows && typeof pool.windows === 'object') {
      const severityRank = { EXHAUSTED: 6, CRITICAL: 5, CONSERVE: 4, USE_BEFORE_RESET: 3, NORMAL: 2, ABUNDANT: 1, UNKNOWN: 4 };
      let windowSeverity = null;
      for (const wKey of Object.keys(pool.windows)) {
        const w = pool.windows[wKey];
        if (!w) continue;
        const rem = w.percent_remaining ?? (typeof w.percent_used === 'number' ? (100 - w.percent_used) : null);
        if (rem === null) continue;
        let s = 'ABUNDANT';
        if (rem <= 0) s = 'EXHAUSTED';
        else if (rem <= 10) s = 'CRITICAL';
        else if (rem <= 25) s = 'CONSERVE';
        else if (rem <= 50) s = 'NORMAL';
        else s = 'ABUNDANT';
        if (!windowSeverity || severityRank[s] > severityRank[windowSeverity]) {
          windowSeverity = s;
        }
      }
      if (windowSeverity) {
        scarcityState = windowSeverity;
      }
    }
    // If scarcity state cannot be determined, default to UNKNOWN / conservative, NEVER ABUNDANT
    if (!scarcityState || scarcityState === 'UNKNOWN') {
      scarcityState = 'UNKNOWN';
    }

    if (scarcityState === 'EXHAUSTED') {
      rejectedRoutes.push({ route_id: route.route_id, reason: 'Quota Pool Exhausted' });
      continue;
    }

    viableCandidates.push({ route, pool, scarcityState });
  }

  if (viableCandidates.length === 0) {
    throw new Error(`No viable RouteTargets for role "${role}" with dataClass "${dataClass}". Rejections: ${rejectedRoutes.map(r => `${r.route_id}: ${r.reason}`).join('; ')}`);
  }

  // 2. Capacity-Aware Pareto Scoring
  const scored = viableCandidates.map(({ route, pool, scarcityState }) => {
    // Quality Prior / Posterior
    let qualityScore = 0.90;
    const roleStats = learned?.role_statistics?.[role];
    if (roleStats) {
      const stat = roleStats[route.resolved_runtime_model] || roleStats[route.model_family] || roleStats[route.logical_alias] || roleStats[route.route_id];
      if (stat && typeof stat.posterior_mean === 'number') {
        qualityScore = stat.posterior_mean;
      }
    }

    // Generic Quota Scarcity Factor (no magic strings)
    let quotaBonus = 0.0;
    if (scarcityState === 'ABUNDANT') quotaBonus = 0.05;
    else if (scarcityState === 'USE_BEFORE_RESET') quotaBonus = 0.15;
    else if (scarcityState === 'CONSERVE' || scarcityState === 'UNKNOWN') quotaBonus = -0.10;
    else if (scarcityState === 'CRITICAL') quotaBonus = -0.30;

    // Generic Normalized Burn Impact based on expected_normalized_burn
    const normalizedBurn = route.expected_normalized_burn || 1.0;
    let burnMultiplier = 0.002; // Minimal penalty when abundant
    if (scarcityState === 'CONSERVE' || scarcityState === 'UNKNOWN') {
      burnMultiplier = 0.015; // Noticeable penalty for heavy burn under conservation
    } else if (scarcityState === 'CRITICAL') {
      burnMultiplier = 0.030; // Severe penalty for heavy burn under critical shortage
    } else if (scarcityState === 'USE_BEFORE_RESET') {
      burnMultiplier = 0.0; // Burn is free/encouraged
    }
    const burnPenalty = (normalizedBurn - 1.0) * burnMultiplier;
    quotaBonus -= burnPenalty;

    // Effort Fit Dimension
    let effortFitScore = 0.0;
    const candidateEffort = route.reasoning_effort;
    if (candidateEffort === requiredEffort) {
      effortFitScore = 0.05; // Exact effort fit bonus
    } else if (candidateEffort === null) {
      effortFitScore = (requiredEffort === 'high') ? -0.05 : 0.0;
    } else if (requiredEffort === 'high' && (candidateEffort === 'low' || candidateEffort === 'minimal')) {
      effortFitScore = -0.15; // Severe penalty for inadequate depth on high-effort role
    } else if (requiredEffort === 'low' && (candidateEffort === 'high' || candidateEffort === 'xhigh')) {
      effortFitScore = -0.10; // Penalty for wasteful high-effort reasoning on low-effort task
    } else {
      effortFitScore = -0.05; // Slight mismatch
    }

    // Economic Arbitrage Note & Logic
    let arbitrageNote = `Standard route (scarcity: ${scarcityState}, burn: ${normalizedBurn}x, effort: ${candidateEffort || 'none'})`;
    if (route.harness === 'antigravity' && route.provider_path === 'antigravity_3p_gateway') {
      const nativeClaudePool = liveQuota['claude_pro'] || {};
      const nativeRemaining = nativeClaudePool.windows?.seven_day?.percent_remaining ?? 100;
      const agy3PRemaining = pool.windows?.weekly?.percent_remaining ?? 100;

      if (nativeRemaining < 25 && agy3PRemaining > 80 && role !== 'critical_auditor') {
        quotaBonus += 0.20;
        arbitrageNote = `Arbitrage: Native Claude scarce (${nativeRemaining}%), AGY 3P abundant (${agy3PRemaining}%) -> routing to AGY 3P`;
      }
    }

    if (role === 'critical_auditor') {
      if (route.model_family === 'claude' || route.resolved_runtime_model.includes('opus') || route.resolved_runtime_model.includes('sol')) {
        qualityScore += 0.25; // Massive quality anchor for irreversible audits
      }
    }

    const finalScore = parseFloat((qualityScore + quotaBonus + effortFitScore).toFixed(4));
    return {
      route,
      qualityScore,
      quotaBonus,
      effortFitScore,
      finalScore,
      scarcityState,
      arbitrageNote
    };
  });

  // Sort descending by final score
  scored.sort((a, b) => b.finalScore - a.finalScore);
  const winner = scored[0];

  return {
    role,
    dataClass,
    targetEffort: requiredEffort,
    effort: winner.route.reasoning_effort,
    selectedRoute: winner.route,
    selectedModelId: winner.route.resolved_runtime_model,
    modelId: winner.route.resolved_runtime_model, // For test compatibility
    resolvedRuntimeModel: winner.route.resolved_runtime_model, // For test compatibility
    harness: winner.route.harness,
    scarcityState: winner.scarcityState,
    finalScore: winner.finalScore,
    arbitrageReason: winner.arbitrageNote,
    candidateRoutesCount: candidateRoutes.length,
    viableCandidatesCount: viableCandidates.length,
    rejectedRoutes,
    topCandidates: scored.slice(0, 4).map(s => ({
      route_id: s.route.route_id,
      score: s.finalScore,
      effort_fit: s.effortFitScore,
      note: s.arbitrageNote
    })),
    liveQuotaPools: liveQuota,
    allCandidates: scored.map(s => ({
      route_id: s.route.route_id,
      harness: s.route.harness,
      model: s.route.resolved_runtime_model,
      effort: s.route.reasoning_effort,
      score: s.finalScore
    }))
  };
}

export function logTelemetry(record) {
  const routeExecId = record.route_execution_id || record.execution_id || `rex-${Date.now()}-${Math.floor(Math.random()*1000)}`;
  const parentExecId = record.parent_route_execution_id || routeExecId;
  const entry = {
    route_execution_id: routeExecId,
    parent_route_execution_id: parentExecId,
    execution_id: routeExecId,
    timestamp: record.timestamp || new Date().toISOString(),
    ...record,
    route_execution_id: routeExecId,
    parent_route_execution_id: parentExecId,
    execution_id: routeExecId
  };
  const logPath = getExecutionsLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  return entry;
}

export function ingressDispatchStarted({
  taskId,
  routeExecutionId = null,
  parentExecutionId = null,
  attemptNumber = 1,
  retryCount = 0,
  path = 'A',
  taskClassification = null,
  dataClass = null,
  classificationStatus = null,
  candidateRoutes = null,
  candidateRouteSetMarker = null,
  routeDecision = null,
  quotaSnapshotBefore = null,
  selectedRouteId = null,
  selectedHarness = null,
  selectedModel = null,
  selectedEffort = null,
  diagnosticConstraint = null,
  dispatchType = 'task_dispatch',
  extra = {}
}) {
  const execId = routeExecutionId || `rex-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const rootId = parentExecutionId || execId;
  const now = new Date().toISOString();
  const classification = normalizeTelemetryClassification(dataClass, classificationStatus);

  let quotaBefore = quotaSnapshotBefore;
  if (!quotaBefore) {
    try {
      quotaBefore = resolveLiveQuotaPools({ useLiveAxi: true });
    } catch (_) {
      quotaBefore = null;
    }
  }

  const record = {
    route_execution_id: execId,
    parent_route_execution_id: rootId,
    execution_id: execId,
    attempt_number: attemptNumber,
    retry_count: retryCount,
    task_id: taskId,
    dispatch_path: path,
    dispatch_type: dispatchType,
    task_classification: taskClassification || 'general_engineer',
    requested_role: taskClassification || 'general_engineer',
    data_class: classification.dataClass,
    classification_status: classification.classificationStatus,
    candidate_routes: candidateRoutes,
    candidate_route_set_marker: candidateRouteSetMarker,
    route_decision: routeDecision,
    quota_snapshot_before: quotaBefore,
    selected_route_id: selectedRouteId,
    selected_harness: selectedHarness,
    selected_model: selectedModel,
    selected_effort: selectedEffort,
    actual_harness: null,
    actual_model: null,
    actual_effort: null,
    ...(diagnosticConstraint ? { diagnostic_constraint: diagnosticConstraint } : {}),
    dispatch_status: 'started',
    lifecycle_state: 'SELECTED',
    started_at: now,
    timestamp: now,
    ...extra,
    data_class: classification.dataClass,
    classification_status: classification.classificationStatus
  };

  return logTelemetry(record);
}

export function ingressDispatchLaunching({
  taskId,
  routeExecutionId,
  parentExecutionId = null,
  attemptNumber = 1,
  retryCount = 0,
  path = 'A',
  selectedRouteId = null,
  selectedHarness = null,
  selectedModel = null,
  selectedEffort = null,
  dataClass = null,
  classificationStatus = null,
  dispatchType = 'task_dispatch',
  extra = {}
}) {
  const rootId = parentExecutionId || routeExecutionId;
  const now = new Date().toISOString();
  const classification = normalizeTelemetryClassification(dataClass, classificationStatus);
  const record = {
    route_execution_id: routeExecutionId,
    parent_route_execution_id: rootId,
    execution_id: routeExecutionId,
    attempt_number: attemptNumber,
    retry_count: retryCount,
    task_id: taskId,
    dispatch_path: path,
    dispatch_type: dispatchType,
    selected_route_id: selectedRouteId,
    selected_harness: selectedHarness,
    selected_model: selectedModel,
    selected_effort: selectedEffort,
    dispatch_status: 'launching',
    lifecycle_state: 'LAUNCHING',
    launching_at: now,
    timestamp: now,
    ...extra,
    data_class: classification.dataClass,
    classification_status: classification.classificationStatus
  };
  return logTelemetry(record);
}

export function ingressDispatchDispatched({
  taskId,
  routeExecutionId,
  parentExecutionId = null,
  attemptNumber = 1,
  retryCount = 0,
  path = 'A',
  selectedRouteId = null,
  selectedHarness = null,
  selectedModel = null,
  selectedEffort = null,
  actualHarness = null,
  actualModel = null,
  actualEffort = null,
  dataClass = null,
  classificationStatus = null,
  workerId = null,
  worktree = null,
  pid = null,
  backend = null,
  dispatchType = 'task_dispatch',
  extra = {}
}) {
  const rootId = parentExecutionId || routeExecutionId;
  const now = new Date().toISOString();
  const classification = normalizeTelemetryClassification(dataClass, classificationStatus);

  const record = {
    route_execution_id: routeExecutionId,
    parent_route_execution_id: rootId,
    execution_id: routeExecutionId,
    attempt_number: attemptNumber,
    retry_count: retryCount,
    task_id: taskId,
    dispatch_path: path,
    dispatch_type: dispatchType,
    selected_route_id: selectedRouteId,
    selected_harness: selectedHarness,
    selected_model: selectedModel,
    selected_effort: selectedEffort,
    actual_harness: actualHarness,
    actual_model: actualModel,
    actual_effort: actualEffort,
    herdr_worker_id: workerId || 'unknown',
    herdr_task_id: taskId,
    worktree: worktree || null,
    pid: pid ? Number(pid) : null,
    backend: backend || null,
    dispatch_match: true,
    dispatch_status: 'dispatched',
    lifecycle_state: 'DISPATCHED',
    dispatched_at: now,
    timestamp: now,
    ...extra,
    data_class: classification.dataClass,
    classification_status: classification.classificationStatus
  };

  return logTelemetry(record);
}

export function ingressDispatchRunning({
  taskId,
  routeExecutionId,
  parentExecutionId = null,
  attemptNumber = 1,
  retryCount = 0,
  path = 'A',
  selectedRouteId = null,
  selectedHarness = null,
  selectedModel = null,
  selectedEffort = null,
  actualHarness = null,
  actualModel = null,
  actualEffort = null,
  dataClass = null,
  classificationStatus = null,
  workerId = null,
  worktree = null,
  pid = null,
  backend = null,
  dispatchType = 'task_dispatch',
  extra = {}
}) {
  const rootId = parentExecutionId || routeExecutionId;
  const now = new Date().toISOString();
  const classification = normalizeTelemetryClassification(dataClass, classificationStatus);
  const record = {
    route_execution_id: routeExecutionId,
    parent_route_execution_id: rootId,
    execution_id: routeExecutionId,
    attempt_number: attemptNumber,
    retry_count: retryCount,
    task_id: taskId,
    dispatch_path: path,
    dispatch_type: dispatchType,
    selected_route_id: selectedRouteId,
    selected_harness: selectedHarness,
    selected_model: selectedModel,
    selected_effort: selectedEffort,
    actual_harness: actualHarness,
    actual_model: actualModel,
    actual_effort: actualEffort,
    herdr_worker_id: workerId || 'unknown',
    herdr_task_id: taskId,
    worktree: worktree || null,
    pid: pid ? Number(pid) : null,
    backend: backend || null,
    dispatch_match: true,
    dispatch_status: 'running',
    lifecycle_state: 'RUNNING',
    running_at: now,
    timestamp: now,
    ...extra,
    data_class: classification.dataClass,
    classification_status: classification.classificationStatus
  };
  return logTelemetry(record);
}

export function ingressDispatchFailed({
  taskId,
  routeExecutionId,
  parentExecutionId = null,
  attemptNumber = 1,
  retryCount = 0,
  path = 'A',
  selectedRouteId = null,
  selectedHarness = null,
  selectedModel = null,
  selectedEffort = null,
  dataClass = null,
  classificationStatus = null,
  errorCategory = 'harness_launch_failure',
  errorMessage = '',
  dispatchType = 'task_dispatch',
  extra = {}
}) {
  const rootId = parentExecutionId || routeExecutionId;
  const now = new Date().toISOString();
  const classification = normalizeTelemetryClassification(dataClass, classificationStatus);

  const record = {
    route_execution_id: routeExecutionId,
    parent_route_execution_id: rootId,
    execution_id: routeExecutionId,
    attempt_number: attemptNumber,
    retry_count: retryCount,
    task_id: taskId,
    dispatch_path: path,
    dispatch_type: dispatchType,
    selected_route_id: selectedRouteId,
    selected_harness: selectedHarness,
    selected_model: selectedModel,
    selected_effort: selectedEffort,
    actual_harness: null,
    actual_model: null,
    actual_effort: null,
    dispatch_status: 'launch_failed',
    dispatch_match: false,
    terminal_state: 'LAUNCH_FAILED',
    lifecycle_state: 'FAILED',
    error_category: errorCategory,
    error_message: String(errorMessage).slice(0, 500),
    completed_at: now,
    timestamp: now,
    ...extra,
    data_class: classification.dataClass,
    classification_status: classification.classificationStatus
  };

  return logTelemetry(record);
}

export function dispatchThroughHerdr({
  taskId,
  role = 'general_engineer',
  dataClass,
  targetEffort = null,
  intent = '',
  spec = '',
  scout = true,
  projectDir = null,
  repoName = 'captain-workspace',
  mode = 'local-only',
  yolo = 'off',
  excludeRoutes = [],
  diagnosticConstraint = null,
  quotaOverrides = null,
  spawnRunner = null,
  routeExecutionId = null,
  parentExecutionId = null,
  attemptNumber = 1,
  retryCount = 0,
  useLiveAxi = true,
  backend = 'herdr'
}) {
  if (!dataClass || dataClass === 'UNKNOWN') {
    throw new Error('dispatchThroughHerdr: dataClass is required and must not be empty or UNKNOWN (fail-closed policy)');
  }
  let effectiveExcludes = [...excludeRoutes];
  if (diagnosticConstraint === 'non_agy_observer') {
    const { compiledRoutes } = loadConfigs();
    effectiveExcludes.push(...compiledRoutes.filter(r => r.harness === 'antigravity').map(r => r.route_id));
  }
  const decision = scoreAndSelectRoute({
    role,
    dataClass,
    targetEffort,
    excludeRoutes: effectiveExcludes,
    quotaOverrides,
    useLiveAxi
  });
  const selectedRoute = decision.selectedRoute;
  const briefPath = homePath(path.join('data', taskId, 'brief.md'));
  if (!fs.existsSync(briefPath)) {
    throw new Error(`dispatchThroughHerdr: task ${taskId} must be provisioned by the task intake owner; missing brief at ${briefPath}`);
  }

  const execId = routeExecutionId || `rex-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const rootExecId = parentExecutionId || execId;

  ingressDispatchStarted({
    taskId,
    routeExecutionId: execId,
    parentExecutionId: rootExecId,
    attemptNumber,
    retryCount,
    path: 'A',
    taskClassification: role,
    dataClass,
    candidateRoutes: decision.allCandidates || decision.topCandidates || [],
    candidateRouteSetMarker: null,
    routeDecision: {
      decision_type: 'router_v2',
      route_id: selectedRoute.route_id,
      harness: selectedRoute.harness,
      model: selectedRoute.resolved_runtime_model,
      effort: selectedRoute.reasoning_effort,
      score: decision.finalScore,
      arbitrage_reason: decision.arbitrageReason
    },
    quotaSnapshotBefore: decision.liveQuotaPools,
    selectedRouteId: selectedRoute.route_id,
    selectedHarness: selectedRoute.harness,
    selectedModel: selectedRoute.resolved_runtime_model,
    selectedEffort: selectedRoute.reasoning_effort,
    diagnosticConstraint
  });
  ingressDispatchLaunching({
    taskId,
    routeExecutionId: execId,
    parentExecutionId: rootExecId,
    attemptNumber,
    retryCount,
    path: 'A',
    selectedRouteId: selectedRoute.route_id,
    selectedHarness: selectedRoute.harness,
    selectedModel: selectedRoute.resolved_runtime_model,
    selectedEffort: selectedRoute.reasoning_effort,
    dataClass,
    extra: {
      requested_role: role,
      ...(diagnosticConstraint ? { diagnostic_constraint: diagnosticConstraint } : {})
    }
  });

  const effectiveProjectDir = projectDir || currentFmHome();
  const spawnArgs = [path.join(ROOT, 'bin', 'fm-spawn.sh'), taskId, effectiveProjectDir];
  if (scout) {
    spawnArgs.push('--scout');
  } else {
    spawnArgs.push('--mode', mode, '--yolo', yolo);
  }
  spawnArgs.push('--harness', selectedRoute.harness);
  spawnArgs.push('--model', selectedRoute.resolved_runtime_model);
  spawnArgs.push('--role', role);
  spawnArgs.push('--data-class', dataClass);
  spawnArgs.push('--route-id', selectedRoute.route_id);
  spawnArgs.push('--route-execution-id', execId);
  spawnArgs.push('--parent-execution-id', rootExecId);
  if (selectedRoute.reasoning_effort) {
    const effort = selectedRoute.reasoning_effort === 'ultra' ? 'max' : selectedRoute.reasoning_effort;
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
      spawnArgs.push('--effort', effort);
    }
  }
  spawnArgs.push('--backend', backend);

  let spawnResult;
  if (spawnRunner) {
    spawnResult = spawnRunner(spawnArgs, { env: { ...process.env, FM_HOME: currentFmHome() }, taskId, selectedRoute });
  } else {
    try {
      const stdout = execFileSync('bash', spawnArgs, {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 120000,
        env: { ...process.env, FM_HOME: currentFmHome() }
      });
      spawnResult = { success: true, output: stdout };
    } catch (error) {
      spawnResult = {
        success: false,
        error: typeof error.stderr === 'string' ? error.stderr : error.message,
        code: error.status
      };
    }
  }

  if (!spawnResult?.success) {
    ingressDispatchFailed({
      taskId,
      routeExecutionId: execId,
      parentExecutionId: rootExecId,
      attemptNumber,
      retryCount,
      path: 'A',
      selectedRouteId: selectedRoute.route_id,
      selectedHarness: selectedRoute.harness,
      selectedModel: selectedRoute.resolved_runtime_model,
      selectedEffort: selectedRoute.reasoning_effort,
      dataClass,
      errorMessage: String(spawnResult?.error || 'spawn failed').slice(0, 500),
      extra: {
        requested_role: role,
        ...(diagnosticConstraint ? { diagnostic_constraint: diagnosticConstraint } : {})
      }
    });

    if (effectiveExcludes.includes(selectedRoute.route_id)) {
      return { success: false, taskId, executionId: execId, routeExecutionId: execId, routeDecision: decision, selectedRoute, spawnOutput: '' };
    }
    try {
      return dispatchThroughHerdr({
        taskId,
        role,
        dataClass,
        targetEffort,
        intent,
        spec,
        scout,
        projectDir,
        repoName,
        mode,
        yolo,
        excludeRoutes: [...excludeRoutes, selectedRoute.route_id],
        diagnosticConstraint,
        quotaOverrides,
        spawnRunner,
        parentExecutionId: rootExecId,
        routeExecutionId: `${rootExecId}:retry-${retryCount + 1}`,
        attemptNumber: attemptNumber + 1,
        retryCount: retryCount + 1,
        useLiveAxi,
        backend
      });
    } catch (retryError) {
      return { success: false, taskId, executionId: execId, routeExecutionId: execId, routeDecision: decision, selectedRoute, spawnOutput: '', error: retryError.message };
    }
  }

  const metaPath = homePath(path.join('state', `${taskId}.meta`));
  const meta = {};
  if (fs.existsSync(metaPath)) {
    for (const line of fs.readFileSync(metaPath, 'utf8').split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }

  ingressDispatchDispatched({
    taskId,
    routeExecutionId: execId,
    parentExecutionId: rootExecId,
    attemptNumber,
    retryCount,
    path: 'A',
    selectedRouteId: selectedRoute.route_id,
    selectedHarness: selectedRoute.harness,
    selectedModel: selectedRoute.resolved_runtime_model,
    selectedEffort: selectedRoute.reasoning_effort,
    actualHarness: meta.harness || selectedRoute.harness,
    actualModel: meta.model || selectedRoute.resolved_runtime_model,
    actualEffort: meta.effort || selectedRoute.reasoning_effort,
    dataClass,
    workerId: meta.window || meta.herdr_pane_id || 'unknown',
    worktree: meta.worktree || null,
    pid: meta.pid ? Number(meta.pid) : null,
    backend: meta.backend || 'herdr',
    extra: {
      requested_role: role,
      ...(diagnosticConstraint ? { diagnostic_constraint: diagnosticConstraint } : {}),
      herdr_session: meta.herdr_session || null,
      herdr_workspace_id: meta.herdr_workspace_id || null,
      herdr_tab_id: meta.herdr_tab_id || null,
      herdr_pane_id: meta.herdr_pane_id || null
    }
  });
  ingressDispatchRunning({
    taskId,
    routeExecutionId: execId,
    parentExecutionId: rootExecId,
    attemptNumber,
    retryCount,
    path: 'A',
    selectedRouteId: selectedRoute.route_id,
    selectedHarness: selectedRoute.harness,
    selectedModel: selectedRoute.resolved_runtime_model,
    selectedEffort: selectedRoute.reasoning_effort,
    actualHarness: meta.harness || selectedRoute.harness,
    actualModel: meta.model || selectedRoute.resolved_runtime_model,
    actualEffort: meta.effort || selectedRoute.reasoning_effort,
    dataClass,
    workerId: meta.window || meta.herdr_pane_id || 'unknown',
    worktree: meta.worktree || null,
    pid: meta.pid ? Number(meta.pid) : null,
    backend: meta.backend || 'herdr',
    extra: {
      requested_role: role,
      ...(diagnosticConstraint ? { diagnostic_constraint: diagnosticConstraint } : {}),
      herdr_session: meta.herdr_session || null,
      herdr_workspace_id: meta.herdr_workspace_id || null,
      herdr_tab_id: meta.herdr_tab_id || null,
      herdr_pane_id: meta.herdr_pane_id || null
    }
  });

  return {
    success: true,
    taskId,
    executionId: execId,
    routeExecutionId: execId,
    routeDecision: decision,
    selectedRoute,
    herdr: {
      window: meta.window,
      session: meta.herdr_session,
      workspaceId: meta.herdr_workspace_id,
      tabId: meta.herdr_tab_id,
      paneId: meta.herdr_pane_id,
      worktree: meta.worktree,
      pid: meta.pid ? Number(meta.pid) : null
    },
    spawnOutput: spawnResult.output || ''
  };
}

export function recordTaskCompletion(taskId, {
  terminalState = 'SUCCESS',
  resultSummary = '',
  exitCode = 0,
  routeExecutionId = null,
  parentExecutionId = null
} = {}) {
  const metaPath = homePath(path.join('state', `${taskId}.meta`));
  let meta = {};
  if (fs.existsSync(metaPath)) {
    const lines = fs.readFileSync(metaPath, 'utf8').split('\n');
    for (const line of lines) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
  }

  const reportPath = homePath(path.join('data', taskId, 'report.md'));
  const hasReport = fs.existsSync(reportPath);
  const logPath = getExecutionsLogPath();

  let execId = routeExecutionId || meta.route_execution_id || meta.execution_id;
  let parentId = parentExecutionId || meta.parent_route_execution_id;
  let dispatchPath = meta.dispatch_path || null;

  if (fs.existsSync(logPath)) {
    try {
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        const entry = JSON.parse(line);
        if (entry.task_id === taskId && (entry.route_execution_id || entry.execution_id)) {
          if (!execId) {
            execId = entry.route_execution_id || entry.execution_id;
            parentId = entry.parent_route_execution_id || execId;
          }
          if (!dispatchPath && entry.dispatch_path) {
            dispatchPath = entry.dispatch_path;
          }
          break;
        }
      }
    } catch (_) {}
  }

  if (!execId) {
    execId = `exec-${Date.now()}-${Math.floor(Math.random()*1000)}`;
  }
  if (!parentId) {
    parentId = execId;
  }

  // Idempotency check: if completed already recorded for this execution ID, do not re-append
  if (fs.existsSync(logPath)) {
    try {
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        const entry = JSON.parse(line);
        if (
          (entry.route_execution_id === execId || entry.execution_id === execId) &&
          entry.dispatch_status === 'completed'
        ) {
          return entry;
        }
      }
    } catch (_) {}
  }

  let quotaSnapshotAfter = null;
  try {
    quotaSnapshotAfter = resolveLiveQuotaPools({ useLiveAxi: true });
  } catch (_) {
    quotaSnapshotAfter = null;
  }

  const now = new Date().toISOString();
  const completedRecord = {
    route_execution_id: execId,
    parent_route_execution_id: parentId,
    execution_id: execId,
    task_id: taskId,
    dispatch_path: dispatchPath,
    actual_harness: meta.harness || null,
    actual_model: meta.model || null,
    actual_effort: meta.effort || null,
    herdr_worker_id: meta.window || null,
    dispatch_status: 'completed',
    lifecycle_state: terminalState === 'SUCCESS' ? 'COMPLETED' : 'FAILED',
    terminal_state: terminalState,
    exit_code: exitCode,
    artifact_path: hasReport ? `data/${taskId}/report.md` : null,
    result_summary: resultSummary || (hasReport ? fs.readFileSync(reportPath, 'utf8').slice(0, 300) : ''),
    quota_snapshot_after: quotaSnapshotAfter,
    completed_at: now,
    timestamp: now
  };
  logTelemetry(completedRecord);
  return completedRecord;
}

export function teardownTask(taskId, { force = false } = {}) {
  try {
    const args = [path.join(ROOT, 'bin/fm-teardown.sh'), taskId];
    if (force) args.push('--force');
    const stdout = execFileSync('bash', args, { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, FM_HOME: currentFmHome() } });
    return { success: true, output: stdout };
  } catch (e) {
    return { success: false, error: e.stderr || e.message };
  }
}

function parseCliFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const k = arg.slice(2, eqIdx);
        const v = arg.slice(eqIdx + 1);
        flags[k] = v;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[arg.slice(2)] = argv[++i];
      } else {
        flags[arg.slice(2)] = true;
      }
    }
  }
  return flags;
}

// CLI handler
if (process.argv[1] && process.argv[1].endsWith('fm-router-v2.mjs')) {
  const cmd = process.argv[2] || 'validate';
  if (cmd === 'validate') {
    try {
      const res = validateConfigs();
      console.log(`ROUTER_V2: configuration verified valid (${res.canonicalRolesCount} canonical roles, ${res.modelsCount} models)`);
      process.exit(0);
    } catch (e) {
      console.error(`ROUTER_V2: invalid configuration - ${e.message}`);
      process.exit(1);
    }
  } else if (cmd === 'route') {
    const role = process.argv[3] || 'general_engineer';
    const dataClass = process.argv[4];
    const effort = process.argv[5] || null;
    if (!dataClass || dataClass === 'UNKNOWN') {
      console.error('Usage: fm-router-v2.mjs route <role> <dataClass> [effort]');
      console.error('Error: dataClass is required and must not be empty or UNKNOWN (fail-closed policy)');
      process.exit(1);
    }
    const res = scoreAndSelectRoute({ role, dataClass, targetEffort: effort });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'dispatch') {
    const taskId = process.argv[3];
    const role = process.argv[4] || 'general_engineer';
    const dataClass = process.argv[5];
    const effort = process.argv[6] || null;
    const diagnosticConstraint = process.env.DIAGNOSTIC_CONSTRAINT || process.argv[7] || null;
    if (!taskId || !dataClass || dataClass === 'UNKNOWN') {
      console.error('Usage: fm-router-v2.mjs dispatch <task_id> [role] <dataClass> [effort] [diagnosticConstraint]');
      console.error('Error: taskId and dataClass are required; dataClass must not be empty or UNKNOWN (fail-closed policy)');
      process.exit(1);
    }
    try {
      const res = dispatchThroughHerdr({
        taskId,
        role,
        dataClass,
        targetEffort: effort,
        intent: `Task ${taskId} (${role})`,
        spec: `Execute ${taskId} as ${role} and report results.`,
        scout: true,
        diagnosticConstraint
      });
      console.log(JSON.stringify(res, null, 2));
    } catch (e) {
      console.error(`DISPATCH ERROR: ${e.message}`);
      process.exit(1);
    }
  } else if (cmd === 'ingress-start') {
    const flags = parseCliFlags(process.argv.slice(3));
    const isSecondmateRelaunch = Boolean(flags['secondmate-relaunch']);
    const dispatchType = isSecondmateRelaunch ? 'system_internal_relaunch' : 'task_dispatch';
    const marker = isSecondmateRelaunch
      ? 'system-internal relaunch, no candidate set evaluated'
      : 'legacy/manual decision, no candidate set evaluated';
    const entry = ingressDispatchStarted({
      taskId: flags['task-id'],
      routeExecutionId: flags['route-execution-id'],
      parentExecutionId: flags['parent-execution-id'],
      path: flags['path'] || 'B',
      taskClassification: flags['task-classification'] || flags['role'] || flags['kind'] || 'crewmate',
      dataClass: flags['data-class'] || null,
      classificationStatus: flags['classification-status'] || null,
      candidateRoutes: null,
      candidateRouteSetMarker: marker,
      routeDecision: {
        decision_type: isSecondmateRelaunch ? 'system_internal_relaunch' : 'legacy_manual',
        marker,
        harness: flags['harness'] || 'default',
        model: flags['model'] || 'default',
        effort: flags['effort'] || 'default',
        route_id: flags['route-id'] || null
      },
      selectedRouteId: flags['route-id'] || null,
      selectedHarness: flags['harness'] || null,
      selectedModel: flags['model'] || null,
      selectedEffort: flags['effort'] || null,
      dataClass: flags['data-class'] || null,
      classificationStatus: flags['classification-status'] || null,
      dispatchType
    });
    console.log(JSON.stringify(entry));
  } else if (cmd === 'ingress-launching') {
    const flags = parseCliFlags(process.argv.slice(3));
    const isSecondmateRelaunch = Boolean(flags['secondmate-relaunch']);
    const dispatchType = isSecondmateRelaunch ? 'system_internal_relaunch' : 'task_dispatch';
    const entry = ingressDispatchLaunching({
      taskId: flags['task-id'],
      routeExecutionId: flags['route-execution-id'],
      parentExecutionId: flags['parent-execution-id'],
      path: flags['path'] || 'B',
      selectedRouteId: flags['route-id'] || null,
      selectedHarness: flags['harness'] || null,
      selectedModel: flags['model'] || null,
      selectedEffort: flags['effort'] || null,
      dataClass: flags['data-class'] || null,
      classificationStatus: flags['classification-status'] || null,
      dispatchType
    });
    console.log(JSON.stringify(entry));
  } else if (cmd === 'ingress-dispatched') {
    const flags = parseCliFlags(process.argv.slice(3));
    const isSecondmateRelaunch = Boolean(flags['secondmate-relaunch']);
    const dispatchType = isSecondmateRelaunch ? 'system_internal_relaunch' : 'task_dispatch';
    const entry = ingressDispatchDispatched({
      taskId: flags['task-id'],
      routeExecutionId: flags['route-execution-id'],
      parentExecutionId: flags['parent-execution-id'],
      path: flags['path'] || 'B',
      actualHarness: flags['actual-harness'],
      actualModel: flags['actual-model'],
      actualEffort: flags['actual-effort'],
      dataClass: flags['data-class'] || null,
      classificationStatus: flags['classification-status'] || null,
      workerId: flags['worker-id'] || flags['window'],
      worktree: flags['worktree'],
      backend: flags['backend'],
      pid: flags['pid'],
      dispatchType
    });
    console.log(JSON.stringify(entry));
  } else if (cmd === 'ingress-running') {
    const flags = parseCliFlags(process.argv.slice(3));
    const isSecondmateRelaunch = Boolean(flags['secondmate-relaunch']);
    const dispatchType = isSecondmateRelaunch ? 'system_internal_relaunch' : 'task_dispatch';
    const entry = ingressDispatchRunning({
      taskId: flags['task-id'],
      routeExecutionId: flags['route-execution-id'],
      parentExecutionId: flags['parent-execution-id'],
      path: flags['path'] || 'B',
      selectedRouteId: flags['route-id'] || null,
      selectedHarness: flags['harness'] || null,
      selectedModel: flags['model'] || null,
      selectedEffort: flags['effort'] || null,
      actualHarness: flags['actual-harness'],
      actualModel: flags['actual-model'],
      actualEffort: flags['actual-effort'],
      dataClass: flags['data-class'] || null,
      classificationStatus: flags['classification-status'] || null,
      workerId: flags['worker-id'] || flags['window'],
      worktree: flags['worktree'],
      backend: flags['backend'],
      pid: flags['pid'],
      dispatchType
    });
    console.log(JSON.stringify(entry));
  } else if (cmd === 'ingress-failed') {
    const flags = parseCliFlags(process.argv.slice(3));
    const isSecondmateRelaunch = Boolean(flags['secondmate-relaunch']);
    const dispatchType = isSecondmateRelaunch ? 'system_internal_relaunch' : 'task_dispatch';
    const entry = ingressDispatchFailed({
      taskId: flags['task-id'],
      routeExecutionId: flags['route-execution-id'],
      parentExecutionId: flags['parent-execution-id'],
      path: flags['path'] || 'B',
      dataClass: flags['data-class'] || null,
      classificationStatus: flags['classification-status'] || null,
      errorMessage: flags['error'] || 'spawn failed',
      dispatchType
    });
    console.log(JSON.stringify(entry));
  } else if (cmd === 'complete') {
    const taskId = process.argv[3];
    const state = process.argv[4] || 'SUCCESS';
    const summary = process.argv[5] || '';
    const res = recordTaskCompletion(taskId, { terminalState: state, resultSummary: summary });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'teardown') {
    const taskId = process.argv[3];
    const force = process.argv[4] === '--force';
    const res = teardownTask(taskId, { force });
    console.log(JSON.stringify(res, null, 2));
  }
}
