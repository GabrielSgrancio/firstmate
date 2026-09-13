# FirstMate operational-state inventory (as of 2026-09-13)

Scope: every place operational truth about a mission/task lives today, across
`captain-workspace` (this repo), `gabriel-os` (OpenClaw + Gabriel TUI + Gateway),
Herdr, and harness-native session storage. Compiled by direct inspection of the
live fleet home (`/home/gabrielsgrancio/agents/captain-workspace`) and its
worktrees on 2026-09-13, not from documentation alone — several of the sources
below are undocumented in `AGENTS.md` and were found only by walking `state/`
and `data/` and grepping every worktree's `bin/`.

Companion evidence: `reconciliation-overnight-decomposition`'s report had not
landed at inspection time (`data/reconciliation-overnight-decomposition/`
contained only `brief.md`/`launch-brief.md`), so the `mission.json`/`capsule.json`
entry below documents both implementations found directly rather than
cross-referencing that report.

## Legend

- **Durability**: survives process death / host reboot / worktree teardown.
- **Atomicity**: can a crash leave a half-written, structurally invalid file.
- **Rebuildable**: can this be regenerated from other sources if deleted.

---

## 1. Backlog (`tasks-axi` / `data/backlog.md`)

- DATA TYPE: work-item queue — queued/in-progress/done tasks, captain holds, dependencies, notes.
- CURRENT OWNER: `tasks-axi` CLI when compatible (`bin/fm-tasks-axi-lib.sh`, `FM_TASKS_AXI_MIN=0.2.4`); falls back to hand-edited Markdown when `config/backlog-backend=manual` or the tool is missing/incompatible.
- STORAGE: `data/backlog.md`, one Markdown checklist file, sections `In progress` / `Queued` / `Done`; archive at `data/done-archive.md`; backend config in `.tasks.toml` (`backend = "markdown"`, `done_keep = 10`).
- DURABILITY: durable (tracked-ignored file on disk, gitignored but persistent across restarts).
- ATOMICITY: depends on the writer. `tasks-axi` presumably writes atomically (not verified here — closed tool); hand-editing (manual backend, or any direct `Write`/`Edit` bypassing `tasks-axi`) has no atomicity guarantee — a killed process mid-edit leaves a truncated Markdown file with no way to tell which line was in flight.
- WHO WRITES: `tasks-axi` (add/update/hold/mv), `bin/fm-spawn.sh` (moves to In-flight on dispatch when the gate applies), `bin/fm-teardown.sh` (moves to Done on landing), `bin/fm-captain-hold.sh` (hold/answer), firstmate directly only when `config/backlog-backend=manual`.
- WHO READS: `bin/fm-session-start.sh` (digest listing), firstmate every intake/heartbeat, `gabriel-os`'s `src/lib/gateway-work.mjs` (`tasks-axi show`/`tasks-axi add` — see §13), any crewmate checking backlog context.
- REBUILDABLE?: partially. Current queue snapshot is authoritative and not rebuildable from elsewhere; historical Done entries beyond `done_keep` are pruned to the archive and from there are just as durable, but reasoning/notes text is nowhere else.
- CURRENT PROBLEM: single Markdown file is the *only* durable ordering/priority/hold record in the whole fleet, yet nothing enforces that its free text (`hold:` reasons, `Decision key:`) stays structurally consistent — it is prose parsed by convention, not a schema. It is also the one place `captain-hold-lifecycle`'s open/closed state and the Herdr/worktree in-flight state must agree with, and nothing mechanically checks that they do (see `RECORD DIVERGENCE` in `AGENTS.md` §3, which exists precisely because this can drift).

## 2. `mission.json` / `capsule.json` — three incompatible producers found live

This is the sharpest finding in this inventory: there is **no single, committed,
canonical writer** for mission/capsule state, and at least three shapes exist
simultaneously on this one host tonight.

### 2a. The schema actually on disk (`data/missions/<id>/mission.json` + `capsule.json`, `state/mission-capsule.json`, `state/.active-mission`)

- DATA TYPE: mission-level session history, intent, original prompt provenance, completed/pending/in-flight task samples, preserved worktrees, recommended next step.
- CURRENT OWNER: **unknown / not a committed script.** No file under any worktree's `bin/` (searched all of `.treehouse/*/[0-9]*/*/bin`) references `mission.json`, `capsule.json`, `completed_tasks_sample`, `preserved_worktrees`, or `recommended_next_step`. These files were produced directly by an Antigravity (AGY) session's own ad hoc scripting during the overnight UFD sprint, not by a reusable FirstMate tool.
- STORAGE: `data/missions/<mission-id>/mission.json` (schema_version 1: `milestones`, `original_ufd_prompt{file,sha256,source_transcript,step_index,classification}`, `current_session_id`, `sessions[]`), sibling `capsule.json` (richer: `completed_tasks_count/sample`, `in_flight_tasks[]` with Herdr window/pane ids, `preserved_worktrees[]` with head commit + dirty-diff summary, `pending_tasks_count/sample`, `recommended_next_step`), plus a single well-known mirror `state/mission-capsule.json` (last-written capsule only) and a bare pointer file `state/.active-mission` (mission id as a one-line string). Confirmed live instances: `recovery-sprint-ufd-quota`, `e2e-supervisor-failover-test`, `--next` (a literal `--next` directory name — itself a symptom of no input validation on mission id in whatever wrote it).
- DURABILITY: durable (plain files under `data/`, gitignored, survive restarts).
- ATOMICITY: unknown — writer is not in the codebase to inspect. No temp-file+rename pattern can be verified.
- WHO WRITES: an AGY session, directly, ad hoc, once per mission/session transition it decided to record.
- WHO READS: nothing in the committed fleet reads these paths — no `bin/` script, no skill, references `mission.json`/`capsule.json`/`.active-mission`. Only a human (or another AGY session) reading the raw JSON.
- REBUILDABLE?: mostly yes, from `data/backlog.md` (completed/pending samples), `git log`/worktree state (preserved_worktrees), and the original prompt's own transcript (see §12) — *except* the free-text `intent`, `recommended_next_step` judgment call, and the `sessions_history` linkage, which are session-local synthesis with no other record.
- CURRENT PROBLEM: no committed owner, no reader, three mission directories from one night's work with no cross-links between them (`--next` and `recovery-sprint-ufd-quota` have overlapping in-flight tasks, suggesting one superseded the other, but nothing records that relationship), and mission id `--next` shows the format accepts un-validated input.

### 2b. The competing committed-but-unlanded implementation (`bin/fm-mission.sh`, schema_version 2)

- DATA TYPE: same conceptual mission/capsule idea, materially different schema.
- CURRENT OWNER: `bin/fm-mission.sh`, committed at `c67646c0` ("feat: add independent supervisor continuity") on branch `fm/supervisor-failover-hardening`, but **only inside the scratch worktree** `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/3/captain-workspace`. It is absent from `main` (verified: this worktree, a clean detached-HEAD checkout of `main`, has no `bin/fm-mission.sh` at all) and therefore absent from every other running task's worktree.
- STORAGE: same paths as §2a (`data/missions/<id>/mission.json`, `.../capsule.json`, `state/mission-capsule.json`, `state/.active-mission`) but a different JSON shape: `schema_version: 2`, fields `original_prompt_pointer` (a path, not a hash+transcript-offset), `task_graph` (empty array by default, no relation to the backlog), `next_action` (single string), `sessions[]` (same shape as §2a's `sessions_history` but without a `reason` field on `RUNNING→ENDED` transitions unless `session-end --reason` is called explicitly). Commands: `init`, `session-start`, `session-end`, `capsule`, `show`.
- DURABILITY: the script writes via `tempfile.mkstemp` + `os.replace` (atomic rename) for every mutation — the one producer here with a verified atomic-write pattern.
- ATOMICITY: atomic per file (temp file + `os.replace`), but `cmd_capsule` writes two separate output files (`$dir/capsule.json` and `$STATE_DIR/mission-capsule.json`) as two independent atomic operations — a crash between them leaves the two capsule copies disagreeing, which is exactly the kind of drift a rehydration reader must tolerate.
- WHO WRITES: only if invoked — nothing in `bin/fm-spawn.sh`, `bin/fm-session-start.sh`, or `bin/fm-teardown.sh` on `main` calls `fm-mission.sh`, so on `main` it is dead code with zero call sites.
- WHO READS: `cmd_show` (its own `show` subcommand) only.
- REBUILDABLE?: yes, trivially — it has never been the record of anything, it is an implementation with no data behind it on `main`.
- CURRENT PROBLEM: this is the concrete "two incompatible implementations" the captain's brief anticipated, except neither is canonical: §2a is the one with real overnight data and zero code; §2b is code with a different schema and zero adoption. If §2b were merged as-is and someone ran `fm-mission.sh capsule recovery-sprint-ufd-quota`, it would silently overwrite the richer §2a capsule with the impoverished §2b shape (same output paths, different schema) — a silent schema regression, not a merge conflict.

### 2c. `state/host-checkpoint.json` / `.md` — a third, quota-failover-specific shape

- DATA TYPE: quota-exhaustion failover snapshot — active host, recommended failover host, active task list, one `contextDeltas[]` entry, a `quotaSnapshot` per provider.
- CURRENT OWNER: unknown/not committed — same situation as §2a: no `bin/` script anywhere in any worktree references `host-checkpoint` or `hostCheckpoint`. Written by the `quota-failover-auto-resume` ship task's own logic (per its backlog entry, "done 2026-09-12"), which evidently never landed a durable, reusable checkpoint writer, only the JSON side effect.
- STORAGE: `state/host-checkpoint.json` (machine-readable) + `state/host-checkpoint.md` (presumably a rendered companion, not separately inspected here). Single well-known path, not per-mission.
- DURABILITY: durable file, but single-slot — a second failover overwrites the first with no history.
- ATOMICITY: unknown, writer not in the codebase.
- WHO WRITES: whatever ad hoc code the `quota-failover-auto-resume` task ran; not reproducible from `bin/`.
- WHO READS: nothing found in `bin/` or `.agents/skills/`.
- REBUILDABLE?: no — the `quotaSnapshot` per-provider percentages and the `activeTasks` list at that exact moment are a point-in-time capture with no other record.
- CURRENT PROBLEM: a *third* independent JSON shape for "what should a resuming supervisor know," disjoint from both §2a and §2b, also with no reader.

## 3. `state/*.status`

- DATA TYPE: append-only wake-event log per task (`working:`, `blocked:`, `needs-decision:`, `done:`, etc.).
- CURRENT OWNER: `bin/fm-classify-lib.sh` (parsing/classification), written by the crewmate itself via the `echo ... >> state/<id>.status` contract every brief specifies.
- STORAGE: `state/<task-id>.status`, one line per event, plain text, append-only.
- DURABILITY: durable.
- ATOMICITY: append is atomic at the OS level for small writes (`>>` on a local filesystem), so a torn write across a single line is unlikely but not contractually guaranteed for lines near the pipe/OS buffer boundary; more importantly, the file is explicitly **not** current-state truth (`AGENTS.md` §2: "a wake event, not current-state truth") — it is only ever safe to read as history, never as "what is true right now."
- WHO WRITES: the crewmate/worker itself, once per state transition it chooses to report; also `fm-send.sh`'s reply mechanics append `resolved:`/decision lines on firstmate's behalf.
- WHO READS: `bin/fm-classify-lib.sh` (open-decision folding, incremental via `.<id>.open-decisions-cursor`), `bin/fm-crew-state.sh` (as one input among several), firstmate directly when inspecting a task's tail, `gabriel-os`'s `gateway-work.mjs` (`readFile(... .status ...)`, looking for a trailing `done:` line — see §13).
- REBUILDABLE?: no — this is the only durable record of *why* a task passed through a given state; current-state can be reconciled from Herdr/git, but the narrative ("blocked: daemon socket refused") is only here.
- CURRENT PROBLEM: it is a log, not a state machine — nothing enforces that a `done:` line is actually true (a crewmate can lie or be wrong), nothing prevents two crewmates racing on the same task id from interleaving lines, and every reader must independently re-derive "current state" from the tail plus corroborating evidence (Herdr, git). This is the single biggest reason "archaeology" is required: the authoritative narrative and the authoritative state are different files that can disagree.

## 4. `state/*.meta`

- DATA TYPE: per-task dispatch metadata — worktree path, project, harness, kind, model, effort, backend, Herdr window/tab/pane ids, spawn/busy generation tokens.
- CURRENT OWNER: `bin/fm-spawn.sh` writes it at dispatch; each producing script's header is the field-by-field owner per `AGENTS.md` §2.
- STORAGE: `state/<task-id>.meta`, flat `key=value` lines (confirmed format: `window=`, `endpoint_task_id=`, `worktree=`, `project=`, `harness=`, `kind=`, `tasktmp=`, `model=`, `effort=`, `busy_gen=`, `spawn_gen=`, `backend=`, `herdr_session=`, `herdr_workspace_id=`, `herdr_tab_id=`, `herdr_pane_id=`).
- DURABILITY: durable.
- ATOMICITY: not verified; flat key=value files are typically written once at spawn and read many times, low risk in practice but no explicit temp+rename pattern confirmed.
- WHO WRITES: `bin/fm-spawn.sh` at dispatch; possibly amended by control/relaunch flows (`*.control-relaunch.meta-prior` sidecars observed in `state/`, suggesting relaunch preserves a prior copy before overwriting).
- WHO READS: `bin/fm-crew-state.sh`, `bin/fm-session-start.sh` (fleet-state digest — "every `state/<id>.meta`"), `bin/fm-watch.sh`, `bin/fm-teardown.sh`, essentially every fleet-management script.
- REBUILDABLE?: yes, for the currently-live subset — `herdr api snapshot` (§7) carries an equivalent live view keyed by pane/tab/workspace id and cwd; the static fields (model/effort/harness chosen at dispatch) are only in `.meta` once the Herdr pane itself is gone.
- CURRENT PROBLEM: this is the closest thing to a per-task "current state" record in the fleet, and it is exactly why a replacement supervisor must correlate three things (`.meta`'s Herdr ids, live `herdr api snapshot`, and the backlog's declared state) to know if a task is actually still running — none of the three is sufficient alone, and none references the others by a shared, verifiable key beyond the task id string.

## 5. Durable wake queue (`state/.wake-queue`)

- DATA TYPE: queued wake records awaiting presentation — `epoch<TAB>seq<TAB>kind<TAB>key<TAB>payload`.
- CURRENT OWNER: `bin/fm-wake-lib.sh` (enqueue), `bin/fm-wake-drain.sh` (drain/present/ack).
- STORAGE: `state/.wake-queue`, tab-separated lines; serialized by `state/.wake-queue.lock`.
- DURABILITY: durable — this is explicitly the "don't lose a wake across a restart" mechanism.
- ATOMICITY: lock-protected (`.wake-queue.lock`), so concurrent producers are serialized; presented-but-unacknowledged records remain durable by design (`AGENTS.md` §3: "Presented records remain durable until the handling turn runs the generation-bound acknowledgement").
- WHO WRITES: any script that enqueues a wake (watcher, check scripts, `fm-send.sh` escalation ladder, etc.).
- WHO READS: `bin/fm-wake-drain.sh` at every session start and every wake-handling turn.
- REBUILDABLE?: no in the general case — a wake represents "something happened that firstmate hasn't seen yet"; if lost, the underlying event may still be inferable from `.status`/Herdr/git, but the *notification* itself is gone (this is why it's durable-until-acked rather than best-effort).
- CURRENT PROBLEM: at inspection time the queue was empty (`0 state/.wake-queue`) — the live problem here is not queue mechanics but that this queue is FirstMate-internal and has zero relationship to §2's mission files: a supervisor resuming from a mission capsule gets no wake-queue-shaped signal that, e.g., a captain hold is still open.

## 6. Decision / captain-hold state (`bin/fm-captain-hold.sh`, `data/decision-bindings/`)

- DATA TYPE: "a task held for the captain" — there is deliberately no separate decision type; a hold's identity is the backlog task id itself (see `bin/fm-captain-hold.sh` header).
- CURRENT OWNER: `bin/fm-captain-hold.sh` (mechanics), `.agents/skills/captain-hold-lifecycle/SKILL.md` (policy — the script explicitly refuses to infer intent from prose).
- STORAGE: primarily **inside the backlog task itself** (`data/backlog.md`'s `(hold: ...)` / `(hold-kind: captain)` annotations — confirmed live: `rotate-hub-key`, `gos-memory-arch-decisions`, `computer-use-for-existing-subscriptions-decision-platform-choice`, etc.), plus `data/decision-bindings/` (source→answer-intake bindings; **absent** on this host — lazily created, confirms "created lazily, absent until this home has a learning to store"-style deferred creation) and `state/reconcile-requests/` for open verify-then-decide obligations.
- DURABILITY: durable (backlog is durable; bindings/requests are durable once created).
- ATOMICITY: inherits the backlog's atomicity characteristics (§1) for the primary record; binding/request files are presumably one-file-per-record (lower collision risk than a shared file).
- WHO WRITES: `bin/fm-captain-hold.sh hold/answer/bind/unbind/complete`; ultimately firstmate, invoked per `captain-hold-lifecycle`.
- WHO READS: firstmate at every wake/heartbeat (`AGENTS.md` §8's `RECORD DIVERGENCE` reconciliation), `bin/fm-session-start.sh`'s `OPEN DECISIONS` section.
- REBUILDABLE?: the binding/request plumbing is rebuildable from source events; the captain's actual answer/reasoning text is not — it exists only in the backlog note and (if separately captured) a decision file passed to `answer --decision-file`.
- CURRENT PROBLEM: this is the one source in the inventory with real corruption-blast-radius containment already designed in (task-scoped identity, no monolithic decision table, an explicit "diverged" detection command) — worth treating as a positive existing precedent for §III (options) rather than a problem to fix.

## 7. Herdr worker metadata (`herdr api snapshot`)

- DATA TYPE: live pane/tab/workspace inventory — which terminal panes exist, their `agent`/`agent_session` binding (claude/codex/agy session ids), `agent_status` (idle/working/done/unknown), `cwd` vs `foreground_cwd` (home vs. actual worktree), scrollback offsets, tab labels.
- CURRENT OWNER: the Herdr daemon itself (external process, `/home/gabrielsgrancio/.local/bin/herdr`); FirstMate only consumes it.
- STORAGE: not a file FirstMate owns — a live JSON-RPC-style snapshot (`{"id":"cli:api:snapshot","result":{"snapshot":{...}}}`) queried on demand; Herdr's own persistence (if any) is out of FirstMate's control.
- DURABILITY: live/ephemeral from FirstMate's point of view — it reflects *right now*; there is no durable FirstMate-side copy of a snapshot (some fields are echoed into `.meta` at spawn time, see §4).
- ATOMICITY: n/a (read-only query against a running daemon).
- WHO WRITES: Herdr, driven by actual terminal/process lifecycle.
- WHO READS: `bin/fm-crew-state.sh` (presumably, for liveness), the session-start digest's "one cheap alive/dead read of each task's recorded backend endpoint," and this scout, directly, for this report.
- REBUILDABLE?: n/a — it *is* the ground truth for "is a process actually alive right now," nothing else can substitute for it (it's why `AGENTS.md` insists reconciliation validate against live workers rather than trusting stored state).
- CURRENT PROBLEM: none inherent to Herdr itself, but the *correlation* to FirstMate's own records is manual and string-keyed: a `.meta` file's `herdr_pane_id=w2K:p2` must be matched by eye/grep against a live snapshot's `pane_id` to answer "is `reconciliation-operational-state-architecture` actually alive" — there is no single call that answers that question directly for a given task id.

## 8. Worktree / branch metadata

- DATA TYPE: which worktree, which branch, base sha, head commit, dirty/clean, landing state.
- CURRENT OWNER: git itself (`git worktree list`, `git status`, `git log`) is the ground truth; FirstMate has no separate durable ledger of this beyond what `preserved_worktrees[]` inside a §2a capsule happened to snapshot once.
- STORAGE: the git object database and `.git/worktrees/*` administrative files (not a FirstMate-owned format at all).
- DURABILITY: durable as long as the worktree/branch exists; a torn-down worktree with an unmerged branch still has the branch (if pushed or kept as a local ref) but the working copy is gone.
- ATOMICITY: git's own commit atomicity applies; nothing FirstMate-specific to add.
- WHO WRITES: git, via `fm-spawn.sh` (create), the crewmate's own commits, `fm-promote.sh`/`fm-teardown.sh` (cleanup).
- WHO READS: firstmate ad hoc (`git -C <worktree> status/log`), no committed script was found that produces a durable "task → repo → branch → base_sha → worktree → commits → landing state" record as a single artifact (this is exactly the gap named in `AGENTS.md` §7's Validate section and echoed in the captain's brief re: `ufd-gateway-repair`/`ufd-mcp-probe-fix` sitting "Done" while unmerged).
- REBUILDABLE?: yes, always, from git itself — this is the most rebuildable source in the inventory, *if* you still know which worktree path to look in. The worktree path itself is only recorded in `.meta` (while the task is live) or a §2a `preserved_worktrees[]` snapshot (if one happened to be taken).
- CURRENT PROBLEM: **no durable, task-keyed link from "backlog says Done" to "git says landed."** Confirmed concretely tonight: `ufd-gateway-repair` and `ufd-mcp-probe-fix` are `capsule.json`'s `in_flight_tasks[]` entries with `mode: "local-only"`, and the backlog's own §6 decision entries (`ufd-gateway-repair-merge-decision`, `ufd-mcp-probe-fix-merge-decision`, both `hold_bucket: "live"`, age 0 days, reason: "local-only merge blocked... needs captain's explicit word") show these are explicitly *not yet merged* — this is the live instance of the exact "Done but not delivered" gap the brief calls out.

## 9. Briefs (`data/<id>/brief.md`)

- DATA TYPE: the frozen instructions a crewmate was launched with (captain's intent + firstmate spec + safety scaffold).
- CURRENT OWNER: `bin/fm-brief.sh` (scaffold + generation).
- STORAGE: `data/<task-id>/brief.md`, plus a `launch-brief.md` variant observed alongside it (the exact rendered text actually launched, distinct from the editable `brief.md` — both present for this very task, `reconciliation-operational-state-architecture/{brief.md,launch-brief.md}`).
- DURABILITY: durable (survives teardown — briefs are not in the "discarded worktree" set, they live in `data/`).
- ATOMICITY: single-writer, single-write-then-read in normal operation; low risk.
- WHO WRITES: `bin/fm-brief.sh` at authoring time; firstmate may edit before dispatch.
- WHO READS: the crewmate itself at launch; firstmate/a replacement supervisor later, as the durable record of "what was this task actually asked to do."
- REBUILDABLE?: no — this is the closest thing to "the original captain prompt, scoped to this task" and is not reconstructable from any other source once written (it is itself often a *derivation* of a larger captain ask, so it is not even fully redundant with an upstream mission prompt).
- CURRENT PROBLEM: none structural, but it is per-task, not per-mission — there is no durable link from a brief back to the mission-level prompt it was decomposed from (see §2's `original_ufd_prompt` pointer, which exists at the mission level but has no reciprocal pointer from any task's brief).

## 10. Reports (`data/<id>/report.md`)

- DATA TYPE: the scout's terminal deliverable — findings, evidence, recommendation.
- CURRENT OWNER: the crewmate; `captain-hold-lifecycle`'s completion gate governs when a report may be treated as final.
- STORAGE: `data/<task-id>/report.md`, freeform Markdown.
- DURABILITY: durable, explicitly designed to survive worktree teardown (`AGENTS.md` §7: "A completed scout must leave a self-contained report before its scratch worktree can be discarded").
- ATOMICITY: single-writer; low risk.
- WHO WRITES: the crewmate.
- WHO READS: firstmate (relays findings), a later ship task if promoted, a future supervisor doing archaeology (exactly the pattern this sprint is trying to shortcut).
- REBUILDABLE?: no.
- CURRENT PROBLEM: reports are excellent *evidence* but are not *state* — nothing indexes them by mission, decision, or "supersedes/superseded-by" relationship; the sprint currently under way produced four sibling scout tasks (`reconciliation-overnight-decomposition`, `reconciliation-source-control-inventory`, `reconciliation-stale-base-bug`, this one) whose reports must be manually cross-referenced by a human or a following task, exactly as this brief itself instructs ("Cross-reference `reconciliation-stale-base-bug`'s findings if that task's report is available").

## 11. Context-delta / checkpoint files

- DATA TYPE: two distinct, undocumented, single-slot artifacts.
  - `state/context-deltas.jsonl`: architectural-impact facts harvested during quota-failover events (`{"hasDelta":true,"facts":[...],"architecturalImpact":"...","taskId":"poc-001","harvestedAt":"..."}`), one JSON object per line — despite the `.jsonl` name, only **one line exists** on this host.
  - `state/host-checkpoint.json`/`.md`: covered in §2c.
- CURRENT OWNER: unknown/uncommitted — confirmed absent from every worktree's `bin/` (searched all of `.treehouse`), same as §2a/§2c.
- STORAGE: as named above, directly under `state/`.
- DURABILITY: durable files, but `context-deltas.jsonl`'s single-line-per-run-so-far behavior suggests it is meant to be append-only and has simply only fired once.
- ATOMICITY: unknown, writer not in the codebase.
- WHO WRITES: ad hoc AGY-session logic, same origin as §2a/§2c.
- WHO READS: nothing found in `bin/` or `.agents/skills/`.
- REBUILDABLE?: no — `architecturalImpact` is a synthesized judgment, not derivable from raw logs.
- CURRENT PROBLEM: undocumented in `AGENTS.md`'s `state/` layout entirely; a third or fourth "durable insight" mechanism with no committed reader, alongside §2's mission files. This is the single clearest piece of evidence for the captain's framing: valuable synthesized state is being produced and then never consumed by anything durable.

## 12. Supervisor/session transcripts

- DATA TYPE: full multi-turn conversation/tool-call history for one harness session.
- CURRENT OWNER: each harness's own runtime (Claude Code, Antigravity/Gemini CLI); FirstMate does not manage transcript storage.
- STORAGE:
  - Claude Code: `~/.claude/projects/<sanitized-absolute-cwd>/<session-uuid>.jsonl`. Confirmed the directory name encodes the **full worktree path**, not the task id (e.g. `-home-gabrielsgrancio--treehouse-captain-workspace-7bab20-10-captain-workspace`) — so a transcript is discoverable only if you already know which worktree number a task ran in, and that mapping (task id → worktree path) lives only in the task's now-possibly-deleted `.meta` file or a §2a capsule's `preserved_worktrees[]`.
  - Antigravity (AGY): `~/.gemini/antigravity-cli/brain/<session-uuid>/.system_generated/logs/transcript_full.jsonl`. Confirmed live and referenced concretely by `data/missions/recovery-sprint-ufd-quota/mission.json`'s `original_ufd_prompt.source_transcript` pointer with a `step_index` offset — this is the one place in the whole inventory where a durable record points *into* a transcript by exact coordinate (session id + step index + sha256 of the extracted text) rather than by vague reference.
- DURABILITY: durable on local disk, unbounded growth, no FirstMate-side retention/rotation policy observed.
- ATOMICITY: append-only JSONL from the harness's own runtime; not FirstMate's concern.
- WHO WRITES: the harness process itself.
- WHO READS: nothing in FirstMate reads these routinely; only ad hoc scout tasks (e.g. `agy-context-mining-overnight-branches`, confirmed as a Done backlog entry: "Mine AGY session transcripts for captain's actual decisions") that were explicitly commissioned to mine them.
- REBUILDABLE?: no — this is the single highest-fidelity record of what was actually said and decided, and simultaneously the least indexed. It is genuinely irreplaceable but also, per the brief's own instruction, must never be the *default* rehydration input (too large, wrong shape for routine use).
- CURRENT PROBLEM: transcripts are the ultimate fallback for archaeology and nothing else — there is no lightweight, durable index from (task id | mission id | decision id) → (transcript path, step range). The one exception, `original_ufd_prompt`'s exact pointer, proves the pattern works and is cheap; it just is not applied anywhere else.

## 13. OpenClaw state

- DATA TYPE: agent identity/persona/config, MCP wiring — **not** task or mission state.
- CURRENT OWNER: OpenClaw itself.
- STORAGE: `~/projects/gabriel-os/openclaw/openclaw.json` (agent defaults, model policy, `mcp.servers.gabriel-gateway` wiring to `scripts/context-mcp.mjs`) and `~/projects/gabriel-os/openclaw/workspace/{IDENTITY.md,AGENTS.md,SOUL.md,USER.md,workspace/}`.
- DURABILITY: durable, plain files.
- ATOMICITY: not inspected (out of FirstMate's control).
- WHO WRITES: OpenClaw's own bootstrap/config tooling and, presumably, the captain/agent editing persona files directly.
- WHO READS: OpenClaw at startup.
- REBUILDABLE?: n/a (source-of-truth identity content, not derived data).
- CURRENT PROBLEM: none found for identity/persona itself — this genuinely matches the captain's hypothesis (§ below). The relevant coupling point is `gabriel-os/src/lib/gateway-work.mjs`: it does **not** maintain a competing task database, but it *does* (a) shell directly into `tasks-axi`/`fm-brief.sh`/`fm-spawn.sh`/`fm-crew-state.sh`/`fm-send.sh`/`fm-control.sh` by path (`resolve(firstmateHome, "bin", name)`), and (b) read `state/<id>.status` directly by path to detect a trailing `done:` line as a fallback when `fm-crew-state.sh`'s own state isn't yet terminal. This is real coupling to FirstMate's *internal file layout*, not to a stable API — any rename of `state/<id>.status` or a change in what "done" means at the FirstMate layer silently breaks Gateway's fallback path. There is also a `workspaceStore` inside Gateway that posts its own `work.dispatched`/`work.completed` events — a legitimate, narrow projection (not a competing source of truth), but still a second place "is this task done" gets asserted, now with its own local event id.

## 14. SQLite / other databases

- FINDING: **none in use anywhere in the fleet.** Searched `captain-workspace` (`bin/`, `.agents/skills/`, tree for `*.db`/`*.sqlite*`) and `gabriel-os` (`package.json` for `better-sqlite3`/`sqlite3`, tree for `*.db`/`*.sqlite*`, and `src/`/`packages/` for any embedded-database import). Zero hits (the one incidental match, `package-lock.json` containing the substring `sqlite3`, is a transitive dependency's lockfile entry, not an actual usage in `gabriel-os`'s own source — not further chased since it does not touch task/mission state).
- CURRENT PROBLEM: n/a — this is a clean finding, not a gap. It means recommendation §III below is a genuine "adopt or don't," not "there's already a half-used SQLite file to reconcile with."

---

## Summary table

| # | Source | Owner (committed?) | Durable | Atomic | Rebuildable | Problem severity |
|---|---|---|---|---|---|---|
| 1 | `data/backlog.md` | `tasks-axi` (yes) | yes | tool-dependent | partial | prose-as-schema; sole hold/priority record |
| 2a | `data/missions/*/{mission,capsule}.json` (live schema) | **no** (ad hoc) | yes | unknown | mostly | zero committed writer or reader |
| 2b | `bin/fm-mission.sh` (schema v2) | yes, but unmerged, unused on `main` | yes (atomic writes) | atomic per-file | trivially (no data yet) | incompatible schema, dead on `main` |
| 2c | `state/host-checkpoint.{json,md}` | **no** (ad hoc) | yes, single-slot | unknown | no | third incompatible shape |
| 3 | `state/*.status` | yes (contract, not schema) | yes | append-safe | no | narrative ≠ truth; race-prone |
| 4 | `state/*.meta` | yes | yes | unverified | yes (while live) | 3-way manual correlation needed |
| 5 | `state/.wake-queue` | yes | yes | lock-protected | no (by design) | no link to mission state |
| 6 | captain holds | yes | yes | inherits backlog | partially | best-designed source in inventory |
| 7 | `herdr api snapshot` | external (Herdr) | live only | n/a | n/a (is ground truth) | manual string-key correlation |
| 8 | worktree/branch (git) | git | yes | git-native | yes (if path known) | no Done→Landed link |
| 9 | `data/<id>/brief.md` | yes | yes | low risk | no | no link to mission prompt |
| 10 | `data/<id>/report.md` | yes | yes | low risk | no | not indexed/cross-linked |
| 11 | `context-deltas.jsonl` | **no** (ad hoc) | yes | unknown | no | undocumented, unread |
| 12 | transcripts | harness-native | yes | n/a | no | huge, unindexed, one good exception |
| 13 | OpenClaw | OpenClaw | yes | n/a | n/a | identity only, confirms hypothesis |
| 14 | SQLite | none exists | — | — | — | clean slate |

**Headline finding:** the captain's framing is correct and, if anything,
understated. It is not just that a replacement supervisor must do archaeology
across many sources — three of those sources (§2a, §2c, §11) were built
*specifically to solve this exact problem*, overnight, ad hoc, by an AGY
session, and **none of them has a committed owner or reader**. The fleet
already tried to invent mission-state persistence three times in one night and
each attempt is itself now an archaeology target.
