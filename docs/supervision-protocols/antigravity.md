Mode: Antigravity background-notify supervision.

When this session owns supervision and away mode is not active:
1. Drain first with `bin/fm-wake-drain.sh`.
   After handling all emitted wakes and reconciling open decisions and unread status lines, run the exact `--ack-through` command printed as `WAKE_ACK_REQUIRED`; until then the work remains durable for idempotent re-handling after interruption.
2. Source `__FM_X_MODE_ENV__` first when Relay is active.
3. First cycle: use agy's `run_command` tool to run the following command as a tracked background task by setting `WaitMsBeforeAsync` to a short bounded delay such as 500 milliseconds:

   `[ -f __FM_X_MODE_ENV_SH__ ] && . __FM_X_MODE_ENV_SH__; exec bin/fm-watch-arm.sh`

4. Trust only the arm's one-line status.
5. `watcher: started ...` or `watcher: attached ...` means a live cycle exists.
   On attach, the background task follows verified identity-matched successors instead of exiting when the first cycle ends.
6. Failure or missing cycle only: `watcher: FAILED ...` means supervision is down; fix and re-arm.
7. After a successful start or attach status, end the turn.
   The background task remains the live wait until it returns an actionable wake or failure.
8. Waiting is silent.
9. Never use shell `&` for firstmate supervision.
10. Never bundle the arm onto another command.

agy injects a high-priority system message carrying the background task's id, exit code, and output when the task completes, then resumes the same model session automatically.
When that completion notification arrives:
1. Run `bin/fm-wake-drain.sh` first.
2. Handle `signal`, `stale`, `check`, or `heartbeat` using the harness-neutral contract in `AGENTS.md`.
3. Ordinary wake: re-arm exactly one tracked background `bin/fm-watch-arm.sh` task with the same `run_command` shape if work remains in flight or Relay still needs polling.
4. Do not invent a wake from an attach-status line alone.
   Drain the queue and act only on real wake records, the drain's `OPEN DECISIONS` and `UNREAD STATUS` entries, or a real watcher reason line.
   Re-arm attaches to an existing healthy cycle when one is already present and follows its verified successor chain.
   See [`watcher-continuity.md`](../watcher-continuity.md) for the arm-layer successor and clean-close failure contract.

The tracked workspace-local Stop hook in `.agents/hooks.json` runs `bin/fm-agy-turnend-guard.sh` as a backstop, not the normal wake path.
It maps agy's `executionNum` to the shared one-follow-up guard and never drains or acknowledges the wake queue itself.
After any forced continuation, repair or arm the watcher with the background protocol above.

The project must be trusted or agy does not load `.agents/hooks.json`.
Interactive TUI primary sessions are the supported supervision host.
