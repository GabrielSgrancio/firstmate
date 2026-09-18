import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const attestation = await import('../bin/fm-model-attestation.mjs');
const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');

// attestRequestedVsActual: explicit-route contract.
assert.deepEqual(attestation.attestRequestedVsActual({ requested: 'kilo/x:free', actual: 'kilo/x:free' }).attestation, 'MATCH');
// provider-prefixed selector matching a bare runtime id is the same model.
assert.equal(attestation.attestRequestedVsActual({ requested: 'groq/openai/gpt-oss-120b', actual: 'openai/gpt-oss-120b' }).attestation, 'MATCH');
assert.equal(attestation.attestRequestedVsActual({ requested: 'groq/a', actual: 'groq/b' }).attestation, 'MISMATCH');
assert.equal(attestation.attestRequestedVsActual({ requested: 'groq/a', actual: 'groq/b' }).failure_attribution, 'MODEL_SUBSTITUTION');
assert.equal(attestation.attestRequestedVsActual({ requested: 'kilo-auto/free', actual: 'inclusionai/ling-3.0-flash-vl:free', autoRoute: true }).attestation, 'AUTO_ROUTE_RESOLVED');
assert.equal(attestation.attestRequestedVsActual({ requested: 'groq/a', actual: null }).attestation, 'NO_RUNTIME_RECORD');
assert.equal(attestation.attestRequestedVsActual({ requested: null, actual: 'whatever' }).attestation, 'UNATTESTED');

// runtime reader against a fixture opencode db (same table shape as
// ~/.local/share/opencode/opencode.db).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-attest-'));
const dbPath = path.join(tmp, 'opencode.db');
fs.writeFileSync(dbPath, '');
execFileSync('sqlite3', [dbPath,
  '' +
  "CREATE TABLE session (id text PRIMARY KEY, model text, directory text, time_created integer NOT NULL, tokens_input integer DEFAULT 0, tokens_output integer DEFAULT 0, tokens_reasoning integer DEFAULT 0, tokens_cache_read integer DEFAULT 0, tokens_cache_write integer DEFAULT 0);",
]);
execFileSync('sqlite3', [dbPath,
  "INSERT INTO session (id, model, directory, time_created, tokens_input, tokens_output, tokens_cache_read) VALUES ('ses_old','{\"id\":\"glm-5.3-flash\",\"providerID\":\"opencode-go\"}', '/ws/old', 1, 10, 20, 30);" +
  "INSERT INTO session (id, model, directory, time_created, tokens_input, tokens_output) VALUES ('ses_new','{\"id\":\"groq/compound\",\"providerID\":\"groq\"}', '/ws/new', 2, 40, 1);" +
  "INSERT INTO session (id, model, directory, time_created) VALUES ('ses_plain','opencode-go/mimo-v2.5', '/ws/plain', 3);"
]);
const openaiSession = attestation.readOpencodeSessionAt({ directory: '/ws/new', dbPath });
assert.equal(openaiSession.session_id, 'ses_new');
assert.equal(openaiSession.actual_model, 'groq/groq/compound');
assert.equal(openaiSession.tokens.input, 40);
const plainSession = attestation.readOpencodeSessionAt({ directory: '/ws/plain', dbPath });
assert.equal(plainSession.actual_model, 'opencode-go/mimo-v2.5');
const absent = attestation.readOpencodeSessionAt({ directory: '/ws/none', dbPath });
assert.equal(absent, null);
const sinceFiltered = attestation.readOpencodeSessionAt({ directory: '/ws/new', dbPath, sinceTs: 9e15 });
assert.equal(sinceFiltered, null);
// a missing sqlite binary degrades to no record, never a crash.
const degraded = attestation.readOpencodeSessionAt({ directory: '/ws/new', dbPath, sqlite3Bin: 'definitely-not-sqlite3' });
assert.equal(degraded, null);

// provider config builder
const builderPath = path.join(ROOT, 'bin', 'fm-opencode-provider-config.mjs');
const catalogPath = path.join(tmp, 'opencode-custom-providers.json');
fs.writeFileSync(catalogPath, JSON.stringify({
  npm_package: '@ai-sdk/openai-compatible',
  providers: {
    kilo: { catalog: 'kilo', baseURL: 'https://api.kilo.ai/api/gateway/v1', api_key_env: 'KILO_API_KEY', models: { 'kilo-auto/free': { name: 'auto' } } }
  }
}));
const out = execFileSync(process.execPath, [builderPath, '--model', 'kilo/kilo-auto/free', '--config', catalogPath], { encoding: 'utf8' });
const permitConfig = JSON.parse(out);
assert.equal(permitConfig.provider.kilo.options.apiKey, '{env:KILO_API_KEY}', 'config carries an env REFERENCE, never a secret value');
assert.ok(!out.includes(process.env.KILO_API_KEY || '_definitely_not_a_key_'), 'no literal key material in emitted config');
const fallback = JSON.parse(execFileSync(process.execPath, [builderPath, '--model', 'opencode-go/mimo-v2.5', '--config', catalogPath], { encoding: 'utf8' }));
assert.ok(fallback.permission && !fallback.provider, 'subscription selectors get the plain permission config');
let driftedError = null;
try {
  execFileSync(process.execPath, [builderPath, '--model', 'kilo/absent-model', '--config', catalogPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  driftedError = error;
}
assert.ok(driftedError, 'a model absent from the provider catalog fails loudly (exit 2)');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('attestation and provider-config regressions passed');
