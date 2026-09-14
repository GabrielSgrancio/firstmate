import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [root, home, worker, missionIdArg, taskIdArg, nextActionArg, holdIdArg, promptFileArg] =
  process.argv.slice(2);
const mission = path.join(root, "bin", "fm-mission.sh");
const continuity = path.join(root, "bin", "fm-supervisor-continuity.sh");
const missionId = missionIdArg || "rehydration-real-e2e";
const taskId = taskIdArg || "rehydration-real-task";
const nextAction = nextActionArg || "Resolve the open synthetic-task hold";
const holdId = holdIdArg || "rehydration-real-hold";
const state = path.join(home, "state");
const data = path.join(home, "data");
const project = path.join(home, "project");
const worktree = path.join(home, "task-worktree");
const startupError = path.join(state, "supervisor-a-error");
process.on("uncaughtException", (error) => {
  writeFileSync(startupError, String(error.stack || error));
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  writeFileSync(startupError, String(error?.stack || error));
  process.exit(1);
});
const { executeVerb } = await import(path.join(root, "bin", "fm-orchestrator-api.mjs"));
const env = {
  ...process.env, FM_HOME: home, FM_ROOT_OVERRIDE: root,
  FM_DATA_OVERRIDE: data, FM_STATE_OVERRIDE: state,
};

function run(args) {
  return execFileSync("bash", [mission, ...args], { cwd: root, env, encoding: "utf8" });
}

function append(eventId, type, payload) {
  run(["append", missionId, "--event-id", eventId, "--type", type,
    "--payload", JSON.stringify(payload)]);
}

mkdirSync(path.join(data, taskId), { recursive: true });
writeFileSync(path.join(data, taskId, "brief.md"), "# Synthetic worker\n");
run(["session-start", missionId, "--harness", "claude", "--session-id", "session-a"]);
const dispatch = await executeVerb("dispatch", {
  id: taskId, description: "Dispatch the synthetic rehydration worker",
  role: "general_engineer", dataClass: "PUBLIC", effort: "medium", scout: true,
}, {
  spawnRunner: (_args, { selectedRoute }) => {
    writeFileSync(path.join(state, `${taskId}.meta`), [
      `project=${project}`,
      `worktree=${worktree}`,
      `branch=fm/${taskId}`,
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
  task_id: taskId, repo: project, worktree, branch: `fm/${taskId}`, harness: dispatch.harness,
});
append("worktree-task", "worktree_created", {
  task_id: taskId, repo: project, worktree, branch: `fm/${taskId}`,
});
append("progress-task", "phase_transition", {
  phase: "worker-progress", task_id: taskId, next_action: nextAction,
});
append("complete-task", "task_completed", { task_id: taskId });
append("execution-done-task", "delivery_state_changed", {
  task_id: taskId, delivery_state: "EXECUTION_DONE", evidence: { status: "done" },
});
append("open-task-hold", "captain_hold_created", {
  task_id: taskId, hold_id: holdId, backlog_pointer: `data/backlog.md#${taskId}`,
});

// Everything above is unchanged Router V2 / mission-event-store bootstrap,
// already proven real in the prior round. What follows is this round's new
// proof: the tracked supervisor endpoint itself is a real `claude` process,
// not a fixture standing in for one. It performs the disposable trivial task
// (appending a fixed marker line to a file in the preserved worktree) for
// real, then blocks on a bounded `sleep` tool call so the harness process
// stays alive and killable, giving the test a race-free window to simulate
// an abrupt supervisor crash strictly after real, file-verifiable progress.
const promptText = readFileSync(promptFileArg, "utf8");
const progressFile = path.join(worktree, "progress.txt");
const claude = spawn("claude", [
  "-p", promptText,
  "--model", "claude-haiku-4-5-20251001",
  "--dangerously-skip-permissions",
  "--output-format", "text",
], { cwd: worktree, detached: true, stdio: ["ignore", "pipe", "pipe"] });
writeFileSync(path.join(state, "supervisor-a-real.pid"), String(claude.pid));
let claudeOut = "";
claude.stdout.on("data", (chunk) => { claudeOut += chunk; });
claude.on("exit", (code, signal) => {
  writeFileSync(path.join(state, "supervisor-a-real-exit"), `code=${code} signal=${signal}\n`);
  writeFileSync(path.join(state, "supervisor-a-real-stdout"), claudeOut);
});

const marker = "SUPERVISOR-FAILOVER-MARKER";
const deadline = Date.now() + 60000;
let progressSeen = false;
while (Date.now() < deadline) {
  if (existsSync(progressFile) && readFileSync(progressFile, "utf8").includes(marker)) {
    progressSeen = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!progressSeen) {
  throw new Error("real Supervisor A (claude) never produced verifiable progress within 60s");
}

execFileSync("bash", [continuity, "record-supervisor", missionId, String(claude.pid), "claude", "session-a"],
  { cwd: root, env, encoding: "utf8" });
writeFileSync(path.join(state, "supervisor-a-ready"), "ready\n");
setInterval(() => {}, 1000);
