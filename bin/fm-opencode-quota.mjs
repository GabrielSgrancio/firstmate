#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FM_HOME = path.resolve(process.env.FM_HOME || ROOT);
const SNAPSHOT_PATH = path.join(FM_HOME, 'data/opencode-go-usage-snapshot.json');
const AUTH_PATH = path.join(process.env.HOME || '', '.local/share/opencode/auth.json');

/**
 * Derives the most restrictive scarcity state across rolling_5h, weekly, and monthly windows.
 * States: EXHAUSTED | CRITICAL | CONSERVE | USE_BEFORE_RESET | NORMAL | ABUNDANT | UNKNOWN
 */
export function deriveScarcityState(normalized) {
  if (!normalized || normalized.scarcity_state === 'UNKNOWN' ||
      !normalized.rolling_5h || !normalized.weekly || !normalized.monthly) {
    return 'UNKNOWN';
  }

  const windows = [
    { name: 'rolling_5h', data: normalized.rolling_5h },
    { name: 'weekly', data: normalized.weekly },
    { name: 'monthly', data: normalized.monthly }
  ];

  let worstState = 'ABUNDANT';
  const severityRank = {
    EXHAUSTED: 6,
    CRITICAL: 5,
    CONSERVE: 4,
    USE_BEFORE_RESET: 3,
    NORMAL: 2,
    ABUNDANT: 1,
    UNKNOWN: 4 // UNKNOWN is treated conservatively as CONSERVE
  };

  for (const w of windows) {
    if (!w.data) continue;
    const remaining = w.data.percent_remaining ??
      (typeof w.data.percent_used === 'number' ? 100 - w.data.percent_used : null);
    if (remaining === null || !Number.isFinite(remaining)) {
      return 'UNKNOWN';
    }
    let state = 'ABUNDANT';

    if (remaining <= 0) {
      state = 'EXHAUSTED';
    } else if (remaining <= 10) {
      state = 'CRITICAL';
    } else if (remaining <= 25) {
      state = 'CONSERVE';
    } else if (remaining <= 50) {
      state = 'NORMAL';
    } else {
      state = 'ABUNDANT';
    }

    if (severityRank[state] > severityRank[worstState]) {
      worstState = state;
    }
  }

  return worstState;
}

/**
 * Queries the authoritative GET https://opencode.ai/zen/go/v1/usage endpoint.
 * Source Precedence:
 * 1. /zen/go/v1/usage (authoritative server-side quota)
 * 2. last-known-good API snapshot (if endpoint fails: stale=true, source=last_known_good)
 * 3. local opencode.db / session accounting (estimation/diagnostic only)
 * 4. UNKNOWN (if no authoritative or cached state exists)
 */
export async function fetchOpenCodeGoQuota({ timeoutMs = 8000 } = {}) {
  let apiKey = null;
  if (fs.existsSync(AUTH_PATH)) {
    try {
      const auth = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
      apiKey = auth['opencode-go']?.key || auth['opencode']?.key || null;
    } catch (e) {
      // Auth file parse error
    }
  }

  if (!apiKey) {
    return loadSnapshotFallback('No OpenCode Go credential found in ~/.local/share/opencode/auth.json');
  }

  return new Promise((resolve) => {
    let timer = setTimeout(() => {
      req.destroy();
      resolve(loadSnapshotFallback('Request timed out'));
    }, timeoutMs);

    const req = https.request('https://opencode.ai/zen/go/v1/usage', {
      method: 'GET',
      headers: {
        'User-Agent': 'opencode/1.18.30 (linux; x64)',
        'Authorization': `Bearer ${apiKey}`
      }
    }, (res) => {
      clearTimeout(timer);
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const raw = JSON.parse(body);
            const usage = raw.usage || {};
            const normalized = normalizeUsageResponse(usage, false, 'opencode_go_usage_api');
            // Persist as last-known-good snapshot
            fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
            fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(normalized, null, 2));
            resolve(normalized);
          } catch (e) {
            resolve(loadSnapshotFallback(`Failed to parse usage JSON: ${e.message}`));
          }
        } else {
          resolve(loadSnapshotFallback(`API returned status ${res.statusCode}`));
        }
      });
    });

    req.on('error', (e) => {
      clearTimeout(timer);
      resolve(loadSnapshotFallback(`Network error: ${e.message}`));
    });

    req.end();
  });
}

export function normalizeUsageResponse(usage, isStale = false, source = 'opencode_go_usage_api') {
  const rolling = usage.rolling || {};
  const weekly = usage.weekly || {};
  const monthly = usage.monthly || {};

  const validPercent = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  const rollingUsed = validPercent(rolling.percent) ? rolling.percent : null;
  const weeklyUsed = validPercent(weekly.percent) ? weekly.percent : null;
  const monthlyUsed = validPercent(monthly.percent) ? monthly.percent : null;

  const normalized = {
    provider: 'opencode_go',
    pool: 'opencode_go',
    rolling_5h: {
      percent_used: rollingUsed,
      percent_remaining: rollingUsed === null ? null : 100 - rollingUsed,
      status: rolling.status || 'ok',
      reset_at: rolling.resetsAt || null
    },
    weekly: {
      percent_used: weeklyUsed,
      percent_remaining: weeklyUsed === null ? null : 100 - weeklyUsed,
      status: weekly.status || 'ok',
      reset_at: weekly.resetsAt || null
    },
    monthly: {
      percent_used: monthlyUsed,
      percent_remaining: monthlyUsed === null ? null : 100 - monthlyUsed,
      status: monthly.status || 'ok',
      reset_at: monthly.resetsAt || null
    },
    source,
    fetched_at: new Date().toISOString(),
    stale: isStale,
    confidence: isStale ? 'medium' : 'high'
  };

  normalized.scarcity_state = deriveScarcityState(normalized);
  return normalized;
}

export function loadSnapshotFallback(reason) {
  if (fs.existsSync(SNAPSHOT_PATH)) {
    try {
      const snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
      snap.stale = true;
      snap.source = 'last_known_good';
      snap.fallback_reason = reason;
      snap.confidence = 'medium';
      snap.scarcity_state = deriveScarcityState(snap);
      return snap;
    } catch (e) {
      // Corrupt snapshot
    }
  }

  // Precedence 4: UNKNOWN (never ABUNDANT)
  return {
    provider: 'opencode_go',
    pool: 'opencode_go',
    scarcity_state: 'UNKNOWN',
    rolling_5h: null,
    weekly: null,
    monthly: null,
    source: 'none',
    stale: true,
    confidence: 'low',
    fallback_reason: reason
  };
}

// CLI test / diagnostic execution
if (process.argv[1] && process.argv[1].endsWith('fm-opencode-quota.mjs')) {
  (async () => {
    const quota = await fetchOpenCodeGoQuota();
    // Sanitize: confirm no key or auth tokens
    const output = JSON.stringify(quota, null, 2);
    if (output.includes('key') || output.includes('Bearer')) {
      console.error('SECURITY ERROR: Key detected in normalized quota output!');
      process.exit(1);
    }
    console.log(output);
  })();
}
