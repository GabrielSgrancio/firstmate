# Supervisor failover acceptance

Date: 2026-09-13.

Scope: independent primary-supervisor continuity and its separation from worker quota recovery.

The original sprint's supervisor-failover checklist is evaluated here with PASS, FAIL, or PARTIAL and no result is inferred from a source stub.

| Criterion | Result | Evidence |
| --- | --- | --- |
| An outer primitive survives supervisor death | PASS | The portable E2E starts the real foreground continuity entrypoint as a separate process, kills a real supervisor process, and observes a replacement without a supervisor turn. |
| The replacement receives durable intent | PASS | The E2E asserts the replacement record's mission id, original prompt pointer, exact task graph, and next action, and asserts the old session is ended while the new Codex session is running. |
| Worker failover remains distinct from supervisor failover | PARTIAL | Existing fm-control.sh relaunch tests preserve worker endpoint/worktree state and fm-procevent-quota.sh tests preserve quota exhaustion signals, but the quota-specific quota-failover-auto-resume implementation referenced by the brief is not present on this checkout's mainline and was not relabeled as verified here. |
| No duplicate supervisor sessions or worktree writers | PASS | The continuity transaction ends the old mission session before starting one replacement session, serializes the transition with a home lock, and the replacement is launched through one recorded process identity without a project worktree. |
| No direct Router bypass | PARTIAL | The continuity service requires an executable route-dispatch hook and never imports or calls a Router implementation itself, but this checkout has no canonical Router V2 route hook to verify end to end, so the production route-selection claim remains unproven. |
| The FirstMate watcher is external and persistent | PASS | The E2E uses the real bin/fm-watch.sh, proves its pid differs from the continuity service, proves it survives supervisor death, kills it abruptly, observes automatic replacement, kills the continuity process, and proves the watcher survives service death. |
| A dead watcher is detected without an LLM turn | PASS | The continuity process detects the killed watcher from process and beacon state and starts a new watcher while no harness turn is running. |
| The continuity service itself is independently supervised | PARTIAL | The generated unit uses Restart=always, RestartSec=2, and KillMode=process, but the development host reports systemctl --user is-system-running as degraded and has no installed FirstMate user unit, so live systemd restart evidence is unavailable. |
| Hard Rule 6 is respected | PARTIAL | The service records state and launches a routed supervisor command but does not execute mission work; the requested checkpointed Hard Rule 6 text is absent from this checkout's AGENTS.md, so no conflict can be checked against that exact wording. |

## Commands and evidence

node --test tests/fm-supervisor-failover-e2e.test.mjs returned 1 passing test and 0 failures.

shellcheck bin/fm-mission.sh bin/fm-supervisor-continuity.sh returned no diagnostics after the lifecycle fixes.

bash tests/fm-control-relaunch.test.sh reached seven passing relaunch-preservation cases before the long-running suite exceeded the command read window, so it is not counted as a complete suite pass here.

bash tests/fm-procevent-quota.test.sh returned # all fm-procevent-quota tests passed.

systemctl --user --version returned systemd 255, while systemctl --user is-system-running returned degraded.

herdr --version returned herdr 0.8.0.

herdr --help exposes terminal/session and foreground-server operations, not an arbitrary supervisor restart policy.

## Remaining work

The quota-specific worker capability needs to be landed or made available on the same mainline before the literal worker-quota acceptance criterion can become PASS.

A production route hook must bind the service to the repository's authoritative Router V2 dispatch path and receive its own live verification before the direct-router criterion can become PASS.

A host with a functioning systemd user manager must install the generated unit and record a real service-crash restart result before the systemd criterion can become PASS.

The continuity service honors the control-plane boundary: it records and routes supervisor sessions, while the replacement harness remains responsible for executing the mission.
