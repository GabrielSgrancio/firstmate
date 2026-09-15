#!/usr/bin/env node

const WINDOW_HORIZONS_HOURS = {
  rolling: 5,
  weekly: 7 * 24,
  monthly: 30 * 24
};

const POOL_SCARCITY_RANK = {
  EXHAUSTED: 6,
  CRITICAL: 5,
  CONSERVE: 4,
  USE_BEFORE_RESET: 3,
  NORMAL: 2,
  ABUNDANT: 1,
  UNKNOWN: 4
};

// Burn learning trusts real quota deltas only after enough clean samples, and a
// single observation can move a route at most a bounded factor from its catalog
// burn before shrinkage toward that catalog value.
export const MIN_BURN_CALIBRATION_SAMPLES = 3;
export const BURN_PRIOR_WEIGHT = 3;
export const BURN_RATIO_BOUND = 4;

export const RESOURCE_POOLS = [
  'claude_pro',
  'codex_plus',
  'antigravity_gemini',
  'antigravity_3p',
  'opencode_go'
];

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function mean(values) {
  const valid = values.filter(finite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function median(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function canonicalPoolName(poolName, pools = {}) {
  if (poolName && pools[poolName]) return poolName;
  if (poolName?.startsWith('opencode_go')) return 'opencode_go';
  return poolName;
}

function windowKind(name) {
  const key = String(name).toLowerCase();
  if (key.includes('month')) return 'monthly';
  if (key.includes('week') || key.includes('seven_day') || key.includes('7d')) return 'weekly';
  if (key.includes('five_hour') || key.includes('rolling') || key.includes('5h')) return 'rolling';
  if (key.includes('day')) return 'weekly';
  return null;
}

function remainingPercent(window) {
  if (!window || typeof window !== 'object') return null;
  if (finite(window.percent_remaining)) return clamp(window.percent_remaining, 0, 100);
  if (finite(window.percentRemaining)) return clamp(window.percentRemaining, 0, 100);
  if (finite(window.percent_used)) return clamp(100 - window.percent_used, 0, 100);
  if (finite(window.percentUsed)) return clamp(100 - window.percentUsed, 0, 100);
  return null;
}

function resetAt(window) {
  return window?.reset_at || window?.resetAt || window?.resetsAt || null;
}

function resetHours(reset, nowMs) {
  if (!reset) return null;
  const timestamp = new Date(reset).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (timestamp - nowMs) / 3600000);
}

function scarcityForRemaining(remaining) {
  if (!finite(remaining)) return 'UNKNOWN';
  if (remaining <= 0) return 'EXHAUSTED';
  if (remaining <= 10) return 'CRITICAL';
  if (remaining <= 25) return 'CONSERVE';
  if (remaining <= 50) return 'NORMAL';
  return 'ABUNDANT';
}

function extractPoolSnapshot(snapshot, poolName) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return snapshot[poolName] || (poolName?.startsWith('opencode_go') ? snapshot.opencode_go : null);
}

function extractTokenUsage(record) {
  for (const key of ['actual_token_usage', 'tokens_consumed', 'token_usage', 'total_tokens']) {
    const value = record?.[key];
    if (finite(value)) return value;
    if (finite(value?.total_tokens)) return value.total_tokens;
    if (finite(value?.totalTokens)) return value.totalTokens;
  }
  if (finite(record?.usage?.total_tokens)) return record.usage.total_tokens;
  if (finite(record?.usage?.totalTokens)) return record.usage.totalTokens;
  return null;
}

function extractCacheEfficiency(record) {
  for (const key of ['cache_efficiency', 'cacheEfficiency', 'cache_hit_rate']) {
    if (finite(record?.[key])) return clamp(record[key], 0, 1);
  }
  const hits = record?.cache_hits ?? record?.cache_read_tokens;
  const total = record?.cache_total ?? record?.cache_input_tokens;
  if (finite(hits) && finite(total) && total > 0) return clamp(hits / total, 0, 1);
  return null;
}

function eventTime(record) {
  for (const key of ['completed_at', 'started_at', 'timestamp']) {
    const parsed = new Date(record?.[key] || '').getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function executionId(record) {
  return record?.route_execution_id || record?.execution_id || null;
}

function routeIdForRecord(records) {
  for (const record of records) {
    if (record?.selected_route_id) return record.selected_route_id;
  }
  return null;
}

function aggregateForRoute() {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    tokenValues: [],
    latencyValues: [],
    cacheValues: [],
    quotaDeltas: [],
    timestamps: []
  };
}

function addObservation(target, observation) {
  target.attempts += 1;
  if (observation.success) target.successes += 1;
  if (observation.failure) target.failures += 1;
  if (observation.retry) target.retries += 1;
  if (finite(observation.tokens)) target.tokenValues.push(observation.tokens);
  if (finite(observation.latency)) target.latencyValues.push(observation.latency);
  if (finite(observation.cache)) target.cacheValues.push(observation.cache);
  if (observation.quotaDelta) target.quotaDeltas.push(observation.quotaDelta);
  if (finite(observation.timestamp)) target.timestamps.push(observation.timestamp);
}

export function calculateObservedQuotaDelta(before, after, poolName) {
  const beforePool = extractPoolSnapshot(before, poolName);
  const afterPool = extractPoolSnapshot(after, poolName);
  if (!beforePool || !afterPool) return null;

  const byWindow = {};
  for (const [name, beforeWindow] of Object.entries(beforePool.windows || {})) {
    const afterWindow = afterPool.windows?.[name];
    const beforeRemaining = remainingPercent(beforeWindow);
    const afterRemaining = remainingPercent(afterWindow);
    if (!finite(beforeRemaining) || !finite(afterRemaining)) continue;
    const beforeReset = resetAt(beforeWindow);
    const afterReset = resetAt(afterWindow);
    // A window that reset mid-measurement mixes two budgets; its delta is not burn.
    if (beforeReset && afterReset && String(beforeReset) !== String(afterReset)) {
      const shift = Math.abs(new Date(afterReset).getTime() - new Date(beforeReset).getTime());
      if (!Number.isFinite(shift) || shift > 60000) continue;
    }
    const delta = beforeRemaining - afterRemaining;
    if (delta > 0) byWindow[windowKind(name) || name] = Number(delta.toFixed(6));
  }
  const deltas = Object.values(byWindow).filter(finite);
  if (!deltas.length) return null;
  return {
    percent_points: Number(Math.max(...deltas).toFixed(6)),
    by_window: byWindow,
    source: 'real_quota_snapshots'
  };
}

// isActive(records) lets the caller confirm an open execution is still a live
// task; without it, open executions older than ACTIVE_EXECUTION_MAX_AGE_HOURS
// are treated as orphaned.  Each task id holds at most one concurrency slot.
export const ACTIVE_EXECUTION_MAX_AGE_HOURS = 24;

export function collectRoutingObservations(executions = [], routes = [], now = new Date(), { isActive = null } = {}) {
  const records = Array.isArray(executions) ? executions.filter((record) => record && typeof record === 'object') : [];
  const routeById = new Map(routes.map((route) => [route.route_id, route]));
  const grouped = new Map();
  for (const record of records) {
    const id = executionId(record);
    if (!id) continue;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(record);
  }

  const byRoute = {};
  const byPool = {};
  const activeByPool = {};
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  // Pool meters are shared, so a before/after delta taken while another dispatch
  // on the same pool was running cannot be attributed to one route.
  const intervalsByPool = {};
  for (const groupedRecords of grouped.values()) {
    const routeId = routeIdForRecord(groupedRecords);
    const started = groupedRecords.find((record) => record.dispatch_status === 'started') || groupedRecords[0];
    const completed = groupedRecords.find((record) => record.dispatch_status === 'completed' || record.dispatch_status === 'launch_failed') || null;
    const poolName = canonicalPoolName(routeById.get(routeId)?.quota_pool || started?.quota_pool || null);
    if (!poolName) continue;
    const start = eventTime(started);
    if (start === null) continue;
    const end = completed ? (eventTime(completed) ?? nowMs) : nowMs;
    (intervalsByPool[poolName] ||= []).push({ id: executionId(started), start, end });
  }
  const overlapsSibling = (poolName, id, start, end) => (intervalsByPool[poolName] || [])
    .some((other) => other.id !== id && other.start < end && start < other.end);
  const activeByTask = new Map();
  for (const groupedRecords of grouped.values()) {
    const routeId = routeIdForRecord(groupedRecords);
    const route = routeById.get(routeId);
    const latest = groupedRecords[groupedRecords.length - 1];
    const started = groupedRecords.find((record) => record.dispatch_status === 'started') || groupedRecords[0];
    const completed = groupedRecords.find((record) => record.dispatch_status === 'completed' || record.dispatch_status === 'launch_failed') || null;
    const poolName = route?.quota_pool || started?.quota_pool || null;
    if (poolName && !completed) {
      const status = latest?.dispatch_status;
      const lastSeen = Math.max(...groupedRecords.map(eventTime).filter(finite));
      const live = typeof isActive === 'function'
        ? isActive(groupedRecords)
        : Number.isFinite(lastSeen) && nowMs - lastSeen <= ACTIVE_EXECUTION_MAX_AGE_HOURS * 3600000;
      if ((status === 'dispatched' || status === 'running') && live) {
        const canonical = poolName.startsWith('opencode_go') ? 'opencode_go' : poolName;
        const taskId = groupedRecords.find((record) => record?.task_id)?.task_id || executionId(latest);
        const previous = activeByTask.get(taskId);
        if (!previous || previous.lastSeen < lastSeen) activeByTask.set(taskId, { pool: canonical, lastSeen });
      }
    }
    if (!routeId || !completed) continue;

    const startedAt = eventTime(started);
    const completedAt = eventTime(completed);
    const observation = {
      success: completed.terminal_state === 'SUCCESS',
      failure: completed.terminal_state && completed.terminal_state !== 'SUCCESS',
      retry: Number(completed.retry_count ?? started.retry_count ?? 0) > 0,
      tokens: extractTokenUsage(completed) ?? extractTokenUsage(started),
      latency: startedAt !== null && completedAt !== null ? Math.max(0, (completedAt - startedAt) / 1000) : null,
      cache: extractCacheEfficiency(completed) ?? extractCacheEfficiency(started),
      quotaDelta: startedAt !== null && completedAt !== null &&
        overlapsSibling(canonicalPoolName(poolName), executionId(started), startedAt, completedAt)
        ? null
        : calculateObservedQuotaDelta(started.quota_snapshot_before, completed.quota_snapshot_after, poolName),
      timestamp: completedAt ?? startedAt ?? nowMs
    };
    if (!byRoute[routeId]) byRoute[routeId] = aggregateForRoute();
    addObservation(byRoute[routeId], observation);
    const canonical = poolName?.startsWith('opencode_go') ? 'opencode_go' : poolName;
    if (canonical) {
      if (!byPool[canonical]) byPool[canonical] = aggregateForRoute();
      addObservation(byPool[canonical], observation);
      if (observation.quotaDelta) {
        const quotaDelta = byPool[canonical].quotaDeltas[byPool[canonical].quotaDeltas.length - 1];
        quotaDelta.route_id = routeId;
        quotaDelta.expected_normalized_burn = route?.expected_normalized_burn;
        quotaDelta.timestamp = observation.timestamp;
      }
    }
  }
  for (const { pool } of activeByTask.values()) activeByPool[pool] = (activeByPool[pool] || 0) + 1;
  return { byRoute, byPool, activeByPool };
}

function readPoolWindows(pool, nowMs) {
  const result = {
    rolling: { percent_remaining: null, reset_at: null, hours_until_reset: null },
    weekly: { percent_remaining: null, reset_at: null, hours_until_reset: null },
    monthly: { percent_remaining: null, reset_at: null, hours_until_reset: null }
  };
  if (pool?._windows_fresh === false) return result;
  for (const [name, window] of Object.entries(pool?.windows || {})) {
    const kind = windowKind(name);
    if (!kind) continue;
    const remaining = remainingPercent(window);
    if (!finite(remaining)) continue;
    const reset = resetAt(window);
    const hours = resetHours(reset, nowMs);
    const current = result[kind];
    if (!finite(current.percent_remaining) || remaining < current.percent_remaining) {
      result[kind] = {
        percent_remaining: remaining,
        reset_at: reset,
        hours_until_reset: hours
      };
    }
  }
  return result;
}

export function computeBudgetPacing({ windows, recentBurnVelocity = 0, now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const perWindow = {};
  for (const [kind, data] of Object.entries(windows || {})) {
    const remaining = data?.percent_remaining;
    const horizon = WINDOW_HORIZONS_HOURS[kind];
    const hoursUntilReset = finite(data?.hours_until_reset)
      ? data.hours_until_reset
      : resetHours(data?.reset_at || data?.resetAt || data?.resetsAt, nowMs);
    const targetRemaining = finite(remaining) && finite(hoursUntilReset) && finite(horizon)
      ? clamp(100 * hoursUntilReset / horizon, 0, 100)
      : remaining;
    const surplus = finite(remaining) && finite(targetRemaining) ? remaining - targetRemaining : null;
    const sustainableBurnVelocity = finite(remaining) && finite(hoursUntilReset) && hoursUntilReset > 0
      ? remaining / hoursUntilReset
      : null;
    const pressure = finite(sustainableBurnVelocity) && sustainableBurnVelocity > 0
      ? recentBurnVelocity / sustainableBurnVelocity
      : null;
    perWindow[kind] = {
      actual_remaining: remaining,
      target_remaining: targetRemaining,
      surplus,
      pressure,
      sustainable_burn_velocity: sustainableBurnVelocity,
      hours_until_reset: hoursUntilReset,
      reset_at: data?.reset_at || null
    };
  }
  const values = Object.values(perWindow);
  const minimum = (key) => {
    const valid = values.map((value) => value[key]).filter(finite);
    return valid.length ? Math.min(...valid) : null;
  };
  const actualRemaining = minimum('actual_remaining');
  const targetRemaining = minimum('target_remaining');
  const surplus = minimum('surplus');
  const expiringSurplus = values.map((value) => value.surplus).filter(finite);
  const pressureValues = values.map((value) => value.pressure).filter(finite);
  const pressure = pressureValues.length ? Math.max(...pressureValues) : null;
  const resetHorizon = Math.min(...values.map((value) => value.hours_until_reset).filter(finite));
  return {
    now: new Date(nowMs).toISOString(),
    per_window: perWindow,
    actual_remaining: actualRemaining,
    target_remaining: targetRemaining,
    surplus,
    pressure: finite(pressure) ? pressure : 0,
    sustainable_burn_velocity: mean(values.map((value) => value.sustainable_burn_velocity).filter(finite)),
    reset_horizon_hours: Number.isFinite(resetHorizon) ? resetHorizon : null,
    // Unused-at-reset quota is bounded by the most binding window's surplus.
    expected_unused_quota_at_reset: expiringSurplus.length ? Math.max(0, Math.min(...expiringSurplus)) : null
  };
}

function recentVelocity(observations, nowMs) {
  const samples = (observations?.quotaDeltas || []).map((entry) => ({
    delta: entry.percent_points,
    timestamp: entry.timestamp
  })).filter((entry) => finite(entry.delta));
  if (!samples.length) return 0;
  const timestamps = samples.map((sample) => sample.timestamp).filter(finite);
  const oldest = timestamps.length ? Math.min(...timestamps) : nowMs;
  const hours = Math.max((nowMs - oldest) / 3600000, 1 / 60);
  return samples.reduce((sum, sample) => sum + sample.delta, 0) / hours;
}

function poolState(pool, pacing) {
  if (pool?._explicit_override && pool.scarcity_state) return pool.scarcity_state;
  const actuals = Object.values(pacing.per_window).map((window) => window.actual_remaining).filter(finite);
  if (!actuals.length) return 'UNKNOWN';
  let state = actuals.reduce((worst, remaining) => {
    const candidate = scarcityForRemaining(remaining);
    return POOL_SCARCITY_RANK[candidate] > POOL_SCARCITY_RANK[worst] ? candidate : worst;
  }, 'ABUNDANT');
  const useBeforeReset = Object.values(pacing.per_window).some((window) =>
    finite(window.hours_until_reset) && window.hours_until_reset <= 2 &&
    finite(window.actual_remaining) && window.actual_remaining > 30 &&
    finite(window.surplus) && window.surplus >= Math.max(5, window.actual_remaining * 0.1) &&
    (!finite(window.pressure) || window.pressure < 1.25)
  );
  // Expiring headroom is only spendable when no other window is behind pace;
  // otherwise the binding longer window caps what the reset would waste.
  const bindingSurplus = pacing.surplus;
  if (useBeforeReset && finite(bindingSurplus) && bindingSurplus > 0 && ['ABUNDANT', 'NORMAL'].includes(state)) state = 'USE_BEFORE_RESET';
  return state;
}

export function buildPoolEconomics({ pools = {}, observations = { byPool: {}, activeByPool: {} }, now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const output = {};
  for (const name of RESOURCE_POOLS) {
    const pool = pools[name] || {};
    const canonical = canonicalPoolName(name, pools);
    const poolObservation = observations.byPool?.[canonical] || aggregateForRoute();
    const velocity = finite(pool?.recent_burn_velocity)
      ? pool.recent_burn_velocity
      : recentVelocity(poolObservation, nowMs);
    const windows = readPoolWindows(pool, nowMs);
    const pacing = computeBudgetPacing({ windows, recentBurnVelocity: velocity, now });
    const active = finite(pool?.current_concurrency)
      ? pool.current_concurrency
      : (finite(pool?.active_concurrency) ? pool.active_concurrency : (observations.activeByPool?.[canonical] || 0));
    const maxConcurrency = pool?.max_concurrency ?? pool?.concurrency_limit ?? pool?.shared_concurrency ?? null;
    const latency = mean(poolObservation.latencyValues);
    const cacheEfficiency = mean(poolObservation.cacheValues);
    const actualTokenUsage = poolObservation.tokenValues.reduce((sum, value) => sum + value, 0);
    const poolBurnScale = poolCalibrationScale(poolObservation);
    const observedQuotaDeltaPercent = mean(poolObservation.quotaDeltas.map((entry) => entry.percent_points));
    const observedNormalizedQuotaConsumption = finite(poolBurnScale) && poolBurnScale > 0 && finite(observedQuotaDeltaPercent)
      ? observedQuotaDeltaPercent / poolBurnScale
      : null;
    const actualRemaining = pacing.actual_remaining;
    const projectedExhaustion = velocity > 0 && finite(actualRemaining) ? actualRemaining / velocity : null;
    const health = pool?.status === 'HEALTHY' && pool?._windows_fresh !== false ? 1 : (pool?.status === 'UNKNOWN' ? 0.5 : 0.25);
    output[name] = {
      resource_pool: name,
      account_pool: name === 'opencode_go' ? 'opencode_go' : (pool?.account_pool || name),
      shared_meter: name === 'opencode_go' || Boolean(pool?.account_pool),
      windows_fresh: pool?._windows_fresh !== false,
      windows,
      rolling_headroom_percent: windows.rolling.percent_remaining,
      weekly_headroom_percent: windows.weekly.percent_remaining,
      monthly_headroom_percent: windows.monthly.percent_remaining,
      rolling_reset_at: windows.rolling.reset_at,
      weekly_reset_at: windows.weekly.reset_at,
      monthly_reset_at: windows.monthly.reset_at,
      actual_remaining: actualRemaining,
      target_remaining: pacing.target_remaining,
      surplus: pacing.surplus,
      pressure: pacing.pressure,
      recent_burn_velocity: velocity,
      sustainable_burn_velocity: pacing.sustainable_burn_velocity,
      projected_exhaustion_hours: projectedExhaustion,
      reset_horizon_hours: pacing.reset_horizon_hours,
      expected_unused_quota_at_reset: pacing.expected_unused_quota_at_reset,
      current_concurrency: active,
      max_concurrency: maxConcurrency,
      latency_seconds: latency,
      cache_efficiency: cacheEfficiency,
      actual_token_usage: actualTokenUsage,
      actual_token_usage_observed: poolObservation.tokenValues.length > 0,
      observed_normalized_quota_consumption: observedNormalizedQuotaConsumption,
      observed_quota_delta_percent: observedQuotaDeltaPercent,
      route_health: health,
      scarcity_state: poolState(pool, pacing),
      source: pool?.source || null
    };
  }
  return output;
}

function poolCalibrationScale(poolObservation) {
  const ratios = (poolObservation?.quotaDeltas || [])
    .filter((entry) => finite(entry.percent_points) && finite(entry.expected_normalized_burn) && entry.expected_normalized_burn > 0)
    .map((entry) => entry.percent_points / entry.expected_normalized_burn);
  if (ratios.length < MIN_BURN_CALIBRATION_SAMPLES) return null;
  const scale = median(ratios);
  return finite(scale) && scale > 0 ? scale : null;
}

// Stage C compares routes across pools in normalized burn units.  Pool percent
// points are converted to those units through the pool calibration scale; each
// observation is bounded to a factor of the catalog burn and the median is shrunk
// toward the catalog value, so one noisy delta cannot dominate.
function routeObservationBurn(route, routeObservation, poolObservation) {
  const expected = finite(route?.expected_normalized_burn) && route.expected_normalized_burn > 0
    ? route.expected_normalized_burn
    : 1;
  const ownDeltas = (routeObservation?.quotaDeltas || []).map((entry) => entry.percent_points).filter(finite);
  const ownDelta = median(ownDeltas);
  const scale = poolCalibrationScale(poolObservation);
  if (finite(ownDelta) && finite(scale)) {
    const bounded = ownDeltas.map((delta) => clamp(delta / scale, expected / BURN_RATIO_BOUND, expected * BURN_RATIO_BOUND));
    const observedNormalized = median(bounded);
    const n = bounded.length;
    const normalized = (BURN_PRIOR_WEIGHT * expected + n * observedNormalized) / (BURN_PRIOR_WEIGHT + n);
    return {
      expected_quota_burn_per_attempt: normalized,
      observed_normalized_quota_consumption: observedNormalized,
      observed: true,
      calibrated: true,
      observation_count: n,
      observed_delta_percent: ownDelta
    };
  }
  return {
    expected_quota_burn_per_attempt: expected,
    observed_normalized_quota_consumption: null,
    observed: false,
    calibrated: finite(scale),
    observation_count: ownDeltas.length,
    observed_delta_percent: finite(ownDelta) ? ownDelta : null
  };
}

function defaultTokenUsage(route) {
  if (route?.reasoning_effort === 'low') return 8000;
  if (route?.reasoning_effort === 'high' || route?.reasoning_effort === 'xhigh' || route?.reasoning_effort === 'max') return 32000;
  return 16000;
}

export function buildRouteEconomics({
  route,
  capability = null,
  poolEconomics = {},
  observations = { byRoute: {}, byPool: {} },
  candidateBasis = 'real_evidence',
  successProbability = null,
  effortFitScore = 0,
  now = new Date()
} = {}) {
  const poolName = canonicalPoolName(route?.quota_pool, poolEconomics);
  const pool = poolEconomics[poolName] || poolEconomics[route?.quota_pool] || {};
  const routeObservation = observations.byRoute?.[route?.route_id] || aggregateForRoute();
  const poolObservation = observations.byPool?.[poolName] || aggregateForRoute();
  const probability = finite(successProbability)
    ? clamp(successProbability, 0.01, 0.999)
    : (finite(capability?.posterior_mean) ? clamp(capability.posterior_mean, 0.01, 0.999) : 0.5);
  const burn = routeObservationBurn(route, routeObservation, poolObservation);
  const expectedRetries = finite(capability?.expected_retries)
    ? capability.expected_retries
    : (1 - probability) / probability;
  const actualTokens = routeObservation.tokenValues.reduce((sum, value) => sum + value, 0);
  const expectedTokens = capability?.expected_token_usage ?? capability?.mean_tokens ?? route?.expected_token_usage ?? defaultTokenUsage(route);
  const latency = mean(routeObservation.latencyValues) ?? capability?.mean_latency_seconds ?? route?.latency_seconds ?? null;
  const cache = mean(routeObservation.cacheValues) ?? capability?.cache_efficiency ?? route?.cache_efficiency ?? null;
  const retryProbability = routeObservation.attempts > 0
    ? routeObservation.failures / routeObservation.attempts
    : 1 - probability;
  const headroom = pool.actual_remaining;
  const surplus = pool.surplus;
  const pressure = pool.pressure;
  const concurrencyRatio = finite(pool.max_concurrency) && pool.max_concurrency > 0
    ? clamp(pool.current_concurrency / pool.max_concurrency, 0, 2)
    : 0;
  const cost = burn.expected_quota_burn_per_attempt / probability;
  const pacingScore = finite(surplus) ? clamp(surplus / 100 - Math.max(0, pressure - 1) * 0.5, -1, 1) : 0;
  const exhaustionScore = finite(pool.projected_exhaustion_hours)
    ? clamp(pool.projected_exhaustion_hours / 168, 0, 1)
    : 0.5;
  const resetScore = finite(pool.reset_horizon_hours) ? clamp(1 - pool.reset_horizon_hours / (30 * 24), 0, 1) : 0.5;
  const unusedScore = finite(pool.expected_unused_quota_at_reset) ? clamp(pool.expected_unused_quota_at_reset / 100, 0, 1) : 0;
  const latencyScore = finite(latency) ? 1 / (1 + latency / 10) : 0.5;
  const concurrencyScore = 1 - clamp(concurrencyRatio, 0, 1);
  const retryScore = 1 - clamp(retryProbability, 0, 1);
  const explorationValue = candidateBasis === 'exploration' ? 0.06 : 0;
  const controlledConsumption = pool.scarcity_state === 'USE_BEFORE_RESET'
    ? clamp((pool.expected_unused_quota_at_reset || 0) / 100, 0, 0.15)
    : 0;
  const economicScore = Number((
    -1.4 * Math.min(cost / 10, 2) +
    0.45 * (finite(headroom) ? headroom / 100 : 0) +
    0.45 * pacingScore +
    0.25 * exhaustionScore +
    0.25 * unusedScore +
    0.15 * resetScore +
    0.20 * latencyScore +
    0.25 * concurrencyScore +
    0.30 * retryScore +
    0.35 * (pool.route_health ?? 0.5) +
    0.25 * effortFitScore +
    explorationValue +
    controlledConsumption
  ).toFixed(6));

  return {
    route_id: route?.route_id,
    resource_pool: poolName,
    account_pool: pool.account_pool || poolName,
    shared_meter: Boolean(pool.shared_meter),
    model_burn_multiplier: finite(route?.expected_normalized_burn) ? route.expected_normalized_burn : 1,
    task_success_probability: Number(probability.toFixed(6)),
    expected_retries: Number(expectedRetries.toFixed(6)),
    retry_probability: Number(retryProbability.toFixed(6)),
    expected_token_usage: Number(expectedTokens),
    actual_token_usage: actualTokens,
    actual_token_usage_observed: routeObservation.tokenValues.length > 0,
    expected_quota_burn_per_attempt: Number(burn.expected_quota_burn_per_attempt.toFixed(6)),
    observed_quota_delta_percent: burn.observed_delta_percent,
    observed_normalized_quota_consumption: burn.observed_normalized_quota_consumption === null
      ? null
      : Number(burn.observed_normalized_quota_consumption.toFixed(6)),
    expected_successful_quota_burn: Number(cost.toFixed(6)),
    rolling_headroom_percent: pool.rolling_headroom_percent ?? null,
    weekly_headroom_percent: pool.weekly_headroom_percent ?? null,
    monthly_headroom_percent: pool.monthly_headroom_percent ?? null,
    rolling_reset_at: pool.rolling_reset_at ?? null,
    weekly_reset_at: pool.weekly_reset_at ?? null,
    monthly_reset_at: pool.monthly_reset_at ?? null,
    actual_remaining: headroom,
    target_remaining: pool.target_remaining ?? null,
    surplus,
    pressure,
    recent_burn_velocity: pool.recent_burn_velocity ?? 0,
    projected_exhaustion_hours: pool.projected_exhaustion_hours ?? null,
    reset_horizon_hours: pool.reset_horizon_hours ?? null,
    expected_unused_quota_at_reset: pool.expected_unused_quota_at_reset ?? null,
    effort_fit_score: effortFitScore,
    current_concurrency: pool.current_concurrency ?? 0,
    max_concurrency: pool.max_concurrency ?? null,
    latency_seconds: latency,
    cache_efficiency: cache,
    exploration_value: explorationValue,
    controlled_consumption_bonus: controlledConsumption,
    route_health: pool.route_health ?? 0.5,
    scarcity_state: pool.scarcity_state || 'UNKNOWN',
    quota_evidence: finite(headroom) ? 'observed' : 'unknown_low_confidence',
    economic_score: economicScore,
    burn_observation_count: burn.observation_count,
    burn_evidence: burn.observed
      ? 'real_quota_delta'
      : (burn.observation_count > 0 ? 'insufficient_pool_calibration_samples' : 'catalog_expected_normalized_burn')
  };
}

export function selectEconomicRoute(candidates = []) {
  const sorted = [...candidates].sort((a, b) => {
    const scoreDelta = (b.economics?.economic_score ?? -Infinity) - (a.economics?.economic_score ?? -Infinity);
    if (scoreDelta) return scoreDelta;
    const costDelta = (a.economics?.expected_successful_quota_burn ?? Infinity) - (b.economics?.expected_successful_quota_burn ?? Infinity);
    if (costDelta) return costDelta;
    return String(a.route?.route_id || '').localeCompare(String(b.route?.route_id || ''));
  });
  return { winner: sorted[0] || null, ranked: sorted };
}
