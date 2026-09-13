# Supervisor continuity canonical routing

Date: 2026-09-13.

Branch: `fm/supervisor-continuity-canonical-routing`.

Implementation commit: `ace9a97f4e91dba2176d429c932e77f4e8e62e02`.

The continuity service now defaults its route seam to `bin/fm-supervisor-route.sh` while retaining `FM_SUPERVISOR_ROUTE_COMMAND` as the installation-time override.

The canonical hook calls `bin/fm-router-v2.mjs`, excludes every RouteTarget belonging to the dead harness, honors Router V2 quota and lifecycle eligibility, and returns a concrete harness plus an executable command mapping.

The existing continuity E2E now copies the tracked synthetic Router V2 fixture, runs the actual continuity service and canonical hook, kills a real synthetic codex supervisor, observes a claude replacement with the same mission id, verifies no duplicate mission session, and verifies independent watcher survival and restart.

The deterministic E2E passed three consecutive times in the task worktree with `FM_SUPERVISOR_USE_LIVE_QUOTA=0`, so no provider quota was used.

The user-level manager is systemd 255.4-1ubuntu8.17, `systemctl --user show-environment` succeeds, and `systemctl --user is-system-running` reports `degraded`.

The degraded state is caused by the unrelated failed units `gabriel-os-calendar-sync.service`, `gabriel-os-capacity-sync.service`, and `gabriel-os-remote-status.service`.

The generated `/home/gabrielsgrancio/.config/systemd/user/firstmate-supervisor-continuity.service` is enabled and active with `Restart=always`, and its `ExecMainPID` was `1568616` at installation verification.

The independent verification clone was `/tmp/fm-supervisor-continuity-clone.ejlnG6/repo` at the exact implementation tip and passed `node --test tests/fm-supervisor-failover-e2e.test.mjs`, shellcheck for both continuity scripts, and `git diff --check`.

The independent clone's `git ls-files --error-unmatch` confirmed `bin/fm-supervisor-route.sh`, `tests/fm-supervisor-failover-e2e.test.mjs`, `tests/fixtures/router-v2/config/model-registry.json`, and `tests/fixtures/router-v2/data/provider-catalogs/compiled-route-targets.json`.

`bin/fm-doc-audience-check.sh` remains blocked by pre-existing unclassified campaign documents, including `docs/ROUTER_V2_EXACT_RECOVERY.md` and `docs/SUPERVISOR_REHYDRATION_CONTRACT.md`; this patch added no new maintained prose surface.

`bin/fm-lint.sh` completed its ShellCheck and workflow validation phases without a reported defect.

No remote was pushed, no PR was opened, and no merge was performed.
