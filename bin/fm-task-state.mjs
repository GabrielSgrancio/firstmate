#!/usr/bin/env node
/**
 * Router V3 Work Package 8: Provider-Neutral Task State Capsule and Continuation Engine
 *
 * Implements conceptual schema:
 *   TaskStateCapsule:
 *     schema_version
 *     logical_task_id
 *     route_execution_id
 *     objective
 *     constraints
 *     task_class
 *     data_class
 *     repo_state
 *     discovered_files
 *     relevant_interfaces
 *     evidence_refs
 *     decisions_made
 *     commands_executed
 *     test_results
 *     current_diff
 *     files_modified
 *     failed_hypotheses
 *     failure_classification
 *     unresolved_questions
 *     next_recommended_action
 *     current_route
 *     previous_routes
 *     attempt_count
 *     context_pack_refs
 *     timestamps
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TASK_CLASSES,
  roleForTaskClass,
  taskClassForRole
} from './fm-routing-capability.mjs';
import {
  scoreAndSelectRoute,
  recordTaskCompletion as routerRecordCompletion
} from './fm-router-v2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const currentFmHome = () => path.resolve(process.env.FM_HOME || ROOT);

export const TASK_STATE_SCHEMA_VERSION = 1;

export const ACTIVE_DATA_CLASSES = Object.freeze([
  'PUBLIC',
  'SANITIZED',
  'PRIVATE_CODE',
  'PERSONAL_SENSITIVE',
  'SECRET'
]);

export const FAILURE_CLASSIFICATIONS = Object.freeze({
  CONTEXT_FAILURE: 'CONTEXT_FAILURE',
  TOOL_FOLLOW_THROUGH_FAILURE: 'TOOL_FOLLOW_THROUGH_FAILURE',
  REASONING_FAILURE: 'REASONING_FAILURE',
  ARCHITECTURAL_UNCERTAINTY: 'ARCHITECTURAL_UNCERTAINTY',
  HARD_RUNTIME_FAILURE: 'HARD_RUNTIME_FAILURE',
  POLICY_FAILURE: 'POLICY_FAILURE',
  QUOTA_FAILURE: 'QUOTA_FAILURE'
});

export const SECRET_PATTERNS = [
  // Anthropic API keys
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // OpenAI API keys
  /sk-[A-Za-z0-9_-]{20,}/g,
  // GitHub Personal Access Tokens
  /ghp_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]{40,}/g,
  // Google Cloud API keys
  /AIza[0-9A-Za-z-_]{35}/g,
  // Bearer authentication tokens
  /Bearer\s+[A-Za-z0-9_\-.]{20,}/g,
  // RSA/EC/OPENSSH/PGP Private Keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // URL secret query parameters
  /(?<=[?&](?:api_key|token|password|secret|auth)=)[^&\s]+/gi,
  // Key-value pair secrets in configuration/diffs/logs
  /(?<=(?:password|secret|token|api_key|auth_token)\s*[:=]\s*["']?)[^"'\s\n]{8,}/gi
];

// Object keys whose value is a credential whatever its shape, compared after
// lowercasing and dropping separators (api_key, apiKey, API-KEY -> apikey).
const SENSITIVE_KEY_EXACT = new Set(['token', 'secret', 'password', 'passwd', 'passphrase', 'credential', 'credentials',
  'authorization', 'cookie', 'setcookie']);
const SENSITIVE_KEY_SUFFIXES = ['apikey', 'password', 'passwd', 'secret', 'secretkey', 'privatekey', 'accesskey',
  'accesstoken', 'refreshtoken', 'authtoken', 'bearertoken', 'sessiontoken', 'idtoken', 'clientsecret', 'credentials'];

export function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEY_EXACT.has(normalized) || SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * Recursively scrub secret tokens and credentials from capsule data.
 * Pure function: operates on strings, arrays, objects.  A value stored under a
 * credential-shaped key is redacted whole, whatever its type.
 */
export function scrubSecrets(value) {
  if (typeof value === 'string') {
    let scrubbed = value;
    for (const pattern of SECRET_PATTERNS) {
      scrubbed = scrubbed.replace(pattern, '[REDACTED_SECRET]');
    }
    return scrubbed;
  }
  if (Array.isArray(value)) {
    return value.map(item => scrubSecrets(item));
  }
  if (value !== null && typeof value === 'object') {
    const scrubbedObj = {};
    for (const [k, v] of Object.entries(value)) {
      scrubbedObj[k] = isSensitiveKey(k) && v !== null && v !== undefined && v !== '' ? '[REDACTED_SECRET]' : scrubSecrets(v);
    }
    return scrubbedObj;
  }
  return value;
}

/**
 * Creates a valid TaskStateCapsule conforming to the 25-field conceptual schema.
 */
export function createTaskStateCapsule({
  logical_task_id,
  route_execution_id = null,
  objective,
  constraints = [],
  task_class = 'targeted_edit',
  data_class,
  repo_state = {},
  discovered_files = [],
  relevant_interfaces = [],
  evidence_refs = [],
  decisions_made = [],
  commands_executed = [],
  test_results = [],
  current_diff = '',
  files_modified = [],
  failed_hypotheses = [],
  failure_classification = null,
  unresolved_questions = [],
  next_recommended_action = '',
  current_route = null,
  previous_routes = [],
  attempt_count = 1,
  context_pack_refs = [],
  timestamps = null
}) {
  if (!logical_task_id || typeof logical_task_id !== 'string') {
    throw new Error('createTaskStateCapsule: logical_task_id is required and must be a string');
  }
  if (!objective || typeof objective !== 'string') {
    throw new Error('createTaskStateCapsule: objective is required and must be a string');
  }
  if (!data_class || !ACTIVE_DATA_CLASSES.includes(data_class)) {
    throw new Error(`createTaskStateCapsule: data_class must be one of ${ACTIVE_DATA_CLASSES.join(', ')} (got: "${data_class}")`);
  }
  if (failure_classification && !Object.values(FAILURE_CLASSIFICATIONS).includes(failure_classification)) {
    throw new Error(`createTaskStateCapsule: invalid failure_classification "${failure_classification}"`);
  }

  const now = new Date().toISOString();
  const effectiveTimestamps = {
    created_at: timestamps?.created_at || now,
    updated_at: timestamps?.updated_at || now,
    last_dispatched_at: timestamps?.last_dispatched_at || now,
    completed_at: timestamps?.completed_at || null
  };

  const effectiveRepoState = {
    commit_sha: repo_state?.commit_sha || '',
    branch: repo_state?.branch || '',
    clean: repo_state?.clean ?? true,
    base_sha: repo_state?.base_sha || ''
  };

  const capsule = {
    schema_version: TASK_STATE_SCHEMA_VERSION,
    logical_task_id: String(logical_task_id).trim(),
    route_execution_id: route_execution_id ? String(route_execution_id).trim() : null,
    objective: String(objective).trim(),
    constraints: Array.isArray(constraints) ? constraints.map(c => String(c).trim()) : [],
    task_class: String(task_class).trim(),
    data_class: String(data_class).trim(),
    repo_state: effectiveRepoState,
    discovered_files: Array.isArray(discovered_files) ? [...discovered_files] : [],
    relevant_interfaces: Array.isArray(relevant_interfaces) ? [...relevant_interfaces] : [],
    evidence_refs: Array.isArray(evidence_refs) ? [...evidence_refs] : [],
    decisions_made: Array.isArray(decisions_made) ? [...decisions_made] : [],
    commands_executed: Array.isArray(commands_executed) ? [...commands_executed] : [],
    test_results: Array.isArray(test_results) ? [...test_results] : [],
    current_diff: typeof current_diff === 'string' ? current_diff : '',
    files_modified: Array.isArray(files_modified) ? [...files_modified] : [],
    failed_hypotheses: Array.isArray(failed_hypotheses) ? [...failed_hypotheses] : [],
    failure_classification: failure_classification || null,
    unresolved_questions: Array.isArray(unresolved_questions) ? [...unresolved_questions] : [],
    next_recommended_action: typeof next_recommended_action === 'string' ? next_recommended_action.trim() : '',
    current_route: current_route ? { ...current_route } : null,
    previous_routes: Array.isArray(previous_routes) ? [...previous_routes] : [],
    attempt_count: Number.isInteger(attempt_count) && attempt_count >= 1 ? attempt_count : 1,
    context_pack_refs: Array.isArray(context_pack_refs) ? [...context_pack_refs] : [],
    timestamps: effectiveTimestamps
  };

  return capsule;
}

/**
 * Validates a TaskStateCapsule object against the schema requirements.
 */
export function validateTaskStateCapsule(capsule, { throwOnError = true } = {}) {
  const errors = [];
  if (!capsule || typeof capsule !== 'object' || Array.isArray(capsule)) {
    const err = 'Capsule must be a non-null object';
    if (throwOnError) throw new Error(err);
    return { valid: false, errors: [err] };
  }

  if (capsule.schema_version !== TASK_STATE_SCHEMA_VERSION) {
    errors.push(`Expected schema_version ${TASK_STATE_SCHEMA_VERSION}, got ${capsule.schema_version}`);
  }
  if (!capsule.logical_task_id || typeof capsule.logical_task_id !== 'string') {
    errors.push('logical_task_id must be a non-empty string');
  }
  if (!capsule.objective || typeof capsule.objective !== 'string') {
    errors.push('objective must be a non-empty string');
  }
  if (!capsule.data_class || !ACTIVE_DATA_CLASSES.includes(capsule.data_class)) {
    errors.push(`data_class must be one of ${ACTIVE_DATA_CLASSES.join(', ')}`);
  }
  if (capsule.failure_classification && !Object.values(FAILURE_CLASSIFICATIONS).includes(capsule.failure_classification)) {
    errors.push(`Invalid failure_classification: ${capsule.failure_classification}`);
  }
  if (!Array.isArray(capsule.discovered_files)) {
    errors.push('discovered_files must be an array');
  }
  if (!Array.isArray(capsule.relevant_interfaces)) {
    errors.push('relevant_interfaces must be an array');
  }
  if (!Array.isArray(capsule.evidence_refs)) {
    errors.push('evidence_refs must be an array');
  }
  if (!Array.isArray(capsule.decisions_made)) {
    errors.push('decisions_made must be an array');
  }
  if (!Array.isArray(capsule.commands_executed)) {
    errors.push('commands_executed must be an array');
  }
  if (!Array.isArray(capsule.test_results)) {
    errors.push('test_results must be an array');
  }
  if (!Array.isArray(capsule.files_modified)) {
    errors.push('files_modified must be an array');
  }
  if (!Array.isArray(capsule.failed_hypotheses)) {
    errors.push('failed_hypotheses must be an array');
  }
  if (!Array.isArray(capsule.unresolved_questions)) {
    errors.push('unresolved_questions must be an array');
  }
  if (!Array.isArray(capsule.previous_routes)) {
    errors.push('previous_routes must be an array');
  }
  if (!Array.isArray(capsule.context_pack_refs)) {
    errors.push('context_pack_refs must be an array');
  }
  if (!capsule.repo_state || typeof capsule.repo_state !== 'object') {
    errors.push('repo_state must be an object');
  }
  if (!capsule.timestamps || typeof capsule.timestamps !== 'object') {
    errors.push('timestamps must be an object');
  }

  if (errors.length > 0 && throwOnError) {
    throw new Error(`Invalid TaskStateCapsule: ${errors.join('; ')}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Returns canonical file path for task state capsule.
 */
export function getTaskCapsulePath(taskId, { fmHome = currentFmHome() } = {}) {
  const primaryPath = path.join(fmHome, 'data', taskId, 'task-state.json');
  const alternatePath = path.join(fmHome, 'data', taskId, 'task-capsule.json');
  if (fs.existsSync(alternatePath) && !fs.existsSync(primaryPath)) {
    return alternatePath;
  }
  return primaryPath;
}

/**
 * Atomic write helper reusing tempfile + rename pattern.
 */
export function atomicWriteJson(filePath, data, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const randSuffix = Math.random().toString(36).slice(2, 8);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randSuffix}.tmp`);
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n';
  try {
    fs.writeFileSync(tempPath, content, { mode, encoding: 'utf8' });
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
    throw err;
  }
}

/**
 * Saves a TaskStateCapsule with secret scrubbing, schema validation, and atomic write.
 * A SECRET capsule is refused outright: SECRET data never enters model context,
 * so there is no continuation state to persist for it.
 */
export function saveTaskStateCapsule(taskId, capsule, { fmHome = currentFmHome(), destinationPath = null } = {}) {
  validateTaskStateCapsule(capsule);
  if (capsule.data_class === 'SECRET') {
    throw new Error(`TaskStateCapsule for task "${taskId}" is SECRET; SECRET data is strictly excluded from model context and is never persisted`);
  }

  // Defense-in-depth secret scrub, for credentials inside any other data class
  const scrubbed = scrubSecrets(capsule);
  scrubbed.timestamps.updated_at = new Date().toISOString();

  const targetPath = destinationPath || getTaskCapsulePath(taskId, { fmHome });
  atomicWriteJson(targetPath, scrubbed, 0o600);
  return scrubbed;
}

/**
 * Loads and validates a TaskStateCapsule from disk.
 */
export function loadTaskStateCapsule(taskId, { fmHome = currentFmHome(), sourcePath = null } = {}) {
  const targetPath = sourcePath || getTaskCapsulePath(taskId, { fmHome });
  if (!fs.existsSync(targetPath)) {
    throw new Error(`TaskStateCapsule not found for task "${taskId}" at ${targetPath}`);
  }
  const raw = fs.readFileSync(targetPath, 'utf8');
  const parsed = JSON.parse(raw);
  validateTaskStateCapsule(parsed);
  return parsed;
}

/**
 * Updates a TaskStateCapsule using a functional mutator and atomic persistence.
 */
export function updateTaskStateCapsule(taskId, mutator, options = {}) {
  const capsule = loadTaskStateCapsule(taskId, options);
  mutator(capsule);
  return saveTaskStateCapsule(taskId, capsule, options);
}

/**
 * Translates a failure classification to scheduler parameters per the captain's spec:
 *   CONTEXT_FAILURE -> context specialist / improved ContextPack
 *   TOOL_FOLLOW_THROUGH_FAILURE -> stronger autonomous worker
 *   REASONING_FAILURE -> deep reasoner
 *   ARCHITECTURAL_UNCERTAINTY -> high-judgment model
 *   HARD_RUNTIME_FAILURE -> retry/fix infrastructure, not premium reasoning
 *   POLICY_FAILURE -> choose eligible route, not bigger route
 *   QUOTA_FAILURE -> equivalent capable pool
 */
export function resolveEscalationParameters(capsule, failureClassification, {
  failedRoute = null,
  failureReason = '',
  contextPack = null,
  exhaustedPool = null,
  currentRole = null,
  excludeRoutes = [],
  quotaOverrides = null,
  critical = false,
  qualityFloor = null,
  targetEffort: targetEffortOverride = null,
  retryTolerant: retryTolerantOverride = false
} = {}) {
  if (!Object.values(FAILURE_CLASSIFICATIONS).includes(failureClassification)) {
    throw new Error(`resolveEscalationParameters: unknown failure classification "${failureClassification}"`);
  }

  const failedRouteId = failedRoute?.route_id || capsule.current_route?.route_id || null;
  const initialTaskClass = capsule.task_class || 'targeted_edit';
  let initialRole = currentRole;
  if (!initialRole) {
    try {
      initialRole = roleForTaskClass(initialTaskClass);
    } catch (_) {
      initialRole = 'general_engineer';
    }
  }

  let targetRole = initialRole;
  let targetTaskClass = initialTaskClass;
  let targetEffort = targetEffortOverride || null;
  const effectiveExcludes = [...excludeRoutes];
  let retryTolerant = Boolean(retryTolerantOverride);
  let effectiveQuotaOverrides = quotaOverrides ? { ...quotaOverrides } : null;
  let escalationNotes = '';
  const attachedContextPackRefs = [...capsule.context_pack_refs];

  switch (failureClassification) {
    case FAILURE_CLASSIFICATIONS.CONTEXT_FAILURE:
      // Context specialist / improved ContextPack
      targetRole = 'deep_context';
      targetTaskClass = 'large_context_repository_retrieval';
      targetEffort = 'high';
      escalationNotes = 'Context failure: escalating to deep_context retrieval specialist with high effort';
      if (contextPack) {
        const packRef = typeof contextPack === 'string' ? contextPack : (contextPack.pack_id || contextPack.path || JSON.stringify(contextPack));
        if (!attachedContextPackRefs.includes(packRef)) {
          attachedContextPackRefs.push(packRef);
        }
      }
      if (failedRouteId && !effectiveExcludes.includes(failedRouteId)) {
        effectiveExcludes.push(failedRouteId);
      }
      break;

    case FAILURE_CLASSIFICATIONS.TOOL_FOLLOW_THROUGH_FAILURE:
      // Stronger autonomous worker
      targetRole = 'autonomous_engineer';
      targetTaskClass = 'multi_file_feature';
      escalationNotes = 'Tool follow-through failure: escalating to autonomous_engineer with multi-file engineering capabilities';
      if (failedRouteId && !effectiveExcludes.includes(failedRouteId)) {
        effectiveExcludes.push(failedRouteId);
      }
      break;

    case FAILURE_CLASSIFICATIONS.REASONING_FAILURE:
      // Deep reasoner
      targetRole = 'deep_engineer';
      targetTaskClass = 'brownfield_debugging';
      targetEffort = 'high';
      escalationNotes = 'Reasoning failure: escalating to deep_engineer (brownfield_debugging) with high reasoning effort';
      if (failedRouteId && !effectiveExcludes.includes(failedRouteId)) {
        effectiveExcludes.push(failedRouteId);
      }
      break;

    case FAILURE_CLASSIFICATIONS.ARCHITECTURAL_UNCERTAINTY:
      // High-judgment model
      targetRole = 'architect_synthesizer';
      targetTaskClass = 'architecture_reasoning';
      targetEffort = 'high';
      escalationNotes = 'Architectural uncertainty: escalating to architect_synthesizer (architecture_reasoning) high-judgment route';
      if (failedRouteId && !effectiveExcludes.includes(failedRouteId)) {
        effectiveExcludes.push(failedRouteId);
      }
      break;

    case FAILURE_CLASSIFICATIONS.HARD_RUNTIME_FAILURE:
      // Retry/fix infrastructure, not premium reasoning
      // Keep exact same role and taskClass; do not promote model tier
      targetRole = initialRole;
      targetTaskClass = initialTaskClass;
      retryTolerant = true;
      escalationNotes = 'Hard runtime failure: preserving role and task class, retrying on resilient infrastructure route';
      if (failedRouteId && !effectiveExcludes.includes(failedRouteId)) {
        effectiveExcludes.push(failedRouteId);
      }
      break;

    case FAILURE_CLASSIFICATIONS.POLICY_FAILURE:
      // Choose eligible route, not bigger route
      targetRole = initialRole;
      targetTaskClass = initialTaskClass;
      escalationNotes = 'Policy failure: maintaining role tier, excluding ineligible route and selecting compliant route';
      if (failedRouteId && !effectiveExcludes.includes(failedRouteId)) {
        effectiveExcludes.push(failedRouteId);
      }
      break;

    case FAILURE_CLASSIFICATIONS.QUOTA_FAILURE: {
      // Equivalent capable pool
      targetRole = initialRole;
      targetTaskClass = initialTaskClass;
      const failedPool = exhaustedPool || capsule.current_route?.quota_pool;
      if (failedPool) {
        effectiveQuotaOverrides = effectiveQuotaOverrides || {};
        effectiveQuotaOverrides[failedPool] = {
          status: 'EXHAUSTED',
          scarcity_state: 'EXHAUSTED',
          actual_remaining: 0,
          rolling_remaining: 0,
          weekly_remaining: 0,
          monthly_remaining: 0
        };
      }
      if (failedRouteId && !effectiveExcludes.includes(failedRouteId)) {
        effectiveExcludes.push(failedRouteId);
      }
      escalationNotes = `Quota failure: maintaining capability tier, shifting from exhausted pool "${failedPool || 'unknown'}" to equivalent capable pool`;
      break;
    }
  }

  return {
    role: targetRole,
    taskClass: targetTaskClass,
    dataClass: capsule.data_class,
    targetEffort,
    excludeRoutes: effectiveExcludes,
    retryTolerant,
    critical,
    quotaOverrides: effectiveQuotaOverrides,
    qualityFloor,
    attachedContextPackRefs,
    escalationNotes
  };
}

/**
 * Selects next continuation route using the merged WP5/WP6 scheduler.
 */
export function selectContinuationRoute(capsule, {
  failureClassification = null,
  failedRoute = null,
  failureReason = '',
  contextPack = null,
  exhaustedPool = null,
  excludeRoutes = [],
  quotaOverrides = null,
  currentRole = null,
  critical = false,
  useLiveAxi = false,
  now = new Date()
} = {}) {
  const classification = failureClassification || capsule.failure_classification;
  if (!classification) {
    throw new Error('selectContinuationRoute: cannot select route without failure_classification');
  }

  const escalation = resolveEscalationParameters(capsule, classification, {
    failedRoute,
    failureReason,
    contextPack,
    exhaustedPool,
    currentRole,
    critical,
    excludeRoutes,
    quotaOverrides
  });

  const decision = scoreAndSelectRoute({
    role: escalation.role,
    taskClass: escalation.taskClass,
    dataClass: escalation.dataClass,
    targetEffort: escalation.targetEffort,
    excludeRoutes: escalation.excludeRoutes,
    retryTolerant: escalation.retryTolerant,
    critical: escalation.critical,
    quotaOverrides: escalation.quotaOverrides,
    qualityFloor: escalation.qualityFloor,
    requireSpawnable: true,
    useLiveAxi,
    now
  });

  return {
    decision,
    escalation,
    selectedRoute: decision.selectedRoute
  };
}

/**
 * Formats high-density continuation state markdown for worker continuation.
 * Token-compressed: excludes raw transcripts and dumps only distilled facts.
 */
export function formatContinuationPrompt(capsule, { maxDiffLines = 250 } = {}) {
  const lines = [];
  lines.push(`# FirstMate Task Continuation: ${capsule.logical_task_id}`);
  lines.push(`Attempt: ${capsule.attempt_count} | Prior Route: ${capsule.current_route?.route_id || 'initial'}`);
  lines.push('');
  lines.push('## Objective');
  lines.push(capsule.objective.trim());
  lines.push('');
  lines.push('## Constraints & Security Classification');
  lines.push(`- Data Classification: ${capsule.data_class} (strictly enforced)`);
  if (capsule.constraints?.length) {
    for (const c of capsule.constraints) {
      lines.push(`- Constraint: ${c}`);
    }
  }
  lines.push('');
  lines.push('## Continuation Status');
  lines.push(`- Failure Classification: ${capsule.failure_classification || 'HANDOFF'}`);
  lines.push(`- Next Recommended Action: ${capsule.next_recommended_action || 'Resume from continuation state'}`);
  lines.push('');
  lines.push('## Working Repository State');
  lines.push(`- Branch: ${capsule.repo_state?.branch || 'current'} (Base: ${capsule.repo_state?.base_sha || 'main'}, Head: ${capsule.repo_state?.commit_sha || 'HEAD'})`);
  if (capsule.files_modified?.length) {
    lines.push(`- Files Modified So Far: ${capsule.files_modified.join(', ')}`);
  }
  if (capsule.discovered_files?.length) {
    lines.push('- Discovered Files (Do NOT repeat full repository exploration):');
    for (const f of capsule.discovered_files) {
      lines.push(`  - ${f}`);
    }
  }
  lines.push('');
  if (capsule.relevant_interfaces?.length) {
    lines.push('## Relevant Interfaces');
    for (const iface of capsule.relevant_interfaces) {
      if (typeof iface === 'string') {
        lines.push(`- ${iface}`);
      } else {
        lines.push(`- \`${iface.name || iface.signature || 'interface'}\`${iface.path ? ` (${iface.path})` : ''}: ${iface.summary || ''}`);
      }
    }
    lines.push('');
  }
  if (capsule.current_diff) {
    lines.push('## Current Work-In-Progress Diff');
    lines.push('```diff');
    const diffLines = capsule.current_diff.split('\n');
    if (diffLines.length > maxDiffLines) {
      lines.push(diffLines.slice(0, maxDiffLines).join('\n'));
      lines.push(`... [truncated ${diffLines.length - maxDiffLines} lines of diff]`);
    } else {
      lines.push(capsule.current_diff);
    }
    lines.push('```');
    lines.push('');
  }
  if (capsule.decisions_made?.length) {
    lines.push('## Settled Decisions (Do NOT revisit)');
    for (const d of capsule.decisions_made) {
      if (typeof d === 'string') {
        lines.push(`- ${d}`);
      } else {
        lines.push(`- ${d.decision}: ${d.rationale || ''}`);
      }
    }
    lines.push('');
  }
  if (capsule.failed_hypotheses?.length) {
    lines.push('## Refuted Hypotheses (Do NOT repeat these attempts)');
    for (const h of capsule.failed_hypotheses) {
      if (typeof h === 'string') {
        lines.push(`- ${h}`);
      } else {
        lines.push(`- "${h.hypothesis}": ${h.reason_refuted || h.evidence || 'Refuted by test'}`);
      }
    }
    lines.push('');
  }
  if (capsule.test_results?.length) {
    lines.push('## Test Results from Prior Attempt');
    for (const t of capsule.test_results) {
      if (typeof t === 'string') {
        lines.push(`- ${t}`);
      } else {
        lines.push(`- [${(t.status || 'RESULT').toUpperCase()}] ${t.test_suite || ''} ${t.test_name || ''}: ${t.error_message || 'passed'}`);
      }
    }
    lines.push('');
  }
  if (capsule.commands_executed?.length) {
    lines.push('## Prior Commands Executed');
    for (const cmd of capsule.commands_executed.slice(-6)) {
      if (typeof cmd === 'string') {
        lines.push(`- \`${cmd}\``);
      } else {
        lines.push(`- \`${cmd.command}\` (exit ${cmd.exit_code})${cmd.stdout_snippet ? `: ${cmd.stdout_snippet.slice(0, 100)}` : ''}`);
      }
    }
    lines.push('');
  }
  if (capsule.unresolved_questions?.length) {
    lines.push('## Unresolved Questions');
    for (const q of capsule.unresolved_questions) {
      lines.push(`- ${q}`);
    }
    lines.push('');
  }
  if (capsule.context_pack_refs?.length) {
    lines.push('## ContextPack References');
    for (const cp of capsule.context_pack_refs) {
      lines.push(`- ${typeof cp === 'string' ? cp : cp.pack_id || JSON.stringify(cp)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Measures raw context vs compressed continuation state metrics.
 */
export function measureContextMetrics(capsule, rawTranscript) {
  const compressedText = formatContinuationPrompt(capsule);
  const rawText = typeof rawTranscript === 'string'
    ? rawTranscript
    : (Array.isArray(rawTranscript)
      ? rawTranscript.map(t => typeof t === 'string' ? t : JSON.stringify(t)).join('\n')
      : JSON.stringify(rawTranscript, null, 2));

  const rawChars = rawText.length;
  const rawWords = rawText.trim().split(/\s+/).filter(Boolean).length;
  const rawTokensEst = Math.ceil(rawChars / 4);

  const compressedChars = compressedText.length;
  const compressedWords = compressedText.trim().split(/\s+/).filter(Boolean).length;
  const compressedTokensEst = Math.ceil(compressedChars / 4);

  const tokenSavings = Math.max(0, rawTokensEst - compressedTokensEst);
  const compressionRatio = rawTokensEst > 0 ? (rawTokensEst / Math.max(1, compressedTokensEst)) : 1;
  const reductionPercent = rawTokensEst > 0 ? ((tokenSavings / rawTokensEst) * 100) : 0;

  return {
    raw_chars: rawChars,
    raw_words: rawWords,
    raw_tokens: rawTokensEst,
    compressed_chars: compressedChars,
    compressed_words: compressedWords,
    compressed_tokens: compressedTokensEst,
    token_savings: tokenSavings,
    compression_ratio: Number(compressionRatio.toFixed(2)),
    reduction_percent: Number(reductionPercent.toFixed(2))
  };
}

/**
 * Records a route failure and prepares capsule for handoff.
 */
export function recordRouteFailureAndHandoff(taskId, {
  failureClassification,
  failureReason = '',
  currentDiff = null,
  filesModified = null,
  commandsExecuted = null,
  testResults = null,
  failedHypotheses = null,
  unresolvedQuestions = null,
  nextRecommendedAction = '',
  discoveredFiles = null,
  relevantInterfaces = null,
  evidenceRefs = null,
  contextPackRefs = null
}, options = {}) {
  return updateTaskStateCapsule(taskId, (capsule) => {
    const now = new Date().toISOString();
    if (capsule.current_route) {
      capsule.previous_routes.push({
        route_execution_id: capsule.route_execution_id,
        route_id: capsule.current_route.route_id,
        harness: capsule.current_route.harness,
        model: capsule.current_route.model,
        effort: capsule.current_route.effort || null,
        failure_classification: failureClassification,
        failure_reason: failureReason,
        ended_at: now
      });
    }

    capsule.failure_classification = failureClassification;
    capsule.next_recommended_action = nextRecommendedAction;
    capsule.attempt_count += 1;

    if (currentDiff !== null) capsule.current_diff = currentDiff;
    if (filesModified !== null) capsule.files_modified = filesModified;
    if (commandsExecuted !== null) capsule.commands_executed.push(...commandsExecuted);
    if (testResults !== null) capsule.test_results.push(...testResults);
    if (failedHypotheses !== null) capsule.failed_hypotheses.push(...failedHypotheses);
    if (unresolvedQuestions !== null) capsule.unresolved_questions = unresolvedQuestions;
    if (discoveredFiles !== null) capsule.discovered_files = discoveredFiles;
    if (relevantInterfaces !== null) capsule.relevant_interfaces = relevantInterfaces;
    if (evidenceRefs !== null) capsule.evidence_refs.push(...evidenceRefs);
    if (contextPackRefs !== null) capsule.context_pack_refs.push(...contextPackRefs);
  }, options);
}

/**
 * Records dispatch of route continuation.
 */
export function recordContinuationDispatch(taskId, {
  nextRoute,
  nextRouteExecutionId,
  contextPackRefs = []
}, options = {}) {
  return updateTaskStateCapsule(taskId, (capsule) => {
    const now = new Date().toISOString();
    capsule.route_execution_id = nextRouteExecutionId;
    capsule.current_route = {
      route_id: nextRoute.route_id,
      harness: nextRoute.harness,
      model: nextRoute.resolved_runtime_model || nextRoute.model,
      effort: nextRoute.reasoning_effort || nextRoute.effort || null,
      provider_path: nextRoute.provider_path || null,
      quota_pool: nextRoute.quota_pool || null
    };
    if (contextPackRefs.length > 0) {
      for (const ref of contextPackRefs) {
        if (!capsule.context_pack_refs.includes(ref)) {
          capsule.context_pack_refs.push(ref);
        }
      }
    }
    capsule.timestamps.last_dispatched_at = now;
  }, options);
}

/**
 * Records task completion, finalizing the task state capsule and logging completion.
 */
export function recordContinuationCompletion(taskId, {
  terminalState = 'SUCCESS',
  resultSummary = '',
  exitCode = 0,
  tokensConsumed = null
} = {}, options = {}) {
  const capsule = updateTaskStateCapsule(taskId, (cap) => {
    const now = new Date().toISOString();
    cap.timestamps.completed_at = now;
    cap.failure_classification = null;
    cap.next_recommended_action = 'Task execution completed successfully';
  }, options);

  // Update Router V2 telemetry log for logical task
  try {
    routerRecordCompletion(taskId, {
      terminalState,
      resultSummary,
      exitCode,
      routeExecutionId: capsule.route_execution_id,
      parentExecutionId: capsule.previous_routes[0]?.route_execution_id || capsule.route_execution_id,
      tokensConsumed
    });
  } catch (_) {}

  return capsule;
}

// CLI handler if invoked directly
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [,, cmd, taskId, ...rest] = process.argv;
  if (!cmd || !taskId) {
    console.error('Usage: fm-task-state.mjs <show|compress|init> <taskId> [options]');
    process.exit(1);
  }

  try {
    if (cmd === 'show') {
      const capsule = loadTaskStateCapsule(taskId);
      console.log(JSON.stringify(capsule, null, 2));
    } else if (cmd === 'compress') {
      const capsule = loadTaskStateCapsule(taskId);
      console.log(formatContinuationPrompt(capsule));
    } else {
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
