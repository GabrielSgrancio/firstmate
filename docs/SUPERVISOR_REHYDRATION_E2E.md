# Supervisor rehydration E2E

Audience: maintainer-verification.

`bin/fm-mission.sh active` discovers active missions by materializing each
mission event log and returning active mission ids.
`bin/fm-mission.sh resume-context <mission-id>` renders the compact
Supervisor Resume Context.
The command includes the original prompt pointer and hash, task graph and
progress, delivery-state history, live task-state output, Git worktree and
branch facts, open captain-hold references, prior session end reason, and the
next action.

The acceptance test is `tests/fm-supervisor-rehydration-e2e.test.mjs`.
It starts a real Supervisor A process, dispatches a real synthetic task
through `fm-orchestrator-api.mjs` and Router V2, and launches a tracked worker
fixture through the public spawn hook.
It kills Supervisor A with `SIGKILL` and lets the real foreground continuity
service route and launch Supervisor B under the alternate Claude route.
The replacement launch adapter discovers the mission with `active`, invokes
`resume-context`, and delivers the rendered context as a typed `launch-brief`
input without consuming mission identity or capsule environment variables.
The fixture supervisor then records the received input and performs its own
active-mission lookup before starting its turn.
The test asserts the delivered context and the accumulated event log across
the process boundary.

The fixture workers are synthetic processes and consume no provider quota.
The test proves that the production replacement path invokes the bootstrap and
delivers its output before the routed harness command begins its turn.
Its assertions cover mission-identity match, task-graph match, worktree and
branch match, progress and delivery-history match, a duplication check (the
worker is dispatched exactly once across the failover), and a
captain-intervention count (the failover creates zero new captain holds or
task blocks).

A second scenario in the same file, `runFailoverScenario` run against an
independently-constructed mission id, task id, prompt, worktree, and hold,
proves the wiring generalizes rather than being overfit to one hardcoded
fixture value. It still uses the fixture harness in place of a real vendor CLI,
by design, so the proof stays credential-free and spends no provider quota.

Run the focused proof with:

```sh
node --test tests/fm-supervisor-rehydration-e2e.test.mjs
```

Run the continuity regression alongside it with:

```sh
node --test tests/fm-supervisor-rehydration-e2e.test.mjs tests/fm-supervisor-failover-e2e.test.mjs
```
