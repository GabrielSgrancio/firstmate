# Supervisor continuity design

Audience: maintainer-architecture.

Status: proposed and implemented by the supervisor-continuity service entrypoint.

## Decision

The supervisor-continuity primitive is a `systemd --user` service running `bin/fm-supervisor-continuity.sh` in the foreground.

The service is the outer lifecycle owner, while the script owns only bounded detection, durable mission transition, and one replacement launch transaction.

The replacement is launched through `bin/fm-supervisor-launch.sh` with the configured Firstmate replacement command and is recorded with the same mission identifier before the command is started.

The launch adapter receives only the FirstMate home and a session identifier from continuity, but not mission identity or capsule environment variables.
It discovers active missions through `bin/fm-mission.sh active`, loads each context through `bin/fm-mission.sh resume-context`, and delivers the result as the existing typed `launch-brief` operational input before the harness's first turn.

The service unit uses `Restart=always`, so a continuity process crash is repaired by systemd without a supervisor turn.

On hosts without a usable `systemd --user` manager, installation is refused rather than silently degrading to a child process or an unowned shell loop.

The test suite runs the same foreground service entrypoint directly because a test must not mutate the operator's user service manager.

## Evidence for the primitive choice

`bin/fm-watch.sh` is a one-shot polling watcher whose lifecycle is re-armed by harness-specific turn-end integrations.

`bin/fm-watch-arm.sh` explicitly keeps the watcher as a tracked child of the harness-owned arm and waits for that child, so it cannot be the outer owner of a supervisor that may disappear.

`docs/watcher-continuity.md` assigns continuous re-arm to Pi, omp, OpenCode, Cursor, and Claude harness integrations, with Codex retaining a foreground checkpoint protocol.

`bin/fm-procevent.sh` is a generic runner for a registered blocking source, and its own header says that `reconcile` is called by the watcher to restart an unowned source.

The process-event runner therefore provides durable capture and source-claim recovery, but it does not provide a primary-supervisor launch policy or a lifecycle owner outside the watcher.

`bin/fm-supervise-daemon.sh` is an away-mode supervisor that injects classified wakes into a tmux or Herdr pane and is started as part of the away posture.

It is not a general primary-session watchdog, and its documented backend scope excludes the harness-independent service boundary required here.

Herdr 0.8.0 is installed on the development host, but `herdr --help` exposes persistent terminal/session management and `herdr server` exposes a foreground server, not a service restart policy for an arbitrary supervisor process.

Herdr's backend guide says that a stopped server preserves workspace identifiers but not harness processes or live agent registrations, which is recovery evidence rather than an outer lifecycle guarantee.

The development host has `/usr/bin/systemctl` and systemd 255, while `systemctl --user is-system-running` currently reports `degraded` and no FirstMate user unit is installed.

That host state proves the systemd capability is present but does not prove an installed service is currently active.

## Boundaries

The service never treats a rendered pane, a harness label, or a stale status line as proof of a live supervisor.

The supervisor lease records the supervisor process identity, harness label, mission identifier, and heartbeat timestamp in the private state directory.

Only a missing or identity-mismatched lease owner triggers replacement, and a replacement transaction is serialized by a state lock.

The mission capsule remains the source of intent, prompt pointer, task graph, session history, and next action.

Worker quota failover remains owned by the worker relaunch path and is not folded into supervisor continuity.

The service does not select a harness by calling a provider or Router implementation directly.

It invokes the route-dispatch hook supplied at installation, defaulting to `bin/fm-supervisor-route.sh`, which consults Router V2, excludes every RouteTarget on the dead harness, and produces a concrete replacement harness and configured executable command.

The canonical hook takes its role and data class from `FM_SUPERVISOR_ROUTE_ROLE` and `FM_SUPERVISOR_ROUTE_DATA_CLASS`, and takes the selected harness command from its `FM_SUPERVISOR_COMMAND_<HARNESS>` mapping or the generic replacement-command fallback.

No replacement is started when the route hook, mission capsule, lease identity, or state lock cannot be validated.

## Verification boundary

The portable E2E test starts the actual foreground continuity entrypoint, starts a real fixture supervisor process, kills that process, and observes the durable replacement record and replacement process from a separate test process.

The fixture replacement command receives and decodes the typed launch brief, then performs its own active-mission lookup for lease recording, so the test proves state crossing the process boundary without spending provider quota.

A live `systemd --user` installation check remains environment-dependent and is recorded separately from the portable process-level proof.
