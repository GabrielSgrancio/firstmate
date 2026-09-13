# Supervisor rehydration E2E report

## Delivered

`bin/fm-mission.sh active` now discovers active missions from materialized
event logs.
`bin/fm-mission.sh resume-context <mission-id>` materializes one mission,
reconciles task state through `bin/fm-crew-state.sh`, inspects Git worktrees
and branches, and renders the compact Supervisor Resume Context.
The continuity replacement boundary no longer passes mission identity or a
capsule through environment variables.

## Acceptance proof

`tests/fm-supervisor-rehydration-e2e.test.mjs` starts real Supervisor A and B
fixture processes.
Supervisor A discovers the mission, dispatches a synthetic task through the
Orchestrator API and Router V2, and starts a tracked synthetic worker.
The worker writes observable progress and Supervisor A appends task,
progress, execution-delivery, and captain-hold events to the mission log.
Supervisor A is killed with `SIGKILL`.
The real foreground continuity service routes to the alternate Claude route
and starts Supervisor B.
Supervisor B discovers the mission with `active`, runs `resume-context`, and
records the rendered context without reading mission-specific handoff
environment variables.
The assertions cover mission identity, original prompt pointer/hash/source
classification, task graph and progress, delivery history, worktree/branch,
open decision reference, prior-session end reason, next action, and durable
event accumulation.

All Supervisor A/B and worker processes are synthetic fixtures.
They prove the process-boundary mechanism without spending real model quota.
A production harness replacement command still needs to invoke `active` and
`resume-context` before its normal supervisor turn.

## Verification

The focused E2E was run three times in an independent fresh clone of the final
committed branch tip.
`git ls-files --error-unmatch` confirmed
`supervisor-a.mjs`, `supervisor-b.sh`, and `synthetic-worker.sh` were tracked.
The exact command was `node --test tests/fm-supervisor-rehydration-e2e.test.mjs`.
Run 1 passed in 5.88 seconds.
Run 2 passed in 5.23 seconds.
Run 3 passed in 5.29 seconds.
Fresh-clone pass rate: 3/3.

## Final answer

Can a completely new supervisor start now, understand the active mission, know the original request, know exactly what is landed vs merely done, and continue autonomously without transcript archaeology?

NO - the production replacement command for each real harness is not yet wired to invoke the new bootstrap automatically; the synthetic B fixture proves the required call and data boundary.
