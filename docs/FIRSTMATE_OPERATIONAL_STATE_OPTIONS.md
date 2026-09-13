# Operational-state architecture: options and evaluation

Companion to `docs/FIRSTMATE_OPERATIONAL_STATE_CURRENT.md` (read that first —
every claim below cites a numbered section there). This document evaluates,
but does not implement, (1) the captain's proposed layering hypothesis and
(2) candidate storage models for a canonical operational-state store. The
decision itself is recorded separately in `docs/FIRSTMATE_OPERATIONAL_STATE_ADR.md`.

## Part 1 — the layering hypothesis

The captain's proposed split:

> OpenClaw = identity + persona + conversational continuity; FirstMate =
> operational mission/work authority; TUI = projection/controller over
> canonical FirstMate state; Git/Treehouse/Herdr = execution/source-control
> substrates.

### OpenClaw — verdict: holds, cleanly

Inspected `~/projects/gabriel-os/openclaw/openclaw.json` and its
`workspace/` (`IDENTITY.md`, `AGENTS.md`, `SOUL.md`, `USER.md`,
`workspace/workspace`). Every file there is identity/persona/model-policy
content. There is no task, mission, or backlog data structure anywhere under
OpenClaw's own config or workspace tree (current-state §13). The hypothesis's
first clause is already true today, not aspirational.

### FirstMate as operational authority — verdict: true in intent, not true in fact

FirstMate is clearly *meant* to be the operational authority — `AGENTS.md` is
built entirely around that idea (backlog, briefs, delivery lifecycle, merge
authority). But current-state §2 shows FirstMate is not currently able to
*answer questions about its own missions*: there is no committed reader for
`mission.json`/`capsule.json` in any shape, and the actual "authority" for
"what mission is active" tonight is a bare pointer file (`state/.active-mission`)
that nothing but a human reads. FirstMate is authoritative over the backlog
(§1) and over task-level dispatch/delivery (§4, §6, §8), but has no
mission-level API at all — "mission" is a concept three different ad hoc
scripts invented independently (§2a/§2b/§2c) with no canonical implementation
landed on `main`. So: **the layer boundary is right, the FirstMate side of it
is currently missing its mission-level surface.**

### TUI as projection/controller over FirstMate — verdict: architecturally true, operationally leaky

Inspected `gabriel-os/src/lib/gateway-work.mjs` (current-state §13 in full).
Findings:

- It genuinely does not maintain a competing task/mission database. Every
  mutating operation (`dispatch`, `followup`, `cancel`) shells directly into
  FirstMate's own CLI surface: `tasks-axi show|add`, `bin/fm-brief.sh`,
  `bin/fm-spawn.sh`, `bin/fm-send.sh`, `bin/fm-control.sh`. This is the
  captain's "both should query it" instruction, followed in spirit.
- But the coupling is to FirstMate's **internal file layout**, not to a
  stable, versioned API: `gateway-work.mjs:51` reads
  `join(firstmateHome, "state", \`${taskId}.status\`)` directly and greps for
  a trailing `done:` line as a fallback when `fm-crew-state.sh`'s own answer
  isn't yet terminal. If FirstMate ever changes what "done" means at that
  layer (a plausible outcome of this very sprint, e.g. distinguishing
  `EXECUTION_DONE` from `LANDED` — see the ADR), Gateway's fallback silently
  breaks or silently returns a wrong answer, because it is reading FirstMate's
  *implementation detail*, not a contract.
- Gateway also keeps its own `workspaceStore` and posts `work.dispatched` /
  `work.completed` events into it, keyed by its own `eventId`. This is a
  legitimate narrow projection (the captain's "controller" role: OpenClaw's
  conversation needs *some* local handle to say "the work you asked about is
  done"), not a second canonical mission database — but it is a second place
  where "is this task done" gets asserted, and nothing currently reconciles a
  Gateway `work.completed` event against FirstMate's own terminal-state
  determination if the two ever disagree (e.g. FirstMate later learns a task
  actually failed CI after Gateway already recorded completion).

**Verdict: no competing canonical database exists today (the specific thing
the captain worried about), but the query surface is coupled to file paths
and string conventions instead of a stable contract.** This is exactly the
shape of problem a `fm get-active-mission`-style read-only query API (Part 4
below, and the rehydration contract) would fix, and TUI/Gateway are natural
first consumers of that same API rather than of `state/<id>.status` directly.

### Git/Treehouse/Herdr as execution substrate — verdict: holds, and is the strongest layer

Confirmed via `herdr api snapshot` (current-state §7): Herdr is a clean,
externally-owned, queryable ground truth for "what processes/panes actually
exist right now," correlated to FirstMate task ids only through the
`herdr_*` fields FirstMate itself writes into `.meta` at spawn time. Git is
equally clean as a substrate (current-state §8) — the only gap is that
nothing durable links a task id to its git outcome across the task's whole
lifecycle, which is a FirstMate-side gap, not a substrate problem.

### The `fm get-active-mission` / `fm resume-context <mission_id>` sketch

Evaluated against current code, not implemented. The proposed
MISSION/PLAN/EXECUTION/SOURCE CONTROL/DECISIONS/RECOVERY section shape maps
cleanly onto sources that already exist but are scattered:

| Sketch section | Current-state source(s) it would draw from |
|---|---|
| MISSION | §2 (whichever becomes canonical — see ADR), §9 (brief-level intent chain) |
| PLAN | §1 backlog (queued/in-progress for this mission's tasks) |
| EXECUTION | §4 `.meta` + §7 Herdr snapshot, correlated |
| SOURCE CONTROL | §8, extended per the ADR's Part 3 (mission→task→repo→branch→commits→landing state) |
| DECISIONS | §6 captain holds bound to this mission's tasks |
| RECOVERY | §3 `.status` tail (event history, explicitly labeled non-authoritative) + §5 any open wake for this mission's tasks |

This confirms the sketch is a reasonable *shape* for the eventual read API,
but two things in it should not be carried forward verbatim, per the
captain's own caveat:

1. There is currently no concept that groups tasks *into* a mission except
   the ad hoc §2a files. A `resume-context <mission_id>` command needs a real,
   canonical mission↔task membership record before it can assemble PLAN or
   EXECUTION sections — that record does not exist today (this is the actual
   prerequisite work, not the command's surface syntax).
2. "RECOVERY" as sketched risks becoming "dump the status tail," which
   `AGENTS.md` and this brief both explicitly warn against conflating with
   current-state truth. RECOVERY should be *reconciled* state (live Herdr +
   git check performed at query time), not a replay of unverified log lines.

## Part 2 — database/storage-model comparison

Compared against: atomic updates, concurrent writers, crash recovery, event
ordering, idempotency, auditability, migration cost, ability to rebuild,
hook compatibility, Router/Herdr compatibility, SessionStart query speed,
corruption blast radius, operational simplicity.

### (A) Current file-based model (as inventoried)

- Atomic updates: inconsistent — §2b proves atomic temp-file+rename is
  achievable in this stack today with zero new dependencies; §1/§2a/§2c/§11
  do not demonstrably use it.
- Concurrent writers: unsafe by default; only §5 (wake queue) and arguably §1
  (via `tasks-axi`, a closed tool, unverified) have explicit lock/serialization.
- Crash recovery: ad hoc per file; no unified WAL/journal concept.
- Event ordering: only §5 has an explicit ordering primitive (`seq`); §3's
  `.status` has implicit ordering by append order but no sequence number, so
  two racing writers can interleave lines with no way to reconstruct true
  order after the fact.
- Idempotency: not designed for — most writers assume single-writer,
  single-pass.
- Auditability: good for what exists (append-only `.status`, git for code),
  bad for the ad hoc JSON blobs (§2a/§2c/§11 have no history, each write is a
  full overwrite with no diff trail beyond whatever backup convention the
  writer happened to use).
- Migration cost: zero (nothing to migrate away from at the infra level) but
  the *format* has already silently drifted three times in one night — the
  "migration cost" is actually being paid continuously, just informally.
- Ability to rebuild: strong for git/Herdr/backlog (§1, §7, §8); weak to zero
  for the ad hoc mission/checkpoint files (§2a/§2c/§11).
- Hook compatibility: this *is* the model hooks already assume; zero friction.
- Router/Herdr compatibility: Herdr is already file/CLI-shaped and integrates
  natively; no impedance mismatch.
- SessionStart query speed: fast for what's read today (`AGENTS.md` §3's
  digest is explicitly bounded/cheap), but that speed is achieved by reading
  narrow, known files — a query that needs to assemble a cross-source mission
  view (the whole point of this sprint) has no single fast read path and must
  fan out across §1/§2/§4/§7/§8 by hand, which is the archaeology problem
  restated.
- Corruption blast radius: contained to one file per incident (a real
  strength — a corrupt `mission.json` for mission X does not affect mission Y
  or the backlog).
- Operational simplicity: highest of any option — no daemon, no schema
  migrations, `grep`/`cat`/`jq` debug anything.

### (B) Consolidated append-only event log + deterministic materialized state

- Atomic updates: strong if implemented as append-with-fsync to a single log
  file (or per-mission log files) — a single append is the unit of atomicity,
  and materialized views are derived, never authored directly.
- Concurrent writers: requires either a single-writer-per-log discipline (one
  log per mission, written only by that mission's active supervisor session —
  plausible, since only one session should be "active" per mission at a time
  per the captain's own single-active-session framing) or a lock exactly like
  §5's `.wake-queue.lock` extended to cover this log too.
- Crash recovery: excellent by construction — replay the log from the last
  known-good materialized checkpoint; a torn final line is detectable
  (truncated JSON) and discardable without losing prior events.
- Event ordering: excellent — this is the model's whole point; every event
  gets a durable sequence number, unlike §3 today.
- Idempotency: natural fit — each event type (mission created, task
  dispatched, worker completed, decision made, ...; this is literally the
  checkpoint-policy event list the brief specifies) can be defined with an
  idempotent apply function, and duplicate delivery (e.g. a retried wake) is
  safe to replay.
- Auditability: excellent — the log *is* the audit trail, strictly better
  than today's overwrite-in-place JSON blobs.
- Migration cost: moderate — requires (i) picking an event schema, (ii)
  writing the materializer, (iii) a one-time backfill/adapter from the
  current `.status`/`.meta`/backlog data (or accepting that history before
  the cutover is unindexed, which is honestly close to true today anyway).
- Ability to rebuild: excellent — the materialized view is *defined* as
  rebuildable from the log by design; this directly satisfies the captain's
  explicit interest in event-driven checkpoints over periodic snapshots.
- Hook compatibility: good — a hook becomes "append one event," which is a
  strictly narrower, more disciplined version of what `.status` already asks
  crewmates to do (`echo "state: note" >> .status`), so the migration for
  callers is small.
- Router/Herdr compatibility: fine — Herdr stays the live-process ground
  truth; the event log only needs to record *decisions and transitions*
  FirstMate itself made (dispatch, teardown, hold), not Herdr's internal
  state, so no new coupling to Herdr internals.
- SessionStart query speed: fast *if* the materialized state is kept current
  incrementally (append triggers a cheap re-derive of just the affected
  mission's view, similar to `bin/fm-classify-lib.sh`'s existing incremental
  `.<id>.open-decisions-cursor` pattern in current-state §3) — this is a
  proven pattern already in the codebase, not a new technique.
- Corruption blast radius: better than a shared SQLite file, worse than pure
  per-mission JSON blobs, if a single fleet-wide log is chosen; per-mission
  logs (one `.jsonl` per mission id) recover the per-mission containment §A
  already has while gaining ordering/idempotency within that mission.
- Operational simplicity: moderate — one new small library
  (append+materialize), no new runtime dependency, still `jq`/`grep`-debuggable
  since it's still JSONL.

### (C) SQLite control-plane store

- Atomic updates: excellent — this is SQLite's core competency (single-file
  ACID transactions).
- Concurrent writers: good with caveats — SQLite serializes writers via its
  own locking; on WSL2/network filesystems (this host is `Linux
  6.6.87.2-microsoft-standard-WSL2` per environment info) SQLite's default
  rollback-journal/WAL locking has known historical rough edges on
  network-mounted paths, though a local ext4/WSL2 filesystem (which this
  appears to be, `/home/...` inside the WSL2 VM, not a `/mnt/c` Windows
  mount) is fine. This is a real but checkable risk, not a blocker, and
  should be explicitly verified (not assumed) before adoption.
- Crash recovery: excellent (WAL mode, well-tested).
- Event ordering: excellent (autoincrement PK or explicit sequence column).
- Idempotency: same as any RDBMS — enforceable via unique constraints.
- Auditability: good if an explicit `events` table is kept (mirroring option
  B) rather than only mutable `missions`/`tasks` rows; mutable-only rows with
  no history table would be a regression from today's append-only `.status`.
- Migration cost: highest of the three real options — new dependency
  (`better-sqlite3` or similar; confirmed **zero** existing SQLite usage
  anywhere in this fleet per current-state §14, so this is a first
  introduction, not an extension), schema design, a migration/backfill tool,
  and every consumer (hooks, `fm-crew-state.sh`, Gateway, a future TUI) needs
  a new client library instead of `cat`/`jq`.
- Ability to rebuild: good if events are retained (same as B); if only
  current-state tables are kept, worse than B or A for the ad hoc-JSON
  sources that are already weak on this axis (§2a/§2c/§11 — moving them into
  mutable SQLite rows without an event table would make them *less*
  auditable than they are today, not more).
- Hook compatibility: worst of the three — every hook call site that
  currently does `echo ... >> file` would need a SQLite client invocation
  instead (a CLI wrapper script mitigates but doesn't eliminate this).
- Router/Herdr compatibility: neutral — no direct interaction either way,
  but adds a real question the brief itself flags: is Router (in `gabriel-os`)
  expected to talk to this store directly, or only through a FirstMate CLI?
  Not resolved by this sprint; flagged as an open question for whoever
  implements.
- SessionStart query speed: excellent — this is SQLite's strongest argument;
  one indexed query answers what today requires fanning out across §1/§2/§4/§7.
- Corruption blast radius: **worst of the three by a significant margin** if
  a single shared `.db` file is used for the whole fleet — one corrupted
  SQLite file (a real risk on ungraceful power loss without WAL, or on a
  network filesystem) can take down every mission's state at once, a sharp
  regression from today's one-file-per-incident containment (current-state
  §2a explicitly notes this as a *strength* of the current model). This is
  mitigable (WAL mode, regular `VACUUM INTO` backups, or per-mission database
  files instead of one shared file) but is not free and must be designed for
  explicitly, not assumed away.
- Operational simplicity: lowest of the three — needs a schema, a migration
  tool, and either an ORM-lite layer or hand-written SQL in bash-callable
  form; the brief's own scoping constraint ("never a dump for transcripts or
  repository content") is easy to violate by convenience once a database
  exists (the temptation to "just add a `transcripts` table" is real and
  should be resisted explicitly if this path is ever chosen).

### (D) Existing FirstMate storage abstraction to reuse

Searched explicitly per the brief's instruction:

- `bin/fm-tasks-axi-lib.sh`: **not a storage abstraction** — it is a
  compatibility/version-probe shim around the external `tasks-axi` binary
  (memoizing whether the installed version is new enough and exposes the
  right flags). It has no read/write primitives of its own to reuse for
  mission state; `tasks-axi`'s actual storage internals are outside this
  repo (a separate, closed tool) and out of scope to adopt as the general
  operational-state store, since it is scoped to the backlog specifically.
- `bin/fm-mission.sh` (current-state §2b): the closest thing to a reusable
  abstraction that already exists — atomic temp-file+rename JSON writes,
  a `show` reader, a clean small command surface. **This is the strongest
  candidate for "tiny adaptation" the brief allows**, but it is not currently
  a drop-in reuse: its schema (v2) is incompatible with the only schema that
  has real data behind it (v1, current-state §2a), it has zero call sites on
  `main`, and it does not yet model events/idempotency/mission↔task
  membership at all — adopting it as-is would still require the same design
  work as option (B), just starting from its atomic-write helper instead of
  from scratch.
- `bin/fm-captain-hold.sh` (current-state §6): not a general storage
  abstraction, but its *design pattern* is worth reusing regardless of which
  storage option is chosen — task-id-scoped identity (no separate ID
  namespace to keep in sync), explicit divergence detection (`diverged`
  subcommand), and policy/mechanics separation (`captain-hold-lifecycle`
  SKILL.md owns semantics, the script owns only mechanics). Any of options
  B/C should copy this separation rather than re-litigate it.
- `bin/fm-classify-lib.sh`'s incremental cursor pattern
  (`.<id>.open-decisions-cursor`, current-state §3): a genuinely reusable
  *technique* (bound the cost of re-deriving state to new appended data since
  last cursor) that directly informs how option (B)'s materializer should be
  built, regardless of final verdict.

**No existing abstraction is a full drop-in.** `fm-mission.sh` is the one
piece of code worth carrying forward with modification (its atomic-write
primitive and command shape); the captain-hold and classify-lib *patterns*
are worth reusing regardless of the storage verdict. This comparison feeds
directly into the ADR's verdict.
