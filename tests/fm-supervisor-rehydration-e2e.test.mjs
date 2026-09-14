import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MISSION = path.join(ROOT, "bin", "fm-mission.sh");
const CONTINUITY = path.join(ROOT, "bin", "fm-supervisor-continuity.sh");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "supervisor-rehydration");

function envFor(home, extra = {}) {
  return { ...process.env, FM_HOME: home, FM_ROOT_OVERRIDE: ROOT,
    FM_DATA_OVERRIDE: path.join(home, "data"), FM_STATE_OVERRIDE: path.join(home, "state"), ...extra };
}

function run(script, args, env) {
  return execFileSync("bash", [script, ...args], { cwd: ROOT, env, encoding: "utf8" });
}

async function waitFor(description, predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for " + description);
}

function live(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function runFailoverScenario(t, scenario) {
  const { missionId, taskId, promptText, nextAction, holdId } = scenario;
  const home = fsTemp("fm-supervisor-rehydration-");
  const state = path.join(home, "state");
  const data = path.join(home, "data");
  const project = path.join(home, "project");
  const worktree = path.join(home, "task-worktree");
  mkdirSync(state, { recursive: true });
  mkdirSync(data, { recursive: true });
  cpSync(path.join(ROOT, "tests", "fixtures", "router-v2"), home, { recursive: true });
  const env = envFor(home, {
    FM_DISABLE_LIVE_QUOTA: "1", FM_SUPERVISOR_CONTINUITY_INTERVAL: "0.1",
    FM_SUPERVISOR_CONTINUITY_WATCHER_GRACE: "10", FM_SUPERVISOR_USE_LIVE_QUOTA: "0",
    FM_SUPERVISOR_ROUTE_COMMAND: path.join(ROOT, "bin", "fm-supervisor-route.sh"),
    FM_SUPERVISOR_ROUTE_ROLE: "general_engineer", FM_SUPERVISOR_ROUTE_DATA_CLASS: "PUBLIC",
    FM_POLL: "1", FM_SIGNAL_GRACE: "0", FM_CHECK_INTERVAL: "999999", FM_HEARTBEAT: "1",
    FM_SUPERVISOR_COMMAND_CLAUDE: path.join(FIXTURES, "supervisor-b.sh"),
  });
  const prompt = path.join(home, "distinctive-original-prompt.md");
  const graph = path.join(home, "task-graph.json");
  writeFileSync(prompt, promptText);
  writeFileSync(graph, JSON.stringify([{ id: taskId, depends_on: [], status: "in_progress" }]));

  git(home, "init", "-q", project);
  execFileSync("git", ["-C", project, "config", "user.email", "fixture@example.invalid"]);
  execFileSync("git", ["-C", project, "config", "user.name", "fixture"]);
  writeFileSync(path.join(project, "README"), "fixture\n");
  execFileSync("git", ["-C", project, "add", "README"]);
  execFileSync("git", ["-C", project, "commit", "-qm", "fixture base"]);
  execFileSync("git", ["-C", project, "branch", "-M", "main"]);
  execFileSync("git", ["-C", project, "worktree", "add", "-q", "-b", `fm/${taskId}`, worktree]);

  run(MISSION, ["init", missionId, "--intent", "Recover the distinctive campaign prompt",
    "--prompt-file", prompt, "--task-graph-file", graph, "--next", nextAction,
    "--prompt-source-transcript", "fixture://supervisor-a", "--prompt-step-index", "17",
    "--prompt-classification", "EXACT_RECOVERED"], env);
  const supervisorA = spawn(process.execPath, [path.join(FIXTURES, "supervisor-a.mjs"), ROOT, home,
    path.join(FIXTURES, "synthetic-worker.sh"), missionId, taskId, nextAction, holdId], { cwd: ROOT, env, stdio: "ignore" });
  const continuity = spawn("bash", [CONTINUITY, "run"], { cwd: ROOT, env, stdio: "ignore" });
  let supervisorB;
  t.after(() => {
    for (const child of [continuity, supervisorB, supervisorA]) if (child && !child.killed) child.kill("SIGKILL");
    for (const name of ["worker.pid", "supervisor-b.pid"]) {
      const file = path.join(state, name);
      if (existsSync(file) && live(readFileSync(file, "utf8"))) process.kill(Number(readFileSync(file, "utf8")), "SIGKILL");
    }
    rmSync(home, { recursive: true, force: true });
  });

  await waitFor("Supervisor A to dispatch and record progress", () => {
    if (existsSync(path.join(state, "supervisor-a-error"))) {
      throw new Error(readFileSync(path.join(state, "supervisor-a-error"), "utf8"));
    }
    return existsSync(path.join(state, "supervisor-a-ready"));
  });
  const dispatch = JSON.parse(readFileSync(path.join(state, "dispatch-result.json"), "utf8"));
  assert.equal(dispatch.dispatched, true);
  assert.equal(dispatch.routeId, "codex:gpt-5.6-terra:medium");
  assert.match(dispatch.output, /synthetic Router V2 worker launch/);
  run(CONTINUITY, ["record-supervisor", missionId, String(supervisorA.pid), "codex", "session-a"], env);
  supervisorA.kill("SIGKILL");
  await waitFor("continuity to launch Supervisor B", () => existsSync(path.join(state, "supervisor-b-context.md")) && readFileSync(path.join(state, "supervisor-b-context.md"), "utf8").length > 0);
  const context = readFileSync(path.join(state, "supervisor-b-context.md"), "utf8");
  const launchInput = readFileSync(path.join(state, "supervisor-b-launch-input.md"), "utf8");
  const rawLaunchInput = readFileSync(path.join(state, "supervisor-b-launch-raw"), "utf8");
  assert.equal(readFileSync(path.join(state, "supervisor-b-launch-kind"), "utf8"), "launch-brief\n");
  assert.equal(launchInput.trimEnd(), context.trimEnd());
  assert.match(rawLaunchInput, /FIRSTMATE_OP: v1 launch-brief/);
  assert.match(context, new RegExp(`MISSION\\s+${missionId}`));
  const promptHash = createHash("sha256").update(readFileSync(prompt)).digest("hex");
  assert.match(context, new RegExp(`ORIGINAL PROMPT.*${promptHash}`));
  assert.match(context, new RegExp(`data/missions/${missionId}/original-prompt\\.md`));
  assert.match(context, new RegExp(`TASK GRAPH.*${taskId}`));
  assert.match(context, /worker-progress/);
  assert.match(context, /delivery_state=EXECUTION_DONE/);
  assert.match(context, /delivery_history=EXECUTION_DONE/);
  assert.match(context, new RegExp(`worktree=${worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(context, new RegExp(`branch=fm/${taskId}`));
  assert.match(context, new RegExp(`DECISIONS.*${holdId}`));
  assert.match(context, /RECOVERY.*SUPERVISOR_FAILOVER:codex/);
  assert.match(context, new RegExp(`NEXT ACTION.*${nextAction}`));

  const record = JSON.parse(readFileSync(path.join(state, "supervisor-continuity-replacement.json"), "utf8"));
  supervisorB = { pid: record.pid, killed: false, kill(signal) { process.kill(this.pid, signal); this.killed = true; } };
  // Mission-identity match: the replacement is recorded and materializes under the
  // exact same mission id Supervisor A was working, not a new or renamed mission.
  assert.equal(record.mission_id, missionId);
  assert.equal(record.harness, "claude");
  assert.ok(live(record.pid));
  const events = readFileSync(path.join(data, "missions", missionId, "events.jsonl"), "utf8");
  assert.match(events, /task_dispatched/);
  assert.match(events, /phase_transition/);
  assert.match(events, /SUPERVISOR_FAILOVER:codex/);
  assert.match(context, /sourced from event-store materialization plus live reconciliation/);

  // Acceptance criteria for continuity, not just a replacement process opening:
  // duplication check (the worker is dispatched exactly once across the failover)
  // and captain-intervention count (failover creates zero new captain holds or blocks).
  const dispatchCount = (events.match(/"type":"task_dispatched"/g) || []).length;
  assert.equal(dispatchCount, 1, "worker must not be re-dispatched by the failover");
  const holdCreatedCount = (events.match(/"type":"captain_hold_created"/g) || []).length;
  assert.equal(holdCreatedCount, 1, "failover must not create a new captain hold");
  assert.doesNotMatch(events, /"type":"task_blocked"/, "failover must not block the task on the captain");
  assert.doesNotMatch(events, /"type":"captain_hold_resolved"/, "failover requires no captain resolution");
}

test("Supervisor B rehydrates the mission after A is killed", async (t) => {
  await runFailoverScenario(t, {
    missionId: "rehydration-e2e",
    taskId: "rehydration-task",
    promptText: "# Distinctive campaign prompt\nRecover this exact mission without archaeology.\n",
    nextAction: "Resolve the open synthetic-task hold",
    holdId: "rehydration-hold",
  });
});

// Second, independently-constructed disposable mission (distinct id, task, prompt,
// worktree, and hold) run through the identical real pipeline. This is the low-stakes
// "second pass" proof that the wiring is not overfit to one hardcoded fixture value;
// see data/supervisor-rehydration-bootstrap-wiring/report.md for why a literal
// third-party vendor CLI is not substituted here (it would spend real provider quota
// and touch real host services, which the design deliberately keeps out of this
// portable, credential-free proof).
test("Supervisor B rehydrates a second, independently-constructed disposable mission", async (t) => {
  await runFailoverScenario(t, {
    missionId: "rehydration-e2e-second-pass",
    taskId: "second-pass-task",
    promptText: "# Second disposable campaign\nAn unrelated low-stakes mission constructed only for this proof.\n",
    nextAction: "Confirm the second-pass disposable hold clears cleanly",
    holdId: "second-pass-hold",
  });
});

function fsTemp(prefix) {
  return os.tmpdir() + "/" + prefix + process.pid + "-" + Date.now();
}
