# Worktree cleanup plan

## captain-workspace reconciliation — 2026-09-13

No worktree was deleted, pruned, reset, or returned during this reconciliation.

| Worktree | Classification | Basis |
| --- | --- | --- |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/1/captain-workspace` | `DO_NOT_TOUCH_UNKNOWN` | Unregistered slot with untracked `openclaw/` material. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/2/captain-workspace` | `DO_NOT_TOUCH_UNKNOWN` | Unregistered slot with untracked `.poc-acpx/openclaw/` material. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/3/captain-workspace` | `KEEP_FOR_RECOVERY` | `fm/supervisor-failover-hardening` is valuable committed work not yet landed. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/4/captain-workspace` | `DO_NOT_TOUCH_UNKNOWN` | Unregistered slot with large untracked `lab/` and OpenClaw material. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/5/captain-workspace` | `SAFE_TO_REMOVE_NOW` | Clean detached slot with no task record and a reachable known ref. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/6/captain-workspace` | `SAFE_TO_REMOVE_NOW` | Clean detached slot with no task record and a reachable known ref. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/7/captain-workspace` | `KEEP_FOR_RECOVERY` | Holds `reconcile/security-fixes` and the reconciliation task branch, not yet landed. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/8/captain-workspace` | `SAFE_TO_REMOVE_AFTER_MERGE` | The overnight decomposition scout is Done and torn down; slot content is reproduced in its report. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/9/captain-workspace` | `KEEP_FOR_RECOVERY` | Holds `fm/reconciliation-stale-base-bug`, not yet landed. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/10/captain-workspace` | `SAFE_TO_REMOVE_AFTER_MERGE` | The operational-state architecture scout is Done and torn down; slot content is reproduced in its report. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/11/captain-workspace` | `SAFE_TO_REMOVE_NOW` | Clean detached duplicate with no task record and content present in `origin/main`. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/12/captain-workspace` | `SAFE_TO_REMOVE_NOW` | Clean detached duplicate with no task record. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/13/captain-workspace` | `SAFE_TO_REMOVE_NOW` | Clean detached duplicate with no task record. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/14/captain-workspace` | `SAFE_TO_REMOVE_NOW` | Clean detached duplicate with no task record. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/15/captain-workspace` | `SAFE_TO_REMOVE_NOW` | Clean detached duplicate with no task record. |
| `/home/gabrielsgrancio/.treehouse/captain-workspace-7bab20/16/captain-workspace` | `SAFE_TO_REMOVE_NOW` | Clean detached duplicate with no task record. |

`SAFE_TO_REMOVE_NOW` means eligible for a separately approved pool cleanup after rechecking live ownership, not an instruction to delete immediately. Slots 7 and 9 hold the two ready-to-merge captain-workspace reconciliation branches (`reconcile/security-fixes`, `reconcile/supervisor-continuity` is reused from slot 3, and `fm/reconciliation-stale-base-bug`) and should stay `KEEP_FOR_RECOVERY` until the captain lands or explicitly archives them.

## Gabriel OS reconciliation — 2026-09-13

The primary `/home/gabrielsgrancio/projects/gabriel-os` checkout is local
`main` at `6f26a1dcb9fa8b45a1e3dccc518ab0c752b1272e` with seven modified tracked
files and seven untracked files. Preserve that dirty state; do not reset,
stash, clean, commit over it, or use it as the reconciliation worktree.

The evidence worktrees for `fm/ufd-gateway-repair`, `fm/ufd-mcp-probe-fix`, and
`fm/openclaw-tui-fm-integration-hardening` remain untouched. Their original
branches are stale-base evidence or a healthy unmerged line and must not be
rebased, rewritten, pruned, or deleted as part of cleanup.

The disposable task worktree created the following committed local branches,
all based on current committed `main` and never pushed:

- `reconcile/ufd-gateway` at `c38922c`
- `reconcile/mcp-probe-fix` at `94e368a`
- `reconcile/openclaw-integration` at `60da5e9`

The task branch `fm/reconciliation-branch-extraction-gabriel-os` is clean at
`c8aedaa` and contains the three reconciliation commits for delivery evidence.
No worktree or branch should be removed until the captain has reviewed and
landed or explicitly archived each reconciliation branch.
