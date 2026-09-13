# Supervisor rehydration contract (design, not implemented)

Companion to `docs/FIRSTMATE_OPERATIONAL_STATE_CURRENT.md` and
`docs/FIRSTMATE_OPERATIONAL_STATE_OPTIONS.md`/`_ADR.md`. This document designs
the intended SessionStart/supervisor-rehydration sequence and the checkpoint
policy that must feed it. It is a contract for a future implementation, not
code, per the brief's explicit "do not implement beyond a documented
contract."

## Design goals, restated from the brief

- A replacement supervisor must be able to continue immediately without
  performing archaeology across backlog files, `state/`, Herdr, git,
  worktrees, and harness transcripts.
- The bootstrap context must stay compact enough for routine use. Transcripts
  are recovery evidence, not the primary operational-state store — never
  inject a full transcript by default.
- Reconcile against live workers/worktrees; never just trust stored state.

## Startup sequence

```
1. Load Captain identity (OpenClaw)
2. Query active FirstMate mission(s)
3. Load durable mission/resume state (materialized view, per the ADR)
4. Validate against live workers/worktrees (reconcile, don't trust)
5. Render a concise Supervisor Resume Context
6. Continue from the exact next action
```

Each step below states what exists today (per the current-state inventory),
what's missing, and the minimal new surface this design proposes — again,
as a contract to build against later, not as code delivered now.

### Step 1 — Load Captain identity (OpenClaw)

Today: `AGENTS.md` §3 already runs `bin/fm-session-start.sh` once per
session and reads `data/captain.md`/`data/captain-shared.md` as the
domain-local/shared captain-preference record. OpenClaw's own identity files
(`~/projects/gabriel-os/openclaw/workspace/{IDENTITY.md,SOUL.md,USER.md}`)
are a separate, cleanly-scoped identity layer per the options doc's Part 1
verdict. **No change needed here**: this step is not FirstMate's problem to
solve, and this design does not propose merging OpenClaw identity into
FirstMate's own captain-preference files. The one thing worth stating
explicitly as a contract boundary: FirstMate's rehydration output (step 5)
should be renderable *without* requiring OpenClaw identity to be loaded
first — the two are independent inputs to whatever ultimately talks to the
captain, not a strict pipeline where one blocks the other.

### Step 2 — Query active FirstMate mission(s)

Today: `state/.active-mission` is a bare pointer file with no reader on
`main` (current-state §2a). This design proposes a single new read-only
query, `fm mission active` (naming illustrative, not prescriptive per the
brief's own caveat against assuming the exact command shape), that:

- Returns zero, one, or many active mission ids. **Zero or many must both be
  legal answers**, not error cases — the live host tonight has three mission
  directories (`recovery-sprint-ufd-quota`, `e2e-supervisor-failover-test`,
  `--next`) simultaneously, which the current single-slot
  `state/.active-mission` pointer cannot even represent (it holds exactly one
  string). Multiple concurrent missions are evidently a real operating mode
  for this fleet, not an edge case to design away.
- Is answerable without touching Herdr or git — this step is "what does
  FirstMate's own durable record say," reconciliation happens in step 4.

### Step 3 — Load durable mission/resume state

Today: three incompatible ad hoc schemas (current-state §2a/§2b/§2c), none
committed/read on `main`. Per the ADR, this becomes: for each active mission
id from step 2, read its materialized view (derived from that mission's
event log, per the ADR's `ADAPT_TO_EVENT_STORE` verdict). The materialized
view's shape should answer, at minimum:

- `intent` and a pointer to the original captain prompt (see Checkpoint
  Policy below for how that pointer must be preserved).
- Task membership: which backlog task ids belong to this mission, and each
  one's last known `delivery_state` (per the ADR's four-value model:
  `EXECUTION_DONE` / `DELIVERY_READY` / `LANDED` / `VERIFIED_LANDED`).
- Open decisions: which of this mission's tasks currently have an open
  captain hold (current-state §6), by reference, not by copying hold text
  into the mission view — the backlog stays the single source of truth for
  hold content, the mission view just indexes into it.
- Recorded worktrees/branches for tasks not yet `VERIFIED_LANDED`.
- Session history: which harness sessions have run against this mission and
  how each ended (superseded, quota-exhausted, completed, crashed) — this is
  the one piece of §2a's schema that is genuinely worth keeping conceptually
  (it already answers "why did the last session stop," which is exactly the
  first question a replacement supervisor asks).

This read must be **fast and bounded** — one materialized-view file per
mission, not a fan-out query, consistent with `AGENTS.md` §3's existing
constraint that the session-start digest stays compact.

### Step 4 — Validate against live workers/worktrees (reconcile, don't trust)

This is the step most current tooling already does well and that the new
mission layer must not bypass. Concretely, for each task the mission view
lists as not yet terminal:

1. Cross-reference `state/<id>.meta`'s `herdr_pane_id` against a live
   `herdr api snapshot` (current-state §7) — if the pane is gone or the
   `agent_status` disagrees with the mission view's belief, the mission view
   is stale for that task, and the live read wins.
2. For any task the mission view (or backlog) claims is `LANDED`, re-verify
   via the guarded clone-refresh path `AGENTS.md` §8 already specifies rather
   than trusting the stored flag — this is precisely what promotes a
   `LANDED` claim to `VERIFIED_LANDED` (ADR, Source Control section) and is
   the concrete fix for tonight's `ufd-gateway-repair`/`ufd-mcp-probe-fix`
   situation: a supervisor must not report either as delivered without this
   check, no matter what any stored JSON says.
3. Any disagreement found here should itself become a new event appended to
   that mission's log (a `reconciliation_correction` event type), not just a
   transient in-memory correction — otherwise the next supervisor rehydration
   repeats the same stale belief until the next reconciliation happens to
   catch it again.

This step is deliberately **not** a full transcript replay. It uses exactly
the sources current-state marks as ground truth (Herdr, git) and nothing
larger.

### Step 5 — Render a concise Supervisor Resume Context

Target shape (illustrative field list, not a literal schema):

```
MISSION      <id>, intent (one line), original-prompt pointer
PLAN         open backlog tasks belonging to this mission, with priority/hold flags
EXECUTION    per non-terminal task: current delivery_state, live/dead (from step 4), worktree path
SOURCE CONTROL  per task: repo, branch, base_sha, head commit, delivery_state
DECISIONS    open captain holds referenced by task id (not duplicated text)
RECOVERY     last session's end reason (from mission view) + any open wake (state/.wake-queue) touching this mission's tasks
```

Compactness constraint: this must fit the same "routine use" budget
`AGENTS.md` §3 already holds the ordinary session-start digest to
(`config/startup-memory-budget`, ~7,500 estimated tokens per
`docs/configuration.md`) — it is additive to, not a replacement for, that
existing digest, and should reuse its existing per-task compact-listing
conventions rather than inventing a new verbose format.

### Step 6 — Continue from the exact next action

Today: §2a's `recommended_next_step` field proves this is already a valued
output (a free-text pointer into the pending backlog), but it is currently
synthesized ad hoc with no visible derivation rule. This design proposes it
be a **derived** field, not free text: the highest-priority backlog task
among this mission's PLAN section with no unresolved blocking dependency and
no open captain hold, using the same dependency/time-gate logic
`AGENTS.md` §10 already specifies for backlog re-evaluation ("dispatching
items only when dependencies and time gates have cleared"). If no such task
exists (everything is blocked or held), step 6 should say so explicitly
rather than recommending nothing — an empty recommendation is itself
information a supervisor needs.

## Checkpoint policy

Per the brief: prefer event-driven checkpoints over periodic snapshots where
event-derived state suffices. Proposed event vocabulary (feeding the ADR's
event-log design), each carrying enough evidence to make its effect on the
materialized view idempotent and auditable:

- `mission_created` — id, intent, original-prompt pointer (see below).
- `session_started` / `session_ended` — harness, session id, end reason
  (supersede/quota-exhausted/completed/crashed) — direct carry-over from
  current-state §2a's `sessions[]`/`sessions_history`, now as events instead
  of an overwritten array.
- `task_dispatched` — task id, worktree, harness, repo, base_sha.
- `task_execution_done` / `task_blocked` / `worker_completed` — mirrors the
  existing `.status` contract's `done:`/`blocked:` vocabulary (current-state
  §3) so crewmates need no new reporting habit; the event store's ingestion
  can subscribe to the existing `.status` append or (cleaner, longer-term)
  the append itself becomes the event, per the ADR.
- `captain_hold_created` / `captain_hold_resolved` — task id, reason,
  resolution — mirrors `bin/fm-captain-hold.sh`'s existing `hold`/`answer`
  calls (current-state §6); these calls are the natural place to also emit
  the mission-level event, since they already have the task id and mission
  membership is a task-level property.
- `worktree_created` / `commit_produced` — repo, worktree path, branch,
  commit sha — feeds the ADR's source-control chain directly.
- `task_delivery_ready` / `task_landed` / `task_verified_landed` — the ADR's
  four-value delivery-state model, each carrying its evidence (PR URL, merge
  commit, or fast-forward commit).
- `phase_transition` — free-form, for mission-specific milestones that don't
  fit the above (keeps the vocabulary from needing to anticipate every
  mission shape up front).
- `supervisor_handoff` — reason: quota-low-planned, quota-exhausted,
  explicit-restart, crash — this is the event type current-state §2c's
  `host-checkpoint.json` was informally trying to be; folding it into the
  per-mission event log removes the need for a separate single-slot
  fleet-wide checkpoint file, and preserves *history* of handoffs instead of
  overwriting the last one.
- `supervisor_termination` — for a clean, deliberate stop (distinct from a
  crash, so `session_ended`'s end-reason vocabulary and this event should
  share the same enum rather than drift into two overlapping taxonomies).

**Deliberately excluded from the checkpoint vocabulary**: periodic
"heartbeat" snapshots. `AGENTS.md` §8 already has a `heartbeat:` wake concept
for fleet-wide review; this design does not propose a second, mission-scoped
heartbeat/snapshot mechanism, since every state transition worth capturing
is already covered by an event type above, and a periodic snapshot would
reintroduce the "which copy is authoritative, the snapshot or the derived
view" ambiguity the event-log model exists to remove.

### Preserving the original captain prompt

Current-state §2a's `original_ufd_prompt` field is a genuinely good, working
precedent:

```json
"original_ufd_prompt": {
  "file": "data/missions/recovery-sprint-ufd-quota/original-ufd-prompt.md",
  "sha256": "3d79af3b87a2c3a01930746bc327ce4f4457ca1c1c54e5635a27ea7558eee53b",
  "source_transcript": ".../transcript_full.jsonl",
  "step_index": 2827,
  "classification": "EXACT_RECOVERED"
}
```

This pattern **does generalize**, and should be adopted as the standard
`mission_created` event payload shape, for two concrete reasons observed in
this inventory:

1. It gives three independent ways to verify the prompt text later (the
   extracted file, its hash, and an exact transcript coordinate), which is
   strictly better than any single-source pointer — if the extracted file is
   ever edited or corrupted, the sha256 catches it; if the transcript is ever
   rotated away, the extracted file + hash still stand alone.
2. The `classification: "EXACT_RECOVERED"` field is itself valuable and
   should be kept as an enum (e.g. `EXACT_RECOVERED` / `RECONSTRUCTED` /
   `SUMMARIZED`) — a rehydration reader needs to know whether it's looking at
   the captain's literal words or a session's best reconstruction of them,
   and today's field already draws that distinction correctly.

The one gap in the existing pattern: it depends on the source transcript
still existing at its recorded path (current-state §12 notes transcripts
have no retention/rotation policy, so this is not guaranteed forever). The
`file` + `sha256` pair is what makes that acceptable — the transcript
pointer is corroborating provenance, not the only copy, and rehydration
should always be able to satisfy step 3 above from the extracted `file`
alone even if `source_transcript` has since been rotated away.

For missions with no dramatic "recovered from a dying session" origin
(the common case — a captain typing an ordinary ask), the same shape still
applies with `classification: "EXACT_RECOVERED"` and no transcript pointer
needed at all: the brief text itself (current-state §9) is already an
adequate `file`, and a `sha256` of it costs nothing extra to record at
`mission_created` time.
