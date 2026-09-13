# Mission event store implementation report

The canonical mission source is `data/missions/<mission-id>/events.jsonl`.
`bin/fm-mission.sh` writes schema-versioned, sequenced, idempotent JSON events under a per-mission lock.
The writer reuses the `tempfile.mkstemp` plus `os.replace` atomic-write primitive in `bin/fm-mission.sh` for logs, prompts, cursors, and derived views.
`mission.json` schema version 3 is a deterministic materialized view rebuilt from the event log.
The materializer follows the incremental byte-cursor and file-identity pattern documented and implemented by `status_open_decisions_incremental` in `bin/fm-classify-lib.sh`.
Malformed or unterminated final log lines are reported and discarded without losing prior valid events.
The supported checkpoint vocabulary covers mission, session, task, captain-hold, worktree, commit, delivery-state, phase, and supervisor handoff or termination events.
`delivery_state_changed` is the single delivery-state event type and accepts only `EXECUTION_DONE`, `DELIVERY_READY`, `LANDED`, or `VERIFIED_LANDED`.
Delivery events reference `state/<task-id>.meta` by `task_id` and do not copy `base_sha` or `target_branch`.
Captain-hold materialization stores only a backlog pointer and status, leaving hold content owned by `tasks-axi` and `data/backlog.md`.
The legacy `capsule.json` and `state/mission-capsule.json` paths are derived compatibility views rather than additional sources of truth.

## Validation

`tests/fm-mission-event-store.test.sh` verifies prompt provenance, ordered event records, idempotent replay, task-meta delivery-state pointers, torn-tail recovery, and concurrent writer serialization.
`node --test tests/fm-supervisor-failover-e2e.test.mjs` verifies the existing supervisor continuity integration still consumes the derived capsule.
`shellcheck -x bin/fm-mission.sh tests/fm-mission-event-store.test.sh`, `bash -n bin/fm-mission.sh tests/fm-mission-event-store.test.sh`, and `git diff --check` pass.

Independent verification used `git clone --no-hardlinks --branch fm/mission-event-store "$PWD" /tmp/fm-event-store-clone.oXOYlk/clone`.
`git ls-files --error-unmatch` confirmed all five implementation, test, report, and contract paths were tracked in the checked branch tip.
The fresh clone passed `tests/fm-mission-event-store.test.sh` with four `ok` results.
The first fresh-clone continuity E2E attempt had a transient watcher-liveness assertion, and its immediate rerun passed with one test and zero failures.
The checked branch tip was obtained with `git rev-parse HEAD` in both the worker and independent clone and matched exactly.
`bin/fm-doc-audience-check.sh` still returns 1 because the repository's existing documentation inventory leaves this ADR, the rehydration contract, and task evidence reports unclassified; no unrelated inventory changes were made for this local-only task.
