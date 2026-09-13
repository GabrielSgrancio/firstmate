# Stale Base Root Cause

## Confirmed behavior before this change

Treehouse is a pool of reusable, pre-warmed git worktrees rather than a target-branch freshness service.

The installed Treehouse CLI identifies a pooled entry by its path, status, lease identity, and observed processes, but does not expose a base commit in `treehouse status --json`.

`treehouse get` acquires an available pooled worktree and opens a subshell in it.

`treehouse enter` explicitly does not acquire, reset, or return the selected worktree.

Therefore a pool slot can retain the commit from its previous checkout until another layer refreshes it.

FirstMate's fresh ship and scout path had a partial freshness guard in `freshen_spawn_worktree_base` in `bin/fm-spawn.sh`.

When the pooled worktree has an effective `origin` configuration, that guard fetches the remote, resolves its default branch, resets the clean worktree to `origin/<default>`, and verifies the resulting `HEAD`.

When the worktree has no effective `origin` configuration, the guard returns successfully without a target-head comparison.

Before this change, relaunches intentionally reused the recorded worktree and skipped that fresh-spawn refresh path.

Those pre-change paths could therefore start from a clean but stale checkout without a warning naming the stale base.

Before this change, the `state/<id>.meta` writer in `bin/fm-spawn.sh` recorded the worktree and project but did not record the exact commit from which the task branch was created or the intended target branch.

Consequently, the pre-change delivery path could not distinguish a branch created from the current target from one created from an older pooled checkout.

`bin/fm-merge-local.sh` verifies that the default branch is an ancestor of the task branch and that the project checkout is clean, but it does not compute the task base, target head, merge base, or a diff anomaly against the current target.

`bin/fm-teardown.sh` verifies dirty and unlanded work before returning a worktree, but its local-only unmerged-work check was outside the new delivery guard's scope and retains the historical missing-base-provenance gap.

The synthetic stale-slot observation is the dangerous shape from the incident: a target branch advances substantially after a pool slot is prepared, the task branch retains the old base, and a diff against current target presents target-only files as large deletions even though the task's own patch added very little.

On 2026-09-13, a temporary repository was committed at `77c8552d105cbac21341f76ae4f0ee52f9d95fa6`, acquired with `treehouse get --lease`, advanced to `202d00ae638ee7a39440eec2e686ba6fcc031282`, and the leased slot still reported `HEAD=77c8552d105cbac21341f76ae4f0ee52f9d95fa6`.

The command used was `HOME=<temporary-home> TREEHOUSE_NO_UPDATE_CHECK=1 treehouse get --lease` from the repository, followed by an independent commit on the repository's `main` branch and `git -C <leased-slot> rev-parse HEAD`.

The slot was returned with `treehouse return --force <exact-temporary-slot>` after the observation.

## Root cause

The root cause is a control-plane provenance gap at the boundary between Treehouse's reusable checkout allocation and FirstMate's delivery authorization.

Treehouse does not promise that an acquired reusable slot is based on the current target, and FirstMate did not persist the actual spawn base or enforce a delivery-time comparison against the current target.

The existing origin-backed refresh reduced the exposure for ordinary fresh spawns, but it was not an auditable invariant because origin-less slots and relaunches had no recorded base and no delivery guard.

This is why a stale branch could look ready from the worker status alone while manual comparison against real current `main` revealed a disproportionate deletion diff.

## Bounded guard

New task metadata records `base_sha` and `target_branch` at spawn time, after the worktree has been selected and refreshed and before the worker can create its branch.

The local delivery check reads the recorded base, the current target head, and the merge base, counts target drift, and compares deletions against current target with the task branch's own additions since `base_sha`.

A disproportionate deletion result is recorded as `NEEDS_BASE_RECONCILIATION` and refuses local landing until the worker reconciles its branch with the current target.

The guard is additive and fail-closed for newly recorded provenance while preserving the existing dirty, diverged, captain-hold, and landed-work checks.
