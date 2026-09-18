Mode: Antigravity background-notify supervision.

When this session owns supervision and away mode is not active:
1. Drain first with `bin/fm-wake-drain.sh`.
   After handling all emitted wakes and reconciling open decisions and unread status lines, run the exact `--ack-through` command printed as `WAKE_ACK_REQUIRED`; until then the work remains durable for idempotent re-handling after interruption.
2. Source `__FM_X_MODE_ENV__` first when Relay is active.
3. First cycle: arm with Antigravity's background command execution:
   `run_command` with `WaitMsBeforeAsync: 2000` on:
   `[ -f __FM_X_MODE_ENV_SH__ ] && . __FM_X_MODE_ENV_SH__; exec bin/fm-watch-arm.sh`
4. Trust only the arm's one-line status.
5. `watcher: started ...` or `watcher: attached ...` means a live cycle exists.
   When the command runs in the background, stop calling tools to let execution pause.
6. When the background task completes, Antigravity automatically resumes execution via reactive wakeup (`<SYSTEM_MESSAGE>`).
7. On wake:
   a. Run `bin/fm-wake-drain.sh` first.
   b. Handle `signal`, `stale`, `check`, or `heartbeat` using the harness-neutral contract in `AGENTS.md`.
   c. Reconcile open decisions and unread status lines.
   d. Run the exact `--ack-through` command printed as `WAKE_ACK_REQUIRED`.
   e. Re-arm the next cycle with `bin/fm-watch-arm.sh` if the fleet still needs supervision.
8. Never use harness-native subagents (`invoke_subagent` / `define_subagent`) to delegate work.
   All delegation must be decomposed into FirstMate tasks, routed via Router V3 (`node bin/fm-router-v2.mjs dispatch`), and spawned with `bin/fm-spawn.sh`.
