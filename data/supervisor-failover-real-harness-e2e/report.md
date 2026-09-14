# Supervisor failover: real-harness E2E (campaign round 2 of 2)

## Delivered

Two new fixtures replace the harness-endpoint stand-ins from round 1
(`tests/fixtures/supervisor-rehydration/supervisor-a.mjs` and
`supervisor-b.sh`) with real vendor CLI invocations:

- `tests/fixtures/supervisor-rehydration/supervisor-a-real.mjs` - identical
  Router V2 dispatch and mission-event-store bootstrap to the fixture-only
  `supervisor-a.mjs`, but the tracked supervisor endpoint itself is a real
  `claude` process (`-p`, `--model claude-haiku-4-5-20251001`,
  `--dangerously-skip-permissions`) that performs the disposable trivial task
  for real inside the preserved worktree, then blocks on a bounded `sleep 20`
  tool call so the process stays alive and killable.
- `tests/fixtures/supervisor-rehydration/supervisor-b-real.sh` - the
  `FM_SUPERVISOR_COMMAND_CODEX` target the real, unmodified
  `bin/fm-supervisor-launch.sh` invokes on failover. It decodes the delivered
  launch-brief exactly as the fixture-only `supervisor-b.sh` did, then hands
  the decoded resume context to a real `codex exec` process (sandbox
  `workspace-write`), which must resolve the context's original-prompt
  pointer, read the preserved worktree, and decide for itself whether the
  task is already done.

The new acceptance test is
`tests/fm-supervisor-failover-real-harness-e2e.test.mjs`. It is a live,
quota-spending test and is opt-in only: it is skipped unless
`FM_LIVE_SUPERVISOR_REAL_HARNESS_E2E=1` (or `FM_LIVE=1`) is set, matching the
`firstmate-coding-guidelines` "Harness-dependent checks" live-guard
convention, and never runs as part of a default `node --test` sweep.

`docs/SUPERVISOR_REHYDRATION_E2E.md` gained a "Real-harness proof" section
pointing at this test; the mechanism prose it already owned was not
duplicated.

## Scope

Everything in `bin/fm-supervisor-continuity.sh`, `bin/fm-supervisor-launch.sh`,
`bin/fm-mission.sh`, `bin/fm-orchestrator-api.mjs`, `bin/fm-operational-input.sh`,
and `bin/fm-supervisor-route.sh` is untouched, real, production code, identical
to round 1. The only new code is the two harness-endpoint fixtures and their
test. The dispatched "worker" (`synthetic-worker.sh`) is deliberately still
synthetic: the captain's round-2 ask names Supervisor A and Supervisor B as
the real-harness endpoints, not the dispatched worker, and keeping the worker
synthetic keeps the mission cheap and fast without touching what this round
was asked to prove.

## Why two different real harnesses (claude for A, codex for B)

The captain's brief allowed "using the same harness for both A and B ... is
fine and simpler; using two different ones is a nice-to-have, not required."
I found, empirically, that using the same harness for both is not actually
available without either lying about which harness Supervisor A used, or
patching `bin/fm-supervisor-route.sh` (out of scope): `failover_once` in
`fm-supervisor-continuity.sh` hard-refuses when the routed replacement
harness equals the recorded dead harness
(`[ "$new_harness" != "$old_harness" ]`), and Router V2's
`fm-supervisor-route.sh` genuinely excludes every route belonging to the dead
harness before scoring. Recording Supervisor A's session as `claude` (true,
since it now really is a `claude` process) causes Router V2 to exclude every
`claude` route and select `codex` (confirmed for free, no quota spent, with
`FM_SUPERVISOR_USE_LIVE_QUOTA=0` directly against the real
`bin/fm-supervisor-route.sh` and the test's own router-v2 fixture catalog:
`Router V2 excluded 3 claude RouteTargets and selected route=codex:gpt-5.6-terra:medium
harness=codex scarcity=ABUNDANT`). So A=claude, B=codex is not an arbitrary
choice made for variety; it is what an honest harness label plus the real,
unmodified routing exclusion rule produces.

## Acceptance proof, per criterion

All six pass in a single real run (`tests/fm-supervisor-failover-real-harness-e2e.test.mjs`,
mission `rehydration-real-harness-e2e`, task `rehydration-real-harness-task`),
asserted directly against real process state and real harness output, not a
fixture standing in for either:

1. **mission_id preserved**: `assert.equal(record.mission_id, missionId)` -
   the continuity replacement record, read from the real
   `state/supervisor-continuity-replacement.json` the real service wrote,
   carries the exact mission id the real Supervisor A (`claude`) was working.
2. **task graph preserved**: `assert.match(context, /TASK GRAPH.*rehydration-real-harness-task/)` -
   the resume context the real `fm-mission.sh resume-context` rendered inside
   the real launch adapter includes the exact task id.
3. **worktree/branch preserved**: `assert.match(context, /worktree=<worktree path>/)`
   and `/branch=fm\/rehydration-real-harness-task/` - the exact worktree path
   and branch Supervisor A's dispatch recorded are present in the delivered
   context, and it is the same worktree the real `codex` process is later
   pointed at.
4. **progress preserved and genuinely acted on, not just received**: this is
   the criterion a fixture-only proof can only gesture at. Concretely:
   the real `claude` process appended the exact line
   `SUPERVISOR-FAILOVER-MARKER` to `<worktree>/progress.txt` before being
   killed (`assert.match(progressAfterA, /SUPERVISOR-FAILOVER-MARKER/)`).
   The real `codex` process, given only the delivered resume context (which
   references the original prompt by pointer and hash, never inline text),
   had to resolve `data/missions/<mission>/original-prompt.md` itself, read
   its instructions, then inspect `<worktree>/progress.txt` in the preserved
   worktree, and its own final message was asserted to equal exactly
   `SUPERVISOR-B-SKIPPED-DUPLICATE` (`assert.equal(bOutput, "SUPERVISOR-B-SKIPPED-DUPLICATE")`) -
   proof it read the marker's presence off disk and reasoned about the
   already-done state, rather than defaulting to redoing the work (its
   instructions gave it a distinct, equally short "do the work" branch it did
   not take).
5. **not duplicated**: `assert.equal(markerCount, 1)` on the real file content
   after B's turn - the marker appears exactly once, so B genuinely skipped
   redoing A's real work rather than appending it again. The mission-level
   `dispatchCount === 1` check (worker dispatched exactly once) also holds,
   unchanged from round 1.
6. **zero captain interventions**: `holdCreatedCount === 1` (the one hold
   Supervisor A itself opened before failover, not a new one),
   `assert.doesNotMatch(events, /"type":"task_blocked"/)`, and
   `assert.doesNotMatch(events, /"type":"captain_hold_resolved"/)` - the
   failover itself creates zero new captain holds, zero new blocks, and
   requires zero captain resolutions.

Also asserted, as in round 1: typed input kind is `launch-brief`
(`state/supervisor-b-launch-kind` = `launch-brief\n`), the raw delivered
input matches `FIRSTMATE_OP: v1 launch-brief`, the decoded body equals the
independently re-rendered resume context byte-for-byte, and
`RECOVERY.*SUPERVISOR_FAILOVER:claude` (updated from round 1's `:codex` label,
since Supervisor A is now honestly recorded as `claude`).

Additionally proving the crash itself was genuine, not merely a graceful
exit: `assert.doesNotMatch(aStdoutAfterKill, /SUPERVISOR-A-TURN-COMPLETE/)` -
Supervisor A's own completion phrase, which its instructions said to print
only after its bounded `sleep 20` tool call returned, never appeared,
confirming it was killed mid-turn rather than allowed to finish.

## Verification

```
FM_LIVE_SUPERVISOR_REAL_HARNESS_E2E=1 node --test tests/fm-supervisor-failover-real-harness-e2e.test.mjs
```

```
✔ real claude Supervisor A fails over to a real codex Supervisor B with zero captain intervention (37605.779325ms)
tests 1, pass 1, fail 0
```

Run exactly once, per the campaign's quota-discipline budget ("one real
Supervisor A turn plus one real Supervisor B turn"). The kill-mid-sleep
timing mechanism and both CLIs' non-interactive tool-use and auth were first
de-risked with three small, cheap real probe calls (append-only, then a
conditional skip check, then the kill-during-`sleep` timing race) before
writing the full fixtures, per the brief's own guidance to de-risk mechanics
before the real run; none of those probe scripts are part of this branch.

Default-skip behavior confirmed with no env set:

```
node --test tests/fm-supervisor-failover-real-harness-e2e.test.mjs
```

```
﹣ real claude Supervisor A fails over to a real codex Supervisor B with zero captain intervention # live: opt-in; set FM_LIVE_SUPERVISOR_REAL_HARNESS_E2E=1 (or FM_LIVE=1) to spend real provider quota running this
tests 1, pass 0, skipped 1
```

Existing fixture-only regression unchanged and still passing (no quota
spent, confirms nothing in the shared, real production code was touched):

```
node --test tests/fm-supervisor-rehydration-e2e.test.mjs tests/fm-supervisor-failover-e2e.test.mjs
```

```
✔ supervisor continuity survives supervisor and service process loss (4076.64983ms)
✔ Supervisor B rehydrates the mission after A is killed (7841.647242ms)
✔ Supervisor B rehydrates a second, independently-constructed disposable mission (7136.923487ms)
tests 3, pass 3, fail 0
```

`ps aux` confirmed no orphaned `claude`/`codex`/continuity processes remained
after the run. `bash -n` passed on `supervisor-b-real.sh`; `node --check`
passed on `supervisor-a-real.mjs` and the new test file. `git diff --check`
reported no whitespace errors. No host service was touched (continuity ran
only as a foreground, disposable-`FM_HOME` process inside the test, exactly
as round 1's regression test already does); no real project work or this
session's own artifacts were touched; nothing was pushed; no PR was opened.
`shellcheck` was not run, matching this campaign's standing directive.

The branch was rebased onto `main` tip `5130dde5` (which already carries
round 1's landed wiring) so it stays a clean fast-forward.

## Final answer

Can a completely new supervisor - now a real vendor CLI process, not a
fixture standing in for one - start after the previous one crashes,
understand the active mission, know the original request only by resolving a
pointer it was handed, know exactly what is landed versus merely done by
reading real state off disk, and continue autonomously without transcript
archaeology or any captain intervention?

YES, proven end to end with a real `claude` process as Supervisor A and a
real `codex` process as Supervisor B, against the same real, unmodified
`fm-supervisor-continuity.sh` / `fm-supervisor-launch.sh` / `fm-mission.sh` /
`fm-orchestrator-api.mjs` / `fm-supervisor-route.sh` pipeline round 1 already
proved wiring-real. Round 1's one remaining named gap - that every pass used
a fixture standing in for the vendor CLI - is now closed. Per the captain's
own framing, this closes the supervisor-failover campaign.
