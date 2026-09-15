#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/*
 * Context Broker V1 is the provider-neutral boundary between repository tools
 * and a premium reasoner.
 *
 * Callers submit one operation through requestContext().
 * The broker classifies it, extracts deterministic evidence first, optionally
 * selects a context worker through the supplied Router V2 selector, and emits
 * a compact ContextPack with replayable provenance.
 *
 * The default token counter is an exact count for the broker's lexical context
 * metric, not a provider billing prediction.
 * A provider adapter may supply tokenCounter when provider-token accounting is
 * available.
 */

export const CONTEXT_BROKER_VERSION = 'wp7-v1';

export const CONTEXT_LIMITS = Object.freeze({
  directReadTokens: 12000,
  directAggregateTokens: 16000,
  directOutputTokens: 8000,
  maxEvidenceLines: 180,
  maxLineChars: 1200,
  maxSummaryTokens: 6000,
  maxCommandOutputBytes: 2 * 1024 * 1024
});

const HEAVY_SOURCE_OPERATIONS = new Set([
  'oversized_file_read',
  'large_multi_file_read',
  'broad_repository_scan',
  'large_symbol_reference_search'
]);

const DETERMINISTIC_OUTPUT_OPERATIONS = new Set([
  'giant_grep_output',
  'huge_test_output',
  'huge_build_output',
  'repetitive_logs'
]);

const OPERATION_ALIASES = Object.freeze({
  read: 'read',
  file_read: 'read',
  multi_read: 'large_multi_file_read',
  scan: 'broad_repository_scan',
  repository_scan: 'broad_repository_scan',
  grep: 'giant_grep_output',
  ripgrep: 'giant_grep_output',
  references: 'large_symbol_reference_search',
  symbols: 'large_symbol_reference_search',
  test: 'huge_test_output',
  tests: 'huge_test_output',
  build: 'huge_build_output',
  log: 'repetitive_logs',
  logs: 'repetitive_logs',
  generated: 'generated_boilerplate',
  artifact: 'generated_boilerplate'
});

function finite(value) {
  return Number.isFinite(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function jsonHash(value) {
  return sha256(JSON.stringify(value));
}

function lexicalTokenCount(value) {
  const text = String(value ?? '');
  if (!text) return 0;
  const units = text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu);
  return units ? units.length : 0;
}

function makeTokenCounter(counter) {
  if (typeof counter !== 'function') return lexicalTokenCount;
  return (value) => {
    const result = counter(String(value ?? ''));
    if (!finite(result) || result < 0) throw new Error('tokenCounter must return a non-negative finite number');
    return Math.round(result);
  };
}

function normalizedRepoDir(repoDir) {
  return path.resolve(repoDir || process.cwd());
}

function relativePath(repoDir, filePath) {
  const relative = path.relative(repoDir, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : filePath;
}

function resolveRepoPath(repoDir, input, label = 'path') {
  if (typeof input !== 'string' || !input) throw new Error(`${label} is required`);
  const resolved = path.resolve(repoDir, input);
  const relative = path.relative(repoDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the repository root: ${input}`);
  }
  return resolved;
}

function commandOutput(repoDir, command, args) {
  const result = spawnSync(command, args, {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: CONTEXT_LIMITS.maxCommandOutputBytes
  });
  if (result.error && !result.stdout) return { output: '', error: result.error.message };
  return {
    output: String(result.stdout || ''),
    error: result.status === 0 ? null : String(result.stderr || result.error?.message || '').trim() || `exit ${result.status}`
  };
}

function repoCommand(repoDir, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return null;
  }
}

function repoState(repoDir) {
  const repoSha = repoCommand(repoDir, ['rev-parse', 'HEAD']);
  const status = repoCommand(repoDir, ['status', '--porcelain=v1', '--untracked-files=all']) || '';
  return {
    repo_sha: repoSha,
    workspace_state_hash: sha256(status),
    dirty: Boolean(status),
    status_summary: status.split('\n').filter(Boolean).slice(0, 80)
  };
}

function operationFromRequest(request = {}) {
  if (request.generatedContent !== undefined || request.artifactPath) return 'generated_boilerplate';
  if (request.operation) {
    const normalized = String(request.operation).trim().toLowerCase().replace(/[ -]+/g, '_');
    return OPERATION_ALIASES[normalized] || normalized;
  }
  if (request.command) {
    const command = String(request.command).toLowerCase();
    if (/\b(rg|ripgrep|grep)\b/.test(command)) return 'giant_grep_output';
    if (/\b(test|pytest|vitest|jest|npm\s+run\s+test)\b/.test(command)) return 'huge_test_output';
    if (/\b(build|compile|tsc|make)\b/.test(command)) return 'huge_build_output';
    if (/\b(log|journal|tail)\b/.test(command)) return 'repetitive_logs';
  }
  if (Array.isArray(request.paths) && request.paths.length > 1) return 'large_multi_file_read';
  return 'read';
}

function explicitRange(request) {
  const candidate = request.lineRange || request.range;
  if (!candidate) return null;
  const start = Number(candidate.start ?? candidate.startLine ?? 1);
  const end = Number(candidate.end ?? candidate.endLine ?? start);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error('lineRange must contain positive integer start/end lines');
  }
  return { start, end };
}

function sourcePathForRequest(request) {
  return request.filePath || request.path || request.name || '<request>';
}

function readSource(repoDir, filePath, lineRange = null) {
  const absolute = resolveRepoPath(repoDir, filePath, 'file path');
  const bytes = fs.readFileSync(absolute);
  const content = bytes.toString('utf8');
  const display = relativePath(repoDir, absolute);
  const lines = content.split('\n');
  const selected = lineRange
    ? lines.slice(lineRange.start - 1, lineRange.end).join('\n')
    : content;
  return {
    path: display,
    absolutePath: absolute,
    content,
    selectedContent: selected,
    source_hash: sha256(bytes),
    token_count: lexicalTokenCount(content),
    command: null
  };
}

function collectSources(request, repoDir, operation) {
  const range = explicitRange(request);
  const sources = [];
  const commands = [];

  if (request.content !== undefined) {
    const content = String(request.content);
    sources.push({
      path: sourcePathForRequest(request),
      absolutePath: null,
      content,
      selectedContent: range ? content.split('\n').slice(range.start - 1, range.end).join('\n') : content,
      source_hash: sha256(content),
      token_count: lexicalTokenCount(content),
      command: null
    });
  } else if (request.output !== undefined) {
    const content = String(request.output);
    sources.push({
      path: request.outputPath || '<command-output>',
      absolutePath: null,
      content,
      selectedContent: content,
      source_hash: sha256(content),
      token_count: lexicalTokenCount(content),
      command: request.command || null
    });
  } else {
    const paths = Array.isArray(request.paths) && request.paths.length > 0
      ? request.paths
      : (request.filePath || request.path ? [request.filePath || request.path] : []);
    for (const filePath of paths) {
      const source = readSource(repoDir, filePath, paths.length === 1 ? range : null);
      sources.push(source);
    }
  }

  if (sources.length === 0 && operation === 'broad_repository_scan') {
    const listed = commandOutput(repoDir, 'git', ['ls-files', '-z']);
    commands.push('git ls-files -z');
    const files = listed.output.split('\0').filter(Boolean);
    for (const file of files) {
      sources.push({
        path: file,
        absolutePath: path.join(repoDir, file),
        content: '',
        selectedContent: '',
        source_hash: null,
        token_count: lexicalTokenCount(file),
        command: 'git ls-files -z'
      });
    }
  }

  if (sources.length === 0 && (operation === 'giant_grep_output' || operation === 'large_symbol_reference_search') && request.query) {
    const result = commandOutput(repoDir, 'rg', ['--no-heading', '--line-number', '--color=never', '--hidden', '--glob', '!.git', '--fixed-strings', String(request.query), '.']);
    commands.push(`rg --no-heading --line-number --color=never --hidden --glob !.git --fixed-strings ${String(request.query)}`);
    sources.push({
      path: '<rg-output>',
      absolutePath: null,
      content: result.output,
      selectedContent: result.output,
      source_hash: sha256(result.output),
      token_count: lexicalTokenCount(result.output),
      command: commands.at(-1),
      command_error: result.error
    });
  }

  if (request.commandOutputCommand && request.commandOutputArgs) {
    const result = commandOutput(repoDir, request.commandOutputCommand, request.commandOutputArgs);
    commands.push([request.commandOutputCommand, ...request.commandOutputArgs].join(' '));
    sources.push({
      path: request.outputPath || '<command-output>',
      absolutePath: null,
      content: result.output,
      selectedContent: result.output,
      source_hash: sha256(result.output),
      token_count: lexicalTokenCount(result.output),
      command: commands.at(-1),
      command_error: result.error
    });
  }

  return { sources, commands, range };
}

function classifyContextOperation(request, rawTokenCount = null) {
  const requestedOperation = operationFromRequest(request);
  const raw = finite(rawTokenCount)
    ? rawTokenCount
    : lexicalTokenCount(request.content ?? request.output ?? request.query ?? '');
  const range = explicitRange(request);
  const targeted = requestedOperation === 'read' && range && range.end - range.start < 120;
  const oversized = raw > CONTEXT_LIMITS.directReadTokens;
  const aggregateLarge = raw > CONTEXT_LIMITS.directAggregateTokens;
  const outputLarge = raw > CONTEXT_LIMITS.directOutputTokens;
  const operation = requestedOperation === 'read' && oversized && !targeted ? 'oversized_file_read' : requestedOperation;
  let intercepted = false;
  if (operation === 'read') intercepted = oversized && !targeted;
  else if (operation === 'large_multi_file_read') intercepted = aggregateLarge;
  else if (DETERMINISTIC_OUTPUT_OPERATIONS.has(operation)) intercepted = outputLarge;
  else if (HEAVY_SOURCE_OPERATIONS.has(operation)) intercepted = true;
  else if (operation === 'generated_boilerplate') intercepted = true;

  const requiresShunt = request.forceDirect === true
    ? false
    : request.forceShunt === true ||
      (HEAVY_SOURCE_OPERATIONS.has(operation) && operation !== 'broad_repository_scan' && intercepted) ||
      (operation === 'broad_repository_scan' && request.interpretationNeeded === true && intercepted) ||
      (DETERMINISTIC_OUTPUT_OPERATIONS.has(operation) && request.interpretationNeeded === true && intercepted);

  return {
    operation,
    rawTokenCount: raw,
    intercepted,
    requiresShunt,
    targeted,
    reason: targeted
      ? 'Targeted source range remains direct'
      : intercepted
        ? `Operation exceeds the ${operation === 'read' ? CONTEXT_LIMITS.directReadTokens : CONTEXT_LIMITS.directOutputTokens}-token direct-context bound`
        : 'Operation is within the direct-context bound'
  };
}

function queryTerms(query) {
  return [...new Set(String(query || '').toLowerCase().match(/[a-z][a-z0-9_/-]{2,}/g) || [])]
    .filter((term) => !new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'read', 'file']).has(term))
    .slice(0, 12);
}

function sourceLines(content) {
  return String(content || '').split('\n');
}

function trimLine(line) {
  const text = String(line || '').trimEnd();
  return text.length > CONTEXT_LIMITS.maxLineChars ? `${text.slice(0, CONTEXT_LIMITS.maxLineChars)}...` : text;
}

function symbolMatches(line) {
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(.*\)\s*\{/,
    /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/
  ];
  for (const pattern of patterns) {
    const match = String(line).match(pattern);
    if (match) return match[1];
  }
  return null;
}

function addRange(ranges, source, start, end, reason) {
  ranges.push({
    path: source.path,
    start_line: start,
    end_line: end,
    source_hash: source.source_hash,
    why: reason
  });
}

function deterministicExtraction({ sources, operation, query, range, tokenCounter }) {
  const terms = queryTerms(query);
  const findings = [];
  const relevantFiles = [];
  const relevantSymbols = [];
  const relevantRanges = [];
  const evidenceLines = [];
  let directText = null;
  let matchedAny = false;

  if (operation === 'generated_boilerplate') {
    findings.push({ kind: 'generated_artifact', summary: 'Generated content is written directly to the requested artifact.' });
  }

  for (const source of sources) {
    if (!source.content && operation === 'broad_repository_scan') {
      const pathMatch = terms.length === 0 || terms.some((term) => source.path.toLowerCase().includes(term));
      if (pathMatch) {
        matchedAny = true;
        relevantFiles.push(source.path);
        findings.push({ kind: 'file_inventory', summary: `${source.path} matches the repository query.`, path: source.path });
      }
      continue;
    }
    if (!source.content) continue;

    const lines = sourceLines(source.selectedContent ?? source.content);
    const fullLines = sourceLines(source.content);
    const isDirect = operation === 'read' && (source.token_count <= CONTEXT_LIMITS.directReadTokens ||
      (range && range.end - range.start < 120));
    if (isDirect) {
      directText = source.selectedContent;
      relevantFiles.push(source.path);
      const directRange = range || { start: 1, end: sourceLines(source.content).length };
      addRange(relevantRanges, source, directRange.start, directRange.end, range
        ? 'Caller supplied an exact targeted range.'
        : 'Small source read remains direct within the broker bound.');
      findings.push({ kind: 'direct_source', path: source.path, range: { start_line: directRange.start, end_line: directRange.end }, text: source.selectedContent });
      matchedAny = true;
      continue;
    }

    const matches = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const lower = line.toLowerCase();
      const queryMatch = terms.length === 0 || terms.some((term) => lower.includes(term));
      const outputMatch = DETERMINISTIC_OUTPUT_OPERATIONS.has(operation) &&
        /error|failed|failure|fatal|exception|panic|warning|assert|not ok|timed? out|\bFAIL\b/i.test(line);
      const symbol = symbolMatches(line);
      if (queryMatch || outputMatch) {
        matches.push({ index, line, symbol });
        matchedAny = true;
      }
      if (symbol && (queryMatch || operation === 'large_symbol_reference_search')) {
        relevantSymbols.push({ path: source.path, name: symbol, line: index + 1, source_hash: source.source_hash, why: 'Deterministically identified symbol near the query match.' });
      }
    }

    if (matches.length > 0) {
      relevantFiles.push(source.path);
      const seenRanges = new Set();
      for (const match of matches.slice(0, 80)) {
        const start = Math.max(1, match.index + 1 - 2);
        const end = Math.min(fullLines.length, match.index + 3);
        const rangeKey = `${start}:${end}`;
        if (!seenRanges.has(rangeKey)) {
          seenRanges.add(rangeKey);
          addRange(relevantRanges, source, start, end, 'Deterministic query/error match with a two-line context window.');
        }
        evidenceLines.push(`${source.path}:${match.index + 1}: ${trimLine(match.line)}`);
      }
    } else if (source.token_count > CONTEXT_LIMITS.directReadTokens && operation === 'read') {
      relevantFiles.push(source.path);
      const symbolLines = fullLines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => symbolMatches(line))
        .slice(0, 40);
      for (const entry of symbolLines) {
        addRange(relevantRanges, source, entry.index + 1, entry.index + 1, 'Deterministic symbol outline for an oversized source file.');
        evidenceLines.push(`${source.path}:${entry.index + 1}: ${trimLine(entry.line)}`);
      }
      if (symbolLines.length === 0) {
        addRange(relevantRanges, source, 1, Math.min(fullLines.length, 40), 'Deterministic bounded file outline for an oversized source file.');
        evidenceLines.push(`${source.path}:1-${Math.min(fullLines.length, 40)}: bounded file outline`);
      }
    }

    if (operation === 'large_symbol_reference_search' && source.command_error) {
      findings.push({ kind: 'command_error', summary: source.command_error, path: source.path });
    }
  }

  const uniqueFiles = [...new Set(relevantFiles)];
  const uniqueEvidence = [...new Set(evidenceLines)].slice(0, CONTEXT_LIMITS.maxEvidenceLines);
  if (operation === 'giant_grep_output' || DETERMINISTIC_OUTPUT_OPERATIONS.has(operation)) {
    const totalLines = sources.reduce((count, source) => count + sourceLines(source.content).length, 0);
    const selectedLines = uniqueEvidence.length;
    findings.unshift({
      kind: 'deterministic_output_condensation',
      summary: `Kept ${selectedLines} signal lines from ${totalLines} output lines using stable error/failure/warning filters and de-duplication.`
    });
  }
  if (!matchedAny && sources.length > 0 && operation !== 'generated_boilerplate') {
    findings.push({ kind: 'no_match', summary: 'No deterministic query or failure signal matched; unresolved interpretation may require a context worker.' });
  }
  if (uniqueEvidence.length > 0) {
    findings.push({ kind: 'evidence_lines', lines: uniqueEvidence });
  }

  const deterministicText = [
    ...findings.map((finding) => finding.summary || finding.text || finding.lines?.join('\n') || ''),
    ...uniqueEvidence
  ].filter(Boolean).join('\n');
  return {
    findings,
    relevantFiles: uniqueFiles,
    relevantSymbols,
    relevantRanges: relevantRanges.slice(0, CONTEXT_LIMITS.maxEvidenceLines),
    deterministicText,
    deterministicTokens: tokenCounter(deterministicText),
    directText
  };
}

function gateForWorker({ dataClass, route, dataGate }) {
  if (dataClass === 'SECRET') {
    return { allowed: false, reason: 'SECRET data is strictly excluded from context-worker input' };
  }
  if (typeof dataGate !== 'function') {
    return { allowed: false, reason: 'Context Broker requires the Router data-policy gate before selecting a worker' };
  }
  return dataGate(dataClass, route.data_profile, { resolvedRuntimeModel: route.resolved_runtime_model });
}

function routeForWorker({ request, dataClass, routeSelector }) {
  if (typeof routeSelector !== 'function') {
    throw new Error('Context Broker requires a routeSelector for shunted operations');
  }
  const decision = routeSelector({
    role: request.contextWorkerRole || 'fast_context',
    taskClass: 'large_context_repository_retrieval',
    dataClass,
    targetEffort: 'low',
    retryTolerant: true,
    useLiveAxi: request.useLiveAxi
  });
  const route = decision?.selectedRoute || decision?.route || decision;
  if (!route?.route_id) throw new Error('Context Broker routeSelector returned no selected RouteTarget');
  return { decision, route };
}

function compactPackText(pack) {
  const lines = [
    `ContextPack ${pack.schema_version} query=${pack.query}`,
    `repo_sha=${pack.repo_state.repo_sha || 'unknown'}`,
    `relevant_files=${pack.relevant_files.join(', ') || 'none'}`,
    ...pack.relevant_ranges.map((range) => `${range.path}:${range.start_line}-${range.end_line} ${range.why}`),
    ...pack.relevant_symbols.map((symbol) => `${symbol.path}:${symbol.line} ${symbol.name} ${symbol.why}`),
    ...pack.findings.map((finding) => finding.summary || finding.text || finding.lines?.join('\n') || ''),
    pack.artifact ? `artifact=${pack.artifact.path} sha256=${pack.artifact.sha256} validation=${pack.artifact.validation || 'not supplied'}` : '',
    pack.unresolved_questions.length > 0 ? `unresolved=${pack.unresolved_questions.join('; ')}` : ''
  ];
  const nonEmptyLines = lines.filter(Boolean);
  const compact = [];
  let tokens = 0;
  for (const line of nonEmptyLines) {
    const lineTokens = lexicalTokenCount(line);
    if (tokens + lineTokens > CONTEXT_LIMITS.maxSummaryTokens) break;
    compact.push(line);
    tokens += lineTokens;
  }
  if (compact.length < nonEmptyLines.length) compact.push('Additional evidence is available through the pack ranges and targeted-slice operation.');
  return compact.join('\n');
}

function reasonerText(pack) {
  const direct = pack.findings?.find((finding) => finding.kind === 'direct_source' && typeof finding.text === 'string');
  return direct ? direct.text : compactPackText(pack);
}

function cacheDirectory(homeDir) {
  return path.join(path.resolve(homeDir || process.env.FM_HOME || process.cwd()), 'state', 'context-cache');
}

function cacheFileFor(homeDir, cacheKey) {
  return path.join(cacheDirectory(homeDir), `${cacheKey}.json`);
}

function readCachedPack(filePath, cacheKey) {
  try {
    const cached = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (cached?.provenance?.cache_key !== cacheKey || cached?.schema_version !== CONTEXT_BROKER_VERSION) return null;
    return cached;
  } catch {
    return null;
  }
}

function persistPack(filePath, pack) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(pack, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function safeArtifact(repoDir, artifactPath, generatedContent, overwrite = false) {
  const absolute = resolveRepoPath(repoDir, artifactPath, 'artifact path');
  if (fs.existsSync(absolute) && !overwrite) {
    throw new Error(`refusing to overwrite existing artifact without overwrite=true: ${artifactPath}`);
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const tempPath = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, String(generatedContent), { mode: 0o644 });
  fs.renameSync(tempPath, absolute);
  const bytes = fs.readFileSync(absolute);
  const relative = relativePath(repoDir, absolute);
  const validationResult = spawnSync('git', ['diff', '--check', '--', relative], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 10000
  });
  const validation = validationResult.error
    ? `not available: ${validationResult.error.message}`
    : validationResult.status === 0
      ? 'git diff --check passed'
      : `git diff --check failed: ${String(validationResult.stderr || '').trim() || `exit ${validationResult.status}`}`;
  const stat = repoCommand(repoDir, ['diff', '--stat', '--', relative]);
  return {
    path: relative,
    sha256: sha256(bytes),
    bytes: bytes.length,
    diff_stat: stat || null,
    validation
  };
}

function sourceHashes(sources) {
  return Object.fromEntries(sources.filter((source) => source.source_hash).map((source) => [source.path, source.source_hash]));
}

function rawSourceText(sources) {
  return sources.map((source) => `${source.path}\n${source.content}`).join('\n');
}

function normalizedDataClass(dataClass) {
  if (!dataClass || dataClass === 'UNKNOWN') throw new Error('Context Broker requires a classified dataClass');
  return String(dataClass);
}

function telemetryForPack(pack) {
  return {
    raw_candidate_context_tokens: pack.token_counts.raw_candidate_context_tokens,
    deterministic_context_tokens: pack.token_counts.deterministic_context_tokens,
    shunt_worker_input_tokens: pack.token_counts.shunt_worker_input_tokens,
    shunt_worker_output_tokens: pack.token_counts.shunt_worker_output_tokens,
    reasoner_context_tokens_delivered: pack.token_counts.reasoner_context_tokens_delivered,
    premium_context_avoided: pack.telemetry.premium_context_avoided,
    compression_ratio: pack.telemetry.compression_ratio,
    context_cache_hit: pack.telemetry.context_cache_hit,
    context_cache_miss: pack.telemetry.context_cache_miss,
    context_worker_route: pack.telemetry.context_worker_route,
    context_worker_pool: pack.telemetry.context_worker_pool,
    wall_clock_overhead: pack.telemetry.wall_clock_overhead,
    fallback_to_direct_reasoner: pack.telemetry.fallback_to_direct_reasoner,
    total_model_tokens_spent: pack.telemetry.total_model_tokens_spent
  };
}

function appendTelemetry(homeDir, telemetry) {
  const filePath = path.join(path.resolve(homeDir || process.env.FM_HOME || process.cwd()), 'state', 'context-telemetry.jsonl');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...telemetry })}\n`, { mode: 0o600 });
  } catch {
    // Context delivery remains usable if a private telemetry sidecar is unavailable.
  }
}

export function createContextBroker({
  homeDir = null,
  routeSelector = null,
  dataGate = null,
  shuntWorker = null,
  tokenCounter = null,
  now = () => new Date()
} = {}) {
  const countTokens = makeTokenCounter(tokenCounter);

  function requestContext(request = {}) {
    const startedAt = Date.now();
    const repoDir = normalizedRepoDir(request.repoDir);
    const dataClass = normalizedDataClass(request.dataClass);
    const operation = operationFromRequest(request);
    const collected = collectSources(request, repoDir, operation);
    const rawText = rawSourceText(collected.sources);
    const rawTokens = countTokens(rawText || request.query || '');
    const classification = classifyContextOperation(request, rawTokens);
    const state = repoState(repoDir);
    const hashes = sourceHashes(collected.sources);
    const fingerprint = {
      version: CONTEXT_BROKER_VERSION,
      repo_sha: state.repo_sha,
      workspace_state_hash: state.workspace_state_hash,
      source_hashes: hashes,
      query: String(request.query || ''),
      operation: classification.operation,
      data_class: dataClass,
      context_worker_role: request.contextWorkerRole || 'fast_context',
      interpretation_needed: request.interpretationNeeded === true,
      generated_artifact: request.artifactPath || null,
      generated_content_hash: request.generatedContent === undefined
        ? null
        : sha256(String(request.generatedContent))
    };
    const cacheKey = jsonHash(fingerprint);
    const cachePath = cacheFileFor(homeDir, cacheKey);
    const cacheable = dataClass !== 'SECRET' && classification.operation !== 'generated_boilerplate';
    const cached = cacheable ? readCachedPack(cachePath, cacheKey) : null;
    if (cached) {
      const cachedPack = structuredClone(cached);
      const delivered = countTokens(reasonerText(cachedPack));
      cachedPack.provenance.cache_hit = true;
      cachedPack.token_counts.raw_candidate_context_tokens = rawTokens;
      cachedPack.token_counts.reasoner_context_tokens_delivered = delivered;
      cachedPack.token_counts.shunt_worker_input_tokens = 0;
      cachedPack.token_counts.shunt_worker_output_tokens = 0;
      cachedPack.token_estimates = { ...cachedPack.token_counts };
      cachedPack.telemetry = {
        ...cachedPack.telemetry,
        raw_candidate_context_tokens: rawTokens,
        deterministic_context_tokens: cachedPack.token_counts.deterministic_context_tokens,
        shunt_worker_input_tokens: 0,
        shunt_worker_output_tokens: 0,
        reasoner_context_tokens_delivered: delivered,
        context_cache_hit: true,
        context_cache_miss: false,
        wall_clock_overhead: Date.now() - startedAt,
        total_model_tokens_spent: delivered,
        premium_context_avoided: Math.max(0, rawTokens - delivered),
        compression_ratio: rawTokens > 0 ? Number((delivered / rawTokens).toFixed(6)) : 1
      };
      appendTelemetry(homeDir, telemetryForPack(cachedPack));
      return cachedPack;
    }

    const extraction = deterministicExtraction({
      sources: collected.sources,
      operation: classification.operation,
      query: request.query,
      range: collected.range,
      tokenCounter: countTokens
    });
    let findings = extraction.findings;
    let relevantFiles = extraction.relevantFiles;
    let relevantSymbols = extraction.relevantSymbols;
    let relevantRanges = extraction.relevantRanges;
    let unresolved = [];
    let workerRoute = null;
    let workerPool = null;
    let workerInputTokens = 0;
    let workerOutputTokens = 0;
    let fallback = false;
    let workerRefusal = null;

    if (classification.requiresShunt) {
      try {
        const selected = routeForWorker({ request, dataClass, routeSelector });
        const gate = gateForWorker({ dataClass, route: selected.route, dataGate });
        if (!gate.allowed) {
          workerRefusal = gate.reason;
          unresolved.push(`Context worker refused by data policy: ${gate.reason}`);
        } else {
          workerRoute = selected.route.route_id;
          workerPool = selected.route.quota_pool || null;
          const workerInput = {
            query: String(request.query || ''),
            operation: classification.operation,
            files: collected.sources.map((source) => ({ path: source.path, content: source.content, source_hash: source.source_hash })),
            deterministic_evidence: extraction,
            repo_state: state,
            data_class: dataClass
          };
          workerInputTokens = countTokens(JSON.stringify(workerInput));
          if (typeof shuntWorker !== 'function') {
            fallback = true;
            unresolved.push('No provider adapter was supplied for the selected context worker; compact deterministic evidence is delivered to the reasoner.');
          } else {
            const result = shuntWorker(workerInput, { route: selected.route, decision: selected.decision, dataClass });
            const workerText = typeof result === 'string' ? result : JSON.stringify(result || {});
            workerOutputTokens = countTokens(workerText);
            if (typeof result === 'string') {
              findings = [...findings, { kind: 'context_worker_finding', summary: result }];
            } else {
              findings = [...findings, ...(Array.isArray(result?.findings) ? result.findings : []), {
                kind: 'context_worker_result',
                summary: result?.summary || 'Context worker returned structured evidence.'
              }];
              relevantFiles = [...new Set([...relevantFiles, ...(result?.relevant_files || [])])];
              relevantSymbols = [...relevantSymbols, ...(result?.relevant_symbols || [])];
              relevantRanges = [...relevantRanges, ...(result?.relevant_ranges || [])];
              unresolved = [...unresolved, ...(result?.unresolved_questions || [])];
            }
          }
        }
      } catch (error) {
        fallback = true;
        unresolved.push(`Context worker selection failed; compact deterministic evidence delivered directly: ${error.message}`);
      }
    }

    let artifact = null;
    if (classification.operation === 'generated_boilerplate' && request.artifactPath) {
      artifact = safeArtifact(repoDir, request.artifactPath, request.generatedContent ?? request.content ?? '', request.overwrite === true);
      findings = [...findings, { kind: 'artifact_written', summary: `Generated artifact written at ${artifact.path}.`, path: artifact.path }];
    }

    if (dataClass === 'SECRET') {
      findings = [{ kind: 'secret_suppressed', summary: 'SECRET payload was suppressed before any model or context-worker handoff.' }];
      relevantFiles = [];
      relevantSymbols = [];
      relevantRanges = [];
      unresolved = ['The classified SECRET payload cannot be delivered through Context Broker.'];
      workerRoute = null;
      workerPool = null;
      workerInputTokens = 0;
      workerOutputTokens = 0;
      fallback = false;
    }

    const draft = {
      schema_version: CONTEXT_BROKER_VERSION,
      query: String(request.query || ''),
      operation: classification.operation,
      repo_state: state,
      files_considered: collected.sources.map((source) => source.path),
      relevant_files: [...new Set(relevantFiles)],
      relevant_symbols: relevantSymbols,
      relevant_ranges: relevantRanges.slice(0, CONTEXT_LIMITS.maxEvidenceLines),
      findings,
      provenance: {
        broker: CONTEXT_BROKER_VERSION,
        generated_at: now().toISOString(),
        source_hashes: hashes,
        cache_key: cacheKey,
        cache_hit: false,
        data_policy_scope: dataClass,
        operation_classification: classification
      },
      commands_used: collected.commands,
      unresolved_questions: [...new Set(unresolved)],
      source_hashes: hashes,
      token_counts: {
        raw_candidate_context_tokens: rawTokens,
        deterministic_context_tokens: extraction.deterministicTokens,
        shunt_worker_input_tokens: workerInputTokens,
        shunt_worker_output_tokens: workerOutputTokens,
        reasoner_context_tokens_delivered: 0
      },
      token_estimates: {
        raw_candidate_context_tokens: rawTokens,
        deterministic_context_tokens: extraction.deterministicTokens,
        shunt_worker_input_tokens: workerInputTokens,
        shunt_worker_output_tokens: workerOutputTokens,
        reasoner_context_tokens_delivered: 0
      },
      artifact,
      worker_refusal: workerRefusal,
      telemetry: null
    };
    const delivered = countTokens(reasonerText(draft));
    draft.token_counts.reasoner_context_tokens_delivered = delivered;
    draft.token_estimates.reasoner_context_tokens_delivered = delivered;
    draft.telemetry = {
      raw_candidate_context_tokens: rawTokens,
      deterministic_context_tokens: extraction.deterministicTokens,
      shunt_worker_input_tokens: workerInputTokens,
      shunt_worker_output_tokens: workerOutputTokens,
      reasoner_context_tokens_delivered: delivered,
      premium_context_avoided: Math.max(0, rawTokens - delivered),
      compression_ratio: rawTokens > 0 ? Number((delivered / rawTokens).toFixed(6)) : 1,
      context_cache_hit: false,
      context_cache_miss: true,
      context_worker_route: workerRoute,
      context_worker_pool: workerPool,
      wall_clock_overhead: Date.now() - startedAt,
      fallback_to_direct_reasoner: fallback,
      total_model_tokens_spent: workerInputTokens + workerOutputTokens + delivered
    };
    draft.provenance.pack_sha256 = sha256(JSON.stringify({ ...draft, telemetry: null }));
    if (cacheable) persistPack(cachePath, draft);
    appendTelemetry(homeDir, telemetryForPack(draft));
    return draft;
  }

  return {
    requestContext,
    buildContextPack: requestContext,
    renderContextPack: compactPackText,
    cacheDirectory: cacheDirectory(homeDir)
  };
}

export function requestContext(request, options = {}) {
  return createContextBroker(options).requestContext(request);
}

export function renderContextPack(pack) {
  return compactPackText(pack);
}

export function readTargetedSlice({ pack, repoDir, filePath, startLine = 1, endLine = startLine } = {}) {
  const root = normalizedRepoDir(repoDir);
  const absolute = resolveRepoPath(root, filePath, 'slice file path');
  const relative = relativePath(root, absolute);
  const bytes = fs.readFileSync(absolute);
  const currentHash = sha256(bytes);
  const expectedHash = pack?.source_hashes?.[relative] || pack?.provenance?.source_hashes?.[relative];
  if (expectedHash && expectedHash !== currentHash) {
    throw new Error(`targeted slice refused because ${relative} changed after the ContextPack was created`);
  }
  const start = Number(startLine);
  const end = Number(endLine);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error('slice startLine/endLine must be positive integers');
  }
  return {
    path: relative,
    start_line: start,
    end_line: end,
    source_hash: currentHash,
    content: bytes.toString('utf8').split('\n').slice(start - 1, end).join('\n')
  };
}

export const requestTargetedSlice = readTargetedSlice;

if (process.argv[1] && process.argv[1].endsWith('fm-context-broker.mjs')) {
  const command = process.argv[2] || 'help';
  if (command === 'help' || command === '--help') {
    console.log('Usage: fm-context-broker.mjs pack < request.json | slice <pack.json> <file> <start> <end>');
  } else if (command === 'pack') {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', async () => {
      try {
        const router = await import('./fm-router-v2.mjs');
        const request = JSON.parse(input);
        const broker = createContextBroker({
          homeDir: process.env.FM_HOME,
          routeSelector: (params) => router.scoreAndSelectRoute(params),
          dataGate: router.evaluateDataGate
        });
        console.log(JSON.stringify(broker.requestContext(request), null, 2));
      } catch (error) {
        console.error(`CONTEXT BROKER ERROR: ${error.message}`);
        process.exitCode = 1;
      }
    });
  } else if (command === 'slice') {
    try {
      const [packPath, filePath, startLine, endLine] = process.argv.slice(3);
      const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
      console.log(JSON.stringify(readTargetedSlice({
        pack,
        repoDir: process.cwd(),
        filePath,
        startLine,
        endLine
      }), null, 2));
    } catch (error) {
      console.error(`CONTEXT BROKER ERROR: ${error.message}`);
      process.exitCode = 1;
    }
  } else {
    console.error(`Unknown Context Broker command: ${command}`);
    process.exitCode = 1;
  }
}
