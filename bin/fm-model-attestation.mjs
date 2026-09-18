#!/usr/bin/env node
// Requested->actual model attestation (correction pass item 4).
//
// The runtime identity invariant: a route that requested an explicit model must
// not silently record success against that model when the harness/provider
// actually served a different one.  Sources of the ACTUAL model:
//
// - opencode stock session storage: ~/.local/share/opencode/opencode.db
//   (`session` row carries `model` = providerID/modelID, `directory` = the
//   worktree the session ran in, and the blocks of per-session tokens).
// - completion probes: response body `model`/`provider` fields.
// - kilo-auto/free and other auto routes: substitution is by design; the actual
//   resolved model is recorded and outcome evidence is attributed to the
//   actual model (never auto_routes: attribution re-key).
//
// No SECRET data is read; only local runtime session/bookkeeping records.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const ATTESTATION_STATES = Object.freeze({
  MATCH: 'MATCH',
  MISMATCH: 'MISMATCH',
  AUTO_ROUTE_RESOLVED: 'AUTO_ROUTE_RESOLVED',
  UNATTESTED: 'UNATTESTED',
  NO_RUNTIME_RECORD: 'NO_RUNTIME_RECORD'
});

function defaultOpencodeDb() {
  return path.join(os.homedir(), '.local/share/opencode/opencode.db');
}

function resolveSessionModel(rawValue) {
  if (typeof rawValue === 'string' && rawValue.includes('/') && !rawValue.trim().startsWith('{')) {
    return rawValue.trim();
  }
  try {
    const parsed = typeof rawValue === 'object' ? rawValue : JSON.parse(rawValue);
    if (parsed && typeof parsed === 'object' && parsed.id) {
      return parsed.providerID ? `${parsed.providerID}/${parsed.id}` : String(parsed.id);
    }
  } catch {
    // fall through
  }
  return null;
}

export function parseModelSelector(model) {
  if (!model || typeof model !== 'string') return { provider: null, model_id: null };
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return { provider: null, model_id: model };
  return { provider: model.slice(0, slash), model_id: model.slice(slash + 1) };
}

// Consult the runtime storage of a dispatch route and return attestation data.
// `requested` is the model selector the router dispatched (`provider/model` as
// seen by the harness); `actual` is whatever the runtime recorded.  Routes
// flagged `auto_route` expect a substitution; evidence must then be attributed
// to the actual model.
export function attestRequestedVsActual({
  requested,
  actual,
  autoRoute = false,
  recorded = null
} = {}) {
  if (!requested) {
    return { attestation: 'UNATTESTED', requested_model: requested, actual_model: actual ?? null };
  }
  if (!actual) {
    return { attestation: 'NO_RUNTIME_RECORD', requested_model: requested, actual_model: null };
  }
  if (autoRoute) {
    return {
      attestation: 'AUTO_ROUTE_RESOLVED',
      requested_model: requested,
      actual_model: actual,
      attribution_route_hint: actual
    };
  }
  const match = String(actual).trim().toLowerCase() === String(requested).trim().toLowerCase() ||
    // The same selector with provider prefix removed still names the same model
    // (opencode db stores providerID/modelID; fm-spawn passes provider/model).
    (parseRequestedEndsWith(requested, actual) === true);
  if (match) {
    return { attestation: 'MATCH', requested_model: requested, actual_model: actual };
  }
  return {
    attestation: 'MISMATCH',
    requested_model: requested,
    actual_model: actual,
    failure_attribution: 'MODEL_SUBSTITUTION'
  };
}

function parseRequestedEndsWith(requested, actual) {
  const { model_id } = parseModelSelector(requested);
  return model_id !== null && String(actual).trim() === String(model_id).trim();
}

// Reads the model the opencode client actually served for sessions rooted at
// `directory` (a task worktree).  Returns the newest matching session.
export function readOpencodeSessionAt({ directory, dbPath = null, sinceTs = null, sqlite3Bin = 'sqlite3' } = {}) {
  const resolvedDb = dbPath || defaultOpencodeDb();
  if (!fs.existsSync(resolvedDb)) return null;
  const dirReal = path.resolve(directory);
  const query =
    "SELECT id, directory, model, time_created, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE directory = '" +
    dirReal.replace(/'/g, "''") +
    "' ORDER BY time_created DESC LIMIT 8";
  let stdout;
  try {
    stdout = execFileSync(sqlite3Bin, [resolvedDb, '-json', query], { timeout: 5000, encoding: 'utf8' });
  } catch {
    return null; // sqlite CLI unavailable/failing is not an attestation-failure signal
  }
  let rows = null;
  try {
    rows = stdout.trim() ? JSON.parse(stdout) : [];
  } catch {
    return null;
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const timestampMs = Number(row.time_created);
    if (sinceTs !== null && Number.isFinite(sinceTs) && Number.isFinite(timestampMs) && timestampMs < sinceTs) {
      continue;
    }
    if (!row.model) continue;
    // The session model column stores either a plain "providerID/modelID"
    // selector or a serialized {"id","providerID"} object depending on client
    // version; accept both shapes.
    const actualModel = resolveSessionModel(row.model);
    if (!actualModel) continue;
    return {
      source: 'opencode_db',
      session_id: row.id,
      directory: row.directory,
      actual_model: actualModel,
      tokens: {
        input: row.tokens_input,
        output: row.tokens_output,
        reasoning: row.tokens_reasoning,
        cache_read: row.tokens_cache_read,
        cache_write: row.tokens_cache_write
      }
    };
  }
  return null;
}

// CLI: attest a task by its recorded spawn metadata.
if (process.argv[1] && path.basename(process.argv[1]) === 'fm-model-attestation.mjs') {
  const args = process.argv.slice(2);
  if (args[0] === 'attest') {
    const flags = {};
    for (let i = 1; i < args.length; i++) {
      const withValue = args[i].match(/^--([\w][\w-]*)=(.*)$/);
      if (withValue) { flags[withValue[1]] = withValue[2]; continue; }
      const flagOnly = args[i].match(/^--([\w][\w-]*)$/);
      if (flagOnly && args[i + 1] && !args[i + 1].startsWith('--')) {
        flags[flagOnly[1]] = args[i + 1];
        i += 1;
        continue;
      }
      if (flagOnly) flags[flagOnly[1]] = true;
    }
    const requested = flags.requested || '';
    const source = readOpencodeSessionAt({
      directory: typeof flags.directory === 'string' ? flags.directory : process.cwd(),
      sinceTs: flags.since ? Number(flags.since) : null
    });
    const decision = attestRequestedVsActual({
      requested,
      actual: source?.actual_model ?? null,
      autoRoute: flags.auto === 'true' || flags.auto === true
    });
    if (source?.tokens) decision.tokens = source.tokens;
    decision.session = source?.session_id ?? null;
    console.log(JSON.stringify(decision, null, 2));
  } else {
    console.error('usage: fm-model-attestation.mjs attest --requested <model> [--directory <dir>] [--auto true]');
    process.exit(2);
  }
}
