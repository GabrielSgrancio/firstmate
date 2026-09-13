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
Supervisor B discovers the mission with `active` and invokes `resume-context`
without consuming mission identity or capsule environment variables.
The test asserts the rendered context and the accumulated event log across
the process boundary.

The fixture workers are synthetic processes and consume no provider quota.
The test proves the continuity and rehydration mechanism, not that a vendor
CLI has independently wired its own startup prompt to invoke the bootstrap.
A production harness replacement command must call `active` and
`resume-context` before beginning its normal supervisor turn.

Run the focused proof with:

```sh
node --test tests/fm-supervisor-rehydration-e2e.test.mjs
```

Run the continuity regression alongside it with:

```sh
node --test tests/fm-supervisor-rehydration-e2e.test.mjs tests/fm-supervisor-failover-e2e.test.mjs
```
