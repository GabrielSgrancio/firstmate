# Supervisor rehydration bootstrap wiring

## Delivered

`bin/fm-supervisor-launch.sh` is a new adapter that `bin/fm-supervisor-continuity.sh`
now starts in place of the raw configured per-harness replacement command
(`bin/fm-supervisor-continuity.sh:194`, `SUPERVISOR_LAUNCH="$SCRIPT_DIR/fm-supervisor-launch.sh"`).

The adapter itself discovers active missions through `bin/fm-mission.sh active`,
renders each one's context through `bin/fm-mission.sh resume-context`, and
delivers the rendered result as the existing typed `launch-brief` operational
input (`bin/fm-operational-input.sh encode launch-brief`) as the sole argument
to the configured harness executable, before that harness's first turn. This
is the same launch-brief carrier `bin/fm-spawn.sh` already uses for ordinary
crewmate dispatch, reused rather than inventing a second delivery mechanism.

Continuity no longer passes mission identity or capsule data through
environment variables to the replacement process; the replacement process (or,
for `claude`/`codex`, the harness invocation it wraps) receives only what the
launch-brief carrier delivers, and discovers the rest itself by calling
`active`/`resume-context`, matching the boundary the prior round's synthetic
fixture proved.

## Scope

This is wiring, not new design. The mission bootstrap (`fm-mission.sh active`
/ `resume-context`), the continuity replacement-launch path, and the
per-harness command variables (`FM_SUPERVISOR_COMMAND_CODEX` /
`FM_SUPERVISOR_COMMAND_CLAUDE` / `FM_SUPERVISOR_COMMAND_ANTIGRAVITY` /
`FM_SUPERVISOR_COMMAND_OPENCODE`, `FM_SUPERVISOR_REPLACEMENT_COMMAND`) were
`VERIFIED_LANDED` already and are unchanged; only the call boundary between
them was closed. Mission event store internals and harness-specific CLI
features beyond delivering the rendered context at launch were not touched.

## Acceptance proof (round 1 of 2, per campaign stop condition)

`tests/fm-supervisor-rehydration-e2e.test.mjs` was extended (not redesigned)
and now runs two scenarios through the identical real pipeline
(`runFailoverScenario`, shared by both `test()` calls):

1. `rehydration-e2e` / `rehydration-task` (the original scenario, prompt and
   task graph unchanged from the prior round).
2. `rehydration-e2e-second-pass` / `second-pass-task`, an independently
   constructed mission id, task id, prompt, worktree, branch, next action, and
   captain hold id, run through the identical continuity/launch pipeline, to
   prove the wiring is not overfit to one hardcoded fixture value.

Both scenarios start the real foreground `fm-supervisor-continuity.sh`
service, a real Supervisor A fixture process that dispatches a real synthetic
task through `fm-orchestrator-api.mjs`/Router V2, kill Supervisor A with
`SIGKILL`, and let continuity route to and launch the real
`fm-supervisor-launch.sh` adapter, which in turn launches the Supervisor B
fixture with the delivered launch brief.

Per the firstmate steer received during this round, acceptance evidence
against each named criterion, captured by assertions in both scenarios (both
pass in an independent fresh clone; see Verification):

- **mission_id match**: `assert.equal(record.mission_id, missionId)` — the
  continuity replacement record, read from the real
  `state/supervisor-continuity-replacement.json` written by the real
  service, carries the exact mission id Supervisor A was working, for both
  `rehydration-e2e` and `rehydration-e2e-second-pass`.
- **task-graph match**: `assert.match(context, /TASK GRAPH.*<taskId>/)` — the
  resume context rendered by the real `fm-mission.sh resume-context` inside
  the launch adapter includes the exact task id from the original task graph
  file for both scenarios.
- **worktree match**: `assert.match(context, /worktree=<worktree path>/)` and
  `/branch=fm\/<taskId>/` — the exact worktree path and branch Supervisor A's
  dispatch recorded are present in the delivered context, for both scenarios.
- **progress match**: `assert.match(context, /worker-progress/)`,
  `/delivery_state=EXECUTION_DONE/`, `/delivery_history=EXECUTION_DONE/` — the
  phase transition and delivery-state events Supervisor A appended are
  reconciled into the delivered context, for both scenarios.
- **duplication check**: `dispatchCount = events.match(/"type":"task_dispatched"/g).length; assert.equal(dispatchCount, 1)`
  — the worker is dispatched exactly once across the failover; continuity
  never re-dispatches the task, for both scenarios.
- **captain-intervention count**: `holdCreatedCount = events.match(/"type":"captain_hold_created"/g).length; assert.equal(holdCreatedCount, 1)`
  (the one hold Supervisor A itself opened before failover, not a new one),
  plus `assert.doesNotMatch(events, /"type":"task_blocked"/)` and
  `assert.doesNotMatch(events, /"type":"captain_hold_resolved"/)` — the
  failover itself creates zero new captain holds, zero new blocks, and
  requires zero captain resolutions; the pre-existing open hold is carried
  forward untouched (also visible in the delivered context as
  `DECISIONS...<holdId>`), for both scenarios.

Also asserted, as in the prior round: the typed input kind is `launch-brief`
(`state/supervisor-b-launch-kind` = `launch-brief\n`), the raw delivered input
matches the `FIRSTMATE_OP: v1 launch-brief` header, and the decoded body
equals the rendered resume context byte-for-byte (`launchInput.trimEnd() ===
context.trimEnd()`).

## What "real (but low-stakes/disposable)" means here, and what it does not

The steer asked for a second validation pass against "one small real (but
low-stakes/disposable) mission" after the synthetic pass fully passes, with
the constraint that host services are never touched and no `shellcheck` is
run this round. All scripts involved (`bin/fm-supervisor-continuity.sh`,
`bin/fm-supervisor-launch.sh`, `bin/fm-mission.sh`, `bin/fm-orchestrator-api.mjs`,
`bin/fm-operational-input.sh`) are the real, unmocked, production scripts;
the only fixture substitutions are the harness endpoints themselves
(Supervisor A/B and the synthetic worker), which stand in for a real vendor
CLI (`claude`, `codex`, etc.).

I judged that substituting a real vendor CLI for those endpoints in this round
would be a live provider-quota spend and, for at least the continuity systemd
service portion, would touch a real host service — both things this round's
steer explicitly says to avoid, and which the design in
`docs/SUPERVISOR_CONTINUITY_DESIGN.md`/`SUPERVISOR_REHYDRATION_E2E.md`
deliberately keeps out of the portable proof (documented before this round:
"fixture workers ... consume no provider quota"). Rather than guess at
which of the two competing constraints (real vendor CLI vs. no quota/host
service) should win, I satisfied the request's substance — an
independently-constructed low-stakes disposable mission run end-to-end
through the real, non-test-only pipeline — as scenario 2 above, and am
flagging this interpretation explicitly rather than silently picking one
reading. If a literal real-vendor-CLI pass is still wanted, that is the one
concrete remaining ask for round 2 of this campaign's two-round remediation
limit, and it would need explicit authorization to spend provider quota and
credentials this round intentionally withheld.

## Verification

Both scenarios in `tests/fm-supervisor-rehydration-e2e.test.mjs`, plus the
continuity regression `tests/fm-supervisor-failover-e2e.test.mjs`, pass:

```
node --test tests/fm-supervisor-rehydration-e2e.test.mjs tests/fm-supervisor-failover-e2e.test.mjs
```

```
✔ supervisor continuity survives supervisor and service process loss (~3.1-3.6s)
✔ Supervisor B rehydrates the mission after A is killed (~6.2-6.6s)
✔ Supervisor B rehydrates a second, independently-constructed disposable mission (~6.4-6.5s)
tests 3, pass 3, fail 0
```

Run twice (once pre-rebase onto the current `main` tip
`39a4ccf2 feat(routing): gate harness discovery on executable integrity`, once
post-rebase) with identical pass results.

Independent fresh `git clone` of this branch tip confirmed:
- `git ls-files --error-unmatch bin/fm-supervisor-launch.sh
  tests/fixtures/supervisor-rehydration/supervisor-a.mjs
  tests/fixtures/supervisor-rehydration/supervisor-b.sh
  tests/fixtures/supervisor-rehydration/synthetic-worker.sh
  tests/fm-supervisor-rehydration-e2e.test.mjs` exited 0 — every file this
  wiring depends on is tracked.
- `bin/fm-supervisor-launch.sh`'s executable bit survived the clone
  (`-rwxr-xr-x`).
- `node --test tests/fm-supervisor-rehydration-e2e.test.mjs
  tests/fm-supervisor-failover-e2e.test.mjs` passed all 3 tests from the
  clone.

`bash -n` passed on `bin/fm-supervisor-launch.sh`,
`bin/fm-supervisor-continuity.sh`, and
`tests/fixtures/supervisor-rehydration/supervisor-b.sh`. `node --check`
passed on the modified `.mjs` files. `git diff --check` reported no
whitespace errors. `shellcheck` was intentionally not run this round per the
steer.

The branch was rebased onto `main` tip `39a4ccf2` so it stays a clean
fast-forward; all tests were re-run and re-passed after the rebase.

## Final answer

Can a completely new supervisor start now, understand the active mission,
know the original request, know exactly what is landed vs merely done, and
continue autonomously without transcript archaeology?

YES for the mechanism proven end-to-end against real, unmocked
`fm-supervisor-continuity.sh` / `fm-supervisor-launch.sh` / `fm-mission.sh` /
`fm-orchestrator-api.mjs` scripts, generalized across two independently
constructed disposable missions, with explicit evidence that continuity is
real (mission id, task graph, worktree, branch, and progress all carried
forward unchanged; the worker is never re-dispatched; zero new captain holds
or blocks are created by the failover itself).

The one remaining gap, not yet closed by design and not attempted this round
without explicit authorization to spend it: no pass in this campaign has yet
substituted a live, unmocked vendor CLI (a real `claude` or `codex` binary)
for the harness endpoint — every pass, this round included, uses a fixture
standing in for that binary, specifically to avoid spending real provider
quota and to avoid touching real host services, both constraints this round's
own steer reiterated. If that gap is judged material, it is the one bounded
item available for this campaign's second and final remediation round; if it
is judged acceptable (the wiring, the call boundary, and the data-delivery
mechanism are all real and proven — only the terminal CLI binary is a
stand-in), this campaign can close as done at this round.
