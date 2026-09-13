import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [root, home, worker] = process.argv.slice(2);
const mission = path.join(root, "bin", "fm-mission.sh");
const taskId = "rehydration-task";
const state = path.join(home, "state");
const data = path.join(home, "data");
const project = path.join(home, "project");
const worktree = path.join(home, "task-worktree");
const { executeVerb } = await import(path.join(root, "bin", "fm-orchestrator-api.mjs"));

function run(args) {
  return execFileSync("bash", [mission, ...args], {
    cwd: root,
    env: { ...process.env, FM_HOME: home, FM_ROOT_OVERRIDE: root,
      FM_DATA_OVERRIDE: data, FM_STATE_OVERRIDE: state },
    encoding: "utf8",
  });
}

function append(eventId, type, payload) {
  run(["append", "rehydration-e2e", "--event-id", eventId, "--type", type,
    "--payload", JSON.stringify(payload)]);
}

mkdirSync(path.join(data, taskId), { recursive: true });
writeFileSync(path.join(data, taskId, "brief.md"), "# Synthetic worker\n");
run(["session-start", "rehydration-e2e", "--harness", "codex", "--session-id", "session-a"]);
const dispatch = await executeVerb("dispatch", {
  id: taskId, description: "Dispatch the synthetic rehydration worker",
  role: "general_engineer", dataClass: "PUBLIC", effort: "medium", scout: true,
}, {
  spawnRunner: (_args, { selectedRoute }) => {
    writeFileSync(path.join(state, `${taskId}.meta`), [
      `project=${project}`,
      `worktree=${worktree}`,
      "branch=fm/rehydration-task",
      "target_branch=main",
      "base_sha=fixture-base",
      "backend=tmux",
      `harness=${selectedRoute.harness}`,
      `model=${selectedRoute.resolved_runtime_model}`,
      "kind=scout",
      `window=fixture:${taskId}`,
    ].join("\n") + "\n");
    const workerProcess = spawn(worker, [state, taskId], { detached: true, stdio: "ignore" });
    workerProcess.unref();
    writeFileSync(path.join(state, "worker.pid"), String(workerProcess.pid));
    return { success: true, output: "synthetic Router V2 worker launch" };
  },
});
if (!dispatch.dispatched) throw new Error("canonical dispatch failed");
writeFileSync(path.join(state, "dispatch-result.json"), JSON.stringify(dispatch, null, 2) + "\n");
append("dispatch-task", "task_dispatched", {
  task_id: taskId, repo: project, worktree, branch: "fm/rehydration-task", harness: dispatch.harness,
});
append("worktree-task", "worktree_created", {
  task_id: taskId, repo: project, worktree, branch: "fm/rehydration-task",
});
append("progress-task", "phase_transition", {
  phase: "worker-progress", task_id: taskId, next_action: "Resolve the open synthetic-task hold",
});
append("complete-task", "task_completed", { task_id: taskId });
append("execution-done-task", "delivery_state_changed", {
  task_id: taskId, delivery_state: "EXECUTION_DONE", evidence: { status: "done" },
});
append("open-task-hold", "captain_hold_created", {
  task_id: taskId, hold_id: "rehydration-hold", backlog_pointer: "data/backlog.md#rehydration-task",
});
writeFileSync(path.join(state, "supervisor-a-ready"), "ready\n");
setInterval(() => {}, 1000);
