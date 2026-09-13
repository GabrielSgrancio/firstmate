# ADR: FirstMate operational-state storage model

- Status: Proposed (research/design deliverable — no migration performed)
- Date: 2026-09-13
- Authors: crewmate `reconciliation-operational-state-architecture` (scout), for captain review
- Format note: this repo has no `docs/adr/` directory and no prior ADR was
  found anywhere in this fleet (`captain-workspace` or `gabriel-os`) to use as
  a template — the brief's pointer to "this project's ADR format" does not
  currently resolve to an existing example. This document uses a conventional
  Context/Decision/Consequences/Alternatives ADR shape and can seed
  `docs/adr/0001-operational-state-storage.md` if the captain wants `docs/adr/`
  established as a going-forward convention; that is a naming/placement
  choice for whoever lands this, not decided here.

## Context

See `docs/FIRSTMATE_OPERATIONAL_STATE_CURRENT.md` for the full inventory and
`docs/FIRSTMATE_OPERATIONAL_STATE_OPTIONS.md` for the comparison this verdict
is drawn from. In short: operational truth about missions and tasks is
scattered across at least 14 distinct source kinds, three of which
(`data/missions/*/{mission,capsule}.json`, `state/host-checkpoint.{json,md}`,
`state/context-deltas.jsonl`) are undocumented, ad hoc, single-slot JSON
blobs written by AGY sessions during last night's overnight sprint with **no
committed writer or reader anywhere in the fleet**. A fourth attempt,
`bin/fm-mission.sh`, is committed but sits unmerged on a scratch worktree's
branch with a schema incompatible with the live data, and has zero call
sites on `main`. No SQLite or other database is in use anywhere in the fleet
today (checked `captain-workspace` and `gabriel-os` exhaustively).

## Decision

**Verdict: `ADAPT_TO_EVENT_STORE`.**

Adopt option (B) from the options doc — a consolidated, per-mission,
append-only event log with a deterministic, incrementally-derived
materialized view — rather than introducing SQLite or continuing the current
ad hoc overwrite-in-place JSON pattern. Concretely, and still without
implementing any of it in this sprint:

1. **One append-only event log per mission**, not one fleet-wide log and not
   one log per task. Rationale: preserves the current model's best property
   (corruption blast radius contained to one mission, current-state §2a),
   while fixing its worst property (no ordering, no idempotency, no audit
   trail for the ad hoc JSON blobs).
2. **The materialized `mission.json`/`capsule.json`-equivalent view is
   derived, never hand-written.** Nothing writes the "current state" file
   directly again — every writer appends an event; a single materializer
   function re-derives the view, following the exact incremental-cursor
   pattern `bin/fm-classify-lib.sh` already uses for open-decision folding
   (current-state §3) rather than a full replay on every read.
3. **Reuse, don't discard, `bin/fm-mission.sh`'s atomic-write primitive**
   (`tempfile.mkstemp` + `os.replace`, current-state §2b) as the write
   primitive for both the event log append and the materialized-view
   snapshot write. This is the "tiny adaptation of an existing abstraction"
   the brief explicitly permits — its command surface (`init`,
   `session-start`, `session-end`, `capsule`, `show`) is a reasonable
   starting shape for the eventual event-appending CLI, but its v2 schema is
   discarded in favor of an events-in/materialized-view-out design; its
   sessions concept survives as one event type among several.
4. **Reuse the `bin/fm-captain-hold.sh` design pattern**, not its code: keep
   decision/hold identity scoped to the backlog task id (no new ID
   namespace), and give the mission-event store its own explicit
   `diverged`-style detection command from day one rather than adding one
   after the first drift incident.
5. **SQLite is explicitly not recommended for this control plane**, for three
   concrete reasons drawn from the options comparison, not from unfamiliarity
   with SQLite: (a) it is a new runtime dependency in a fleet that has zero
   existing SQLite usage to amortize the cost against; (b) a single shared
   `.db` file inverts the current model's best safety property — one
   corruption event would take down every mission's state simultaneously
   instead of one mission's; (c) every hook and every consumer (Gateway,
   a future TUI, crewmates via the `.status` append contract) currently
   speaks "append a line to a file," and SQLite would require a client
   library at every one of those call sites for no query-speed win the event
   log doesn't already provide once materialized views are cached.
   If a future sprint still wants SQLite specifically for cross-mission
   analytical queries (e.g. "show me every hold older than 7 days across all
   missions"), that is a legitimate *read-side* addition — a SQLite index
   rebuilt from the event logs, never the source of truth — and should be
   revisited only if the materialized-JSON-view query path actually proves
   too slow in practice, which nothing in this sprint's evidence suggests
   yet (`AGENTS.md` §3 already reads dozens of `.meta`/`.status` files at
   every session start within its stated compact budget).

This verdict is `ADAPT_TO_EVENT_STORE` rather than pure `REUSE_EXISTING`
because no existing FirstMate abstraction implements the event-log-plus-materialized-view
idea end to end; it is not `KEEP_FILE_BASED` because the current model has
already independently produced three incompatible, unread, ad hoc JSON
schemas in one night, which is evidence the current model does not hold up
under real use, not merely a theoretical risk; it is not `USE_SQLITE` for
the reasons above.

## Consequences

- **Positive:** every mission-state write becomes an idempotent, ordered,
  auditable event; a replacement supervisor's rehydration query
  (`docs/SUPERVISOR_REHYDRATION_CONTRACT.md`) reads one cheap materialized
  view per mission instead of fanning out across backlog/state/Herdr by hand;
  corruption blast radius stays contained per mission; no new runtime
  dependency; the existing `.status` append contract crewmates already know
  becomes a special case of "append an event," not a parallel concept to
  learn.
- **Negative / cost:** requires actually designing the event schema and
  writing the materializer (not done in this sprint, by instruction); every
  current ad hoc writer (§2a/§2c/§11's sources) needs to be ported to append
  events instead of overwriting JSON, which is real migration work, not free;
  until that port happens, the three ad hoc sources remain exactly as
  unreliable as documented in the current-state inventory.
- **Explicitly deferred, not decided here:** the exact event schema/type
  list (the checkpoint policy in `SUPERVISOR_REHYDRATION_CONTRACT.md`
  proposes the event vocabulary but not the on-disk record format); whether
  `docs/adr/` becomes a standing convention; whether Router/Gateway are ever
  given write access to mission events or remain read-only consumers of the
  materialized view (recommend read-only, consistent with the captain's
  "both should query it" instruction evaluated in the options doc).

## Alternatives considered

See `docs/FIRSTMATE_OPERATIONAL_STATE_OPTIONS.md` Part 2 for the full
comparison. Summary: (A) keep file-based as-is — rejected, already failing
in observable ways tonight; (C) SQLite control-plane store — rejected for
this sprint per the reasons above, not ruled out forever as a read-side
index; (D) reuse an existing abstraction wholesale — no candidate was a full
drop-in, but `fm-mission.sh`'s atomic-write primitive and
`fm-captain-hold.sh`'s design pattern are explicitly carried forward into the
adapted design rather than discarded.

---

## Source control feeding mission state

(Brief item 6 — placed here rather than in the rehydration contract because
it is fundamentally a data-model question the event store above must
represent, not a startup-sequence question.)

### The gap, concretely

Confirmed live tonight: `capsule.json`'s `in_flight_tasks[]` lists
`ufd-gateway-repair` and `ufd-mcp-probe-fix` as `mode: "local-only"`, and
`data/backlog.md` independently carries two open captain-hold entries,
`ufd-gateway-repair-merge-decision` and `ufd-mcp-probe-fix-merge-decision`
(both `hold_bucket: "live"`, age 0 days, reason: "local-only merge blocked...
needs captain's explicit word"). Meanwhile the backlog's own Done section
lists `supervisor-failover-hardening` and `openclaw-tui-fm-integration-hardening`
as `(done 2026-09-13)` with no distinct marker for whether their branches
actually landed anywhere. This is the exact failure mode the captain named:
"a task should never be considered delivered merely because worker execution
ended."

### The minimal durable chain

A mission-state event store should be able to represent, per task, this
exact chain without inference:

```
mission → task → repo → target_branch → base_sha
        → worktree_path → worker_branch
        → commits[] (sha, message, authored_at)
        → delivery_state
```

Where `delivery_state` is one of four explicit values, not a single
"done"/boolean:

- `EXECUTION_DONE` — the worker's own process/session ended and reported a
  terminal status line (`.status` tail says `done:`), but nothing has
  checked git or the forge yet. This is what today's `.status`-only check in
  `gabriel-os/src/lib/gateway-work.mjs` (current-state §13) actually proves —
  no more, no less — and it should be labeled as such rather than surfaced
  as `done`.
- `DELIVERY_READY` — a PR exists and (for `no-mistakes`/`direct-PR` modes)
  CI is green, or (for `local-only` mode) the branch is clean and ready for
  the guarded fast-forward, but merge/landing has not happened. This is
  exactly the state `ufd-gateway-repair`/`ufd-mcp-probe-fix` are in right
  now, correctly reflected by their open backlog holds but *not* reflected
  anywhere in `capsule.json`'s flat `in_flight_tasks[]` list, which has no
  delivery-state field at all.
- `LANDED` — the merge/fast-forward has actually happened: for a PR, the
  forge reports it merged; for local-only, `bin/fm-merge-local.sh`'s guarded
  fast-forward has run. This is a fact obtainable from git/the forge, not
  from a worker's self-report.
- `VERIFIED_LANDED` — `LANDED`, plus the landing has been independently
  confirmed by the same clone refresh path `AGENTS.md` §8 already specifies
  ("When any wake reports a merged PR for a project cloned in this home,
  refresh that clone through the guarded fleet-sync path") — i.e., a second,
  independent read confirms the commit is actually reachable from the target
  branch in a freshly-synced clone, not just that a merge API call returned
  success.

A task's event stream would carry `delivery_state` transitions as first-class
events (`task_execution_done`, `task_delivery_ready`, `task_landed`,
`task_verified_landed`), each carrying the concrete evidence (PR URL, merge
commit sha, or fast-forward commit sha) rather than a bare boolean. This
directly satisfies the brief's cross-reference instruction: whatever
`reconciliation-stale-base-bug` finds about stale-base failures is evidence
for *why* `LANDED` must be independently re-verified rather than trusted from
a single merge-time check (a base that moved between merge-request and
actual merge is precisely a case where a naive `LANDED` flag would be wrong
and `VERIFIED_LANDED`'s independent re-check would catch it). This scout did
not have that report available at inspection time
(`data/reconciliation-stale-base-bug/` contained only `brief.md`/
`launch-brief.md`); whoever implements this design should re-read that report
once available and confirm the `VERIFIED_LANDED` re-check step actually
covers the failure mode it found.

### Why this belongs in the event store, not a bolt-on

`delivery_state` is not derivable from any single existing source: `.meta`
doesn't have it, `.status` only proves `EXECUTION_DONE` at best, the backlog's
hold annotations prove `DELIVERY_READY` only by convention (a human/crewmate
chose to phrase a hold that way), and git alone can't distinguish "never
delivered" from "delivered by a path this store doesn't know to check." The
event-log model recommended above is what makes it possible to record each
transition with its evidence once and derive a trustworthy materialized
answer at query time, instead of re-deriving "is this actually landed" by
hand for every replacement supervisor — which is the concrete instance of
"archaeology" the captain named `ufd-gateway-repair`/`ufd-mcp-probe-fix` as
examples of tonight.
