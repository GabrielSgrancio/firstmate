# Router V3 WP8 Task State Capsule and Continuation Engine Report

Date: 2026-09-15.

Branch: `fm/router-v3-wp8-task-state` from `e631662ae1bff2eae7dfae968f7ee0460f95131f`.

## 1. Executive Summary and Architecture

FirstMate's mission store (`bin/fm-mission.sh`) provides macro-level lifecycle management (original prompt pointer, high-level task graph, active sessions, and captain holds). However, it does not manage intra-task execution continuation or model-to-model fallback handoffs. Prior to WP8, when a model failed or reached a handoff boundary mid-task, either the entire raw transcript had to be replayed into a subsequent worker, or context was lost, triggering repeated repository discovery and duplicate work.

WP8 introduces `bin/fm-task-state.mjs`, providing the canonical `TaskStateCapsule` and continuation engine. This design deliberately avoids creating a competing mission architecture. Instead, it defines a focused, provider-neutral execution continuation capsule scoped strictly to a single logical task and its routing decisions, while reusing atomic write and durable state patterns established by `bin/fm-mission.sh`.

## 2. Final TaskStateCapsule Schema

The implemented schema implements the conceptual specification verbatim across 25 concrete fields:

```yaml
TaskStateCapsule:
  schema_version: integer (1)
  logical_task_id: string (canonical task identifier, e.g. "task-cache-fix")
  route_execution_id: string | null (current route execution token, e.g. "rex-1726372800-123")
  objective: string (verbatim task goal and requirements)
  constraints: string[] (enforced boundaries: mode, yolo, delivery, isolation)
  task_class: string (one of 10 Router V3 empirical task classes)
  data_class: string (one of 5 active privacy classes: PUBLIC, SANITIZED, PRIVATE_CODE, PERSONAL_SENSITIVE, SECRET)
  repo_state:
    commit_sha: string
    branch: string
    clean: boolean
    base_sha: string
  discovered_files: string[] (paths discovered by prior exploration to prevent re-discovery)
  relevant_interfaces: object[] (distilled function/class signatures and contracts)
  evidence_refs: object[] (log pointers, transcript locations, test artifact URIs)
  decisions_made: object[] (settled architectural/design choices that must not be revisited)
  commands_executed: object[] (history of executed shell commands, exit codes, and output snippets)
  test_results: object[] (structured test outcomes, failed assertion messages, regression results)
  current_diff: string (compact work-in-progress unified git diff)
  files_modified: string[] (explicit list of paths touched)
  failed_hypotheses: object[] (theories tested and disproven, preventing cyclical retries)
  failure_classification: string | null (one of the 7 canonical failure classes)
  unresolved_questions: string[] (targeted uncertainties passed to the specialist)
  next_recommended_action: string (prescribed next engineering step)
  current_route: object | null (active RouteTarget metadata: route_id, harness, model, effort, quota_pool)
  previous_routes: object[] (chronological archive of prior route executions, durations, and failure reasons)
  attempt_count: integer (1-indexed counter of execution attempts)
  context_pack_refs: string[] (references to WP7 ContextPack tokens and manifests)
  timestamps:
    created_at: ISO8601 UTC string
    updated_at: ISO8601 UTC string
    last_dispatched_at: ISO8601 UTC string
    completed_at: ISO8601 UTC string | null
```

### Architectural Rationale: Sibling Structure to Mission Store
- **Scope separation**: `bin/fm-mission.sh` tracks missions spanning multiple tasks, users, and multi-session rehydrations. `TaskStateCapsule` tracks the micro-state of a single task dispatch as it moves across models and harnesses.
- **Provider neutrality**: Capsules contain zero vendor-specific transcript envelopes (no Anthropic XML message envelopes, OpenAI function calls, or Gemini parts). State is purely semantic (diffs, interfaces, commands, hypotheses).
- **Zero data duplication**: Big raw transcripts are relegated to `evidence_refs` pointers, keeping the capsule compact and fast to serialize.

## 3. Failure Classification to Route Class Mapping

The continuation engine strictly enforces the principle: **do not implement `failure -> bigger model`**. When a failure occurs, the engine classifies the root cause and selects an appropriate specialist or infrastructure remedy through the merged WP5/WP6 scheduler (`scoreAndSelectRoute`).

| Failure Classification | Destination Role / Task Class | Routing & Effort Action | Rationale |
| :--- | :--- | :--- | :--- |
| `CONTEXT_FAILURE` | `deep_context`<br>(`large_context_repository_retrieval`) | Target effort: `high`. Attach improved ContextPack or ContextPack references. | Retrieval failure requires repository-wide context window and context specialist, not higher reasoning on local files. |
| `TOOL_FOLLOW_THROUGH_FAILURE` | `autonomous_engineer`<br>(`multi_file_feature`) | Target effort: `medium`/`high`. Retain tool capabilities with full autonomous follow-through. | Execution failure where cheaper tool workers fail to complete multi-step tool calls is routed to an autonomous worker. |
| `REASONING_FAILURE` | `deep_engineer`<br>(`brownfield_debugging`) | Target effort: `high`. Quality floor: `>= 0.93`. Exclude failed route. | Algorithmic or edge-case reasoning failures require deep reasoning and high reasoning effort. |
| `ARCHITECTURAL_UNCERTAINTY` | `architect_synthesizer`<br>(`architecture_reasoning`) | Target effort: `high`. High judgment floor: `>= 0.93`. | Design or structural ambiguity routes to high-judgment model for architectural synthesis. |
| `HARD_RUNTIME_FAILURE` | **Preserves existing role and task class** | `retryTolerant: true`. Exclude exact crashed route. **No model tier escalation.** | Network drops, process crashes, and harness hiccups are infrastructure faults; retried on equivalent infrastructure without wasting premium reasoning. |
| `POLICY_FAILURE` | **Preserves existing role and task class** | Exclude ineligible route. Evaluate data gate against compliant alternatives. **No model tier escalation.** | Privacy or compliance rejections route to an eligible model within the same capability tier. |
| `QUOTA_FAILURE` | **Preserves existing role and task class** | Mark exhausted quota pool as `EXHAUSTED`. Shift to equivalent capable pool. **No model tier escalation.** | Pool exhaustion routes across the 5 first-class resource pools (`claude_pro`, `codex_plus`, `antigravity_gemini`, `antigravity_3p`, `opencode_go`) to an alternative pool meeting the same quality floor. |

All continuation route selections pass through `selectContinuationRoute()`, which delegates directly to `scoreAndSelectRoute()`. Stage A (hard requirements), Stage B (task-class quality floor), and Stage C (economics and expected successful quota burn) are preserved.

## 4. Two-Route Handoff Evidence & Token Compression

The end-to-end handoff lifecycle was verified via `tests/fm-router-v3-task-state.test.mjs`:

### Scenario
1. **Route A Execution**:
   - Route: `codex:gpt-5.6-luna:low` (`mechanical_tool_work`, `PRIVATE_CODE`).
   - Task: Fix high-concurrency race condition in database transaction coordinator.
   - Route A discovers files: `src/coordinator.js`, `src/wal.js`, `tests/txn.test.js`.
   - Route A identifies interface: `Coordinator.commit`.
   - Route A writes initial optimistic flush patch.
   - Route A executes `npm test tests/txn.test.js`, which fails with `SplitBrainError: multiple coordinators elected`.
   - Route A refutes hypothesis: *"Optimistic flush avoids split brain (Refuted: network partition triggers dual leaders)"*.
   - Route A hits reasoning limit on distributed consensus protocol, records `REASONING_FAILURE`, and persists the capsule.

2. **Handoff to Route B**:
   - `selectContinuationRoute()` classifies `REASONING_FAILURE`, excludes `codex:gpt-5.6-luna:low`, and promotes the role to `deep_engineer` (`brownfield_debugging`, quality floor `0.93`).
   - The scheduler selects Route B (`claude:claude-opus-5:high`).
   - Route B receives the high-density continuation prompt via `formatContinuationPrompt()`.

3. **Measured Outcome**:
   - **No duplicate discovery**: Route B immediately reads `discovered_files` and `relevant_interfaces` from the capsule without executing `find`, `grep`, or directory scans.
   - **Preserved state**: Route B receives `current_diff`, previous test results, and command history.
   - **No repeated mistakes**: Route B reads `failed_hypotheses` and avoids repeating the failed optimistic flush.
   - **Data classification preserved**: `PRIVATE_CODE` is enforced on Route B.
   - **Task completion**: Route B implements term validation, executes the test suite (12 tests pass), and finalizes the task capsule and telemetry record.

### Context & Token Measurement
A comparison between feeding raw conversation transcripts versus the compressed `TaskStateCapsule` continuation prompt was measured:

```text
Raw multi-turn transcript:
  Total characters:  24,010 chars
  Estimated tokens:  6,003 tokens

Compressed continuation prompt:
  Total characters:  1,397 chars
  Estimated tokens:  350 tokens

Token savings:       5,653 tokens
Reduction ratio:     17.15x (94.17% context reduction)
```

The continuation prompt provides 100% of the necessary engineering state (objective, constraints, diff, files, interfaces, tests, failed hypotheses, next steps) at less than 6% of the raw transcript token cost.

## 5. Durability and Process Restart Survival

- **Atomic persistence**: `saveTaskStateCapsule()` uses the atomic `tempfile` + `fs.renameSync` pattern on POSIX filesystems. Writes are serialized to `data/<taskId>/task-state.json`.
- **Permissions**: Files are persisted with `0o600` (read/write by owner only) within `0o700` directories.
- **Process restart verification**: Test 6 simulates a full process exit and supervisor reboot by clearing in-memory structures, reloading from disk via `loadTaskStateCapsule()`, and verifying deep equality of objective, repo state, diff, and discovered files.

## 6. Secret Scrubbing and Policy Defense-in-Depth

- **Pattern-based scrubbing**: Before persistence, all capsule strings, arrays, and objects are recursively scrubbed via `scrubSecrets()`. Detected credentials (Anthropic `sk-ant-`, OpenAI `sk-`, GitHub tokens `ghp_` / `github_pat_`, Google API keys `AIzaSy`, Bearer JWTs, private RSA/EC keys, password/secret query parameters, and variable assignments) are replaced with `[REDACTED_SECRET]`.
- **Defense-in-depth policy**: While `SECRET` data is blocked at the data gate from reaching any external dispatch, `saveTaskStateCapsule()` enforces an additional safety layer: if `data_class === 'SECRET'`, all diffs and command stdout/stderr payloads are replaced with `[REDACTED_SECRET_POLICY_PAYLOAD]`.

## 7. Verification Summary

The complete test suite passed cleanly:

```text
node tests/fm-router-v3-task-state.test.mjs
--- Router V3 WP8 Task State Capsule & Continuation Engine Tests ---
Test 1: Conceptual Schema and 25-field verification
✓ Test 1 passed: conceptual schema and validation verified
Test 2: Secret Scrubbing and Policy Defense-in-Depth
✓ Test 2 passed: secret scrubbing and defense-in-depth verified
Test 3: Escalation by Failure Type (All 7 Classifications)
✓ Test 3 passed: all 7 failure escalations correctly mapped without naive bigger-model fallback
Test 4: Real Scheduler Wiring with scoreAndSelectRoute
✓ Test 4 passed: real WP5/WP6 scheduler selected continuation routes
Test 5: State Compression and Token Measurement
  Raw context chars: 24010 (~6003 tokens)
  Compressed continuation prompt chars: 1397 (~350 tokens)
  Token savings: 5653 tokens (94.17% reduction, ratio 17.15x)
✓ Test 5 passed: measured state compression and token savings
Test 6: Durability and Process Restart Survival
✓ Test 6 passed: atomic persistence, 0o600 permissions, and restart recovery verified
Test 7: Full Two-Route Handoff Lifecycle (Route A -> Route B)
✓ Test 7 passed: full Route A -> failure -> Route B continuation lifecycle verified

All Router V3 WP8 Task State tests passed successfully!
```

Regression verification:
- `node tests/fm-router-v2-enforcement.test.mjs`: PASSED.
- `node tests/fm-routing-eval.test.mjs`: PASSED.
- `node --check bin/fm-task-state.mjs`: PASSED.
- `node --check tests/fm-router-v3-task-state.test.mjs`: PASSED.
- `git diff --check`: PASSED.
- `bin/fm-lint.sh`: PASSED (ShellCheck 0.11.0, actionlint 1.7.12).
