// Live, quota-spending E2E: proves the supervisor-failover mechanism end to
// end with REAL vendor CLI processes on both ends of the failover, not the
// fixture stand-ins tests/fm-supervisor-rehydration-e2e.test.mjs uses for the
// harness endpoint. See docs/SUPERVISOR_REHYDRATION_E2E.md for the mechanism
// this exercises and data/supervisor-rehydration-bootstrap-wiring/report.md
// for why round 1 kept the harness endpoint a fixture.
//
// This test submits real prompts to real `claude` and `codex` processes and
// is therefore opt-in only, matching the live-harness-optin convention
// documented in .agents/skills/firstmate-coding-guidelines/SKILL.md
// ("Harness-dependent checks"): it never runs unless explicitly requested.
// Set FM_LIVE_SUPERVISOR_REAL_HARNESS_E2E=1 (or FM_LIVE=1) to run it; set
// either to 0 to force-skip. When explicitly requested, a missing `claude` or
// `codex` binary is a hard failure rather than a silent skip.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MISSION = path.join(ROOT, "bin", "fm-mission.sh");
const CONTINUITY = path.join(ROOT, "bin", "fm-supervisor-continuity.sh");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "supervisor-rehydration");

function liveGateDecision() {
  const own = process.env.FM_LIVE_SUPERVISOR_REAL_HARNESS_E2E;
  const global_ = process.env.FM_LIVE;
  if (own === "0" || (own === undefined && global_ === "0")) return { run: false, requested: false };
  if (own === "1" || (own === undefined && global_ === "1")) return { run: true, requested: true };
  return { run: false, requested: false };
}

function commandExists(name) {
  try { execFileSync("bash", ["-lc", `command -v ${name}`], { stdio: "pipe" }); return true; }
  catch { return false; }
}

function envFor(home, extra = {}) {
  return { ...process.env, FM_HOME: home, FM_ROOT_OVERRIDE: ROOT,
    FM_DATA_OVERRIDE: path.join(home, "data"), FM_STATE_OVERRIDE: path.join(home, "state"), ...extra };
}

function run(script, args, env) {
  return execFileSync("bash", [script, ...args], { cwd: ROOT, env, encoding: "utf8" });
}

async function waitFor(description, predicate, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for " + description);
}

function live(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function fsTemp(prefix) {
  return os.tmpdir() + "/" + prefix + process.pid + "-" + Date.now();
}

const gate = liveGateDecision();

test("real claude Supervisor A fails over to a real codex Supervisor B with zero captain intervention", async (t) => {
  if (!gate.run) {
    t.skip("live: opt-in; set FM_LIVE_SUPERVISOR_REAL_HARNESS_E2E=1 (or FM_LIVE=1) to spend real provider quota running this");
    return;
  }
  for (const tool of ["claude", "codex"]) {
    if (!commandExists(tool)) {
      throw new Error(`${tool} was requested (live gate is on) but is not installed`);
    }
  }

  const missionId = "rehydration-real-harness-e2e";
  const taskId = "rehydration-real-harness-task";
  const holdId = "rehydration-real-harness-hold";
  const nextAction = "Confirm the disposable real-harness failover marker landed exactly once";
  const home = fsTemp("fm-supervisor-real-harness-");
  const state = path.join(home, "state");
  const data = path.join(home, "data");
  const project = path.join(home, "project");
  const worktree = path.join(home, "task-worktree");
  mkdirSync(state, { recursive: true });
  mkdirSync(data, { recursive: true });
  cpSync(path.join(ROOT, "tests", "fixtures", "router-v2"), home, { recursive: true });

  const progressFile = path.join(worktree, "progress.txt");
  const marker = "SUPERVISOR-FAILOVER-MARKER";
  const promptText = `# Disposable supervisor-failover test task

There is a file at exactly this path: ${progressFile}

Check whether that file already contains the exact line:
${marker}

If it does NOT already contain that line:
1. Append that exact line to the file (create the file if it does not exist).
2. Run the shell command: sleep 20
   Wait for that command to finish before doing anything else.
3. After the sleep finishes, print exactly this and nothing else:
SUPERVISOR-A-TURN-COMPLETE

If it ALREADY contains that line:
1. Do NOT append it again under any circumstance.
2. Print exactly this and nothing else:
SUPERVISOR-B-SKIPPED-DUPLICATE

Do not explain your reasoning. Do not do anything else.
`;

  const env = envFor(home, {
    FM_DISABLE_LIVE_QUOTA: "1", FM_SUPERVISOR_CONTINUITY_INTERVAL: "0.1",
    FM_SUPERVISOR_CONTINUITY_WATCHER_GRACE: "10", FM_SUPERVISOR_USE_LIVE_QUOTA: "0",
    FM_SUPERVISOR_ROUTE_COMMAND: path.join(ROOT, "bin", "fm-supervisor-route.sh"),
    FM_SUPERVISOR_ROUTE_ROLE: "general_engineer", FM_SUPERVISOR_ROUTE_DATA_CLASS: "PUBLIC",
    FM_POLL: "1", FM_SIGNAL_GRACE: "0", FM_CHECK_INTERVAL: "999999", FM_HEARTBEAT: "1",
    FM_SUPERVISOR_COMMAND_CODEX: path.join(FIXTURES, "supervisor-b-real.sh"),
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

  run(MISSION, ["init", missionId, "--intent", "Recover the distinctive real-harness campaign prompt",
    "--prompt-file", prompt, "--task-graph-file", graph, "--next", nextAction,
    "--prompt-source-transcript", "fixture://supervisor-a-real", "--prompt-step-index", "1",
    "--prompt-classification", "EXACT_RECOVERED"], env);

  const supervisorA = spawn(process.execPath, [
    path.join(FIXTURES, "supervisor-a-real.mjs"), ROOT, home,
    path.join(FIXTURES, "synthetic-worker.sh"), missionId, taskId, nextAction, holdId, prompt,
  ], { cwd: ROOT, env, stdio: "ignore" });
  const continuity = spawn("bash", [CONTINUITY, "run"], { cwd: ROOT, env, stdio: "ignore" });
  let realAPid = null;
  let supervisorBWrapperPid = null;
  t.after(() => {
    if (realAPid && live(realAPid)) {
      try { process.kill(-realAPid, "SIGKILL"); } catch { try { process.kill(realAPid, "SIGKILL"); } catch {} }
    }
    if (supervisorBWrapperPid && live(supervisorBWrapperPid)) {
      try { process.kill(supervisorBWrapperPid, "SIGKILL"); } catch {}
    }
    for (const child of [continuity, supervisorA]) if (child && !child.killed) child.kill("SIGKILL");
    for (const name of ["worker.pid", "supervisor-b.pid"]) {
      const file = path.join(state, name);
      if (existsSync(file) && live(readFileSync(file, "utf8"))) {
        try { process.kill(Number(readFileSync(file, "utf8")), "SIGKILL"); } catch {}
      }
    }
    rmSync(home, { recursive: true, force: true });
  });

  // --- Supervisor A: real claude process produces verifiable progress ----
  await waitFor("real Supervisor A (claude) to reach ready with verifiable progress", () => {
    if (existsSync(path.join(state, "supervisor-a-error"))) {
      throw new Error(readFileSync(path.join(state, "supervisor-a-error"), "utf8"));
    }
    return existsSync(path.join(state, "supervisor-a-ready"));
  }, 90000);

  const dispatch = JSON.parse(readFileSync(path.join(state, "dispatch-result.json"), "utf8"));
  assert.equal(dispatch.dispatched, true);
  assert.match(dispatch.output, /synthetic Router V2 worker launch/);

  assert.ok(existsSync(progressFile), "real Supervisor A must have created the progress file");
  const progressAfterA = readFileSync(progressFile, "utf8");
  assert.match(progressAfterA, new RegExp(marker), "real Supervisor A must have appended the marker for real");

  realAPid = Number(readFileSync(path.join(state, "supervisor-a-real.pid"), "utf8").trim());
  assert.ok(live(realAPid), "the real Supervisor A harness process must still be alive right before termination");

  // --- A is terminated: simulate a genuine supervisor crash -------------
  try { process.kill(-realAPid, "SIGKILL"); } catch { process.kill(realAPid, "SIGKILL"); }
  await waitFor("the real Supervisor A process to actually die", () => !live(realAPid), 5000);
  const aStdoutAfterKill = existsSync(path.join(state, "supervisor-a-real-stdout"))
    ? readFileSync(path.join(state, "supervisor-a-real-stdout"), "utf8") : "";
  assert.doesNotMatch(aStdoutAfterKill, /SUPERVISOR-A-TURN-COMPLETE/,
    "Supervisor A must have been killed mid-turn, before it could report its own completion");

  // --- Continuity detects the loss and routes to a real codex Supervisor B
  await waitFor("continuity to launch the real codex Supervisor B", () =>
    existsSync(path.join(state, "supervisor-b-context.md")) &&
    readFileSync(path.join(state, "supervisor-b-context.md"), "utf8").length > 0, 30000);
  const context = readFileSync(path.join(state, "supervisor-b-context.md"), "utf8");
  const launchInput = readFileSync(path.join(state, "supervisor-b-launch-input.md"), "utf8");
  const rawLaunchInput = readFileSync(path.join(state, "supervisor-b-launch-raw"), "utf8");
  assert.equal(readFileSync(path.join(state, "supervisor-b-launch-kind"), "utf8"), "launch-brief\n");
  assert.equal(launchInput.trimEnd(), context.trimEnd());
  assert.match(rawLaunchInput, /FIRSTMATE_OP: v1 launch-brief/);
  assert.match(context, new RegExp(`MISSION\\s+${missionId}`));
  assert.match(context, new RegExp(`TASK GRAPH.*${taskId}`));
  assert.match(context, /worker-progress/);
  assert.match(context, /delivery_state=EXECUTION_DONE/);
  assert.match(context, /delivery_history=EXECUTION_DONE/);
  assert.match(context, new RegExp(`worktree=${worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(context, new RegExp(`branch=fm/${taskId}`));
  assert.match(context, new RegExp(`DECISIONS.*${holdId}`));
  assert.match(context, /RECOVERY.*SUPERVISOR_FAILOVER:claude/);
  assert.match(context, new RegExp(`data/missions/${missionId}/original-prompt\\.md`));

  const record = JSON.parse(readFileSync(path.join(state, "supervisor-continuity-replacement.json"), "utf8"));
  assert.equal(record.mission_id, missionId, "mission_id must be preserved across the failover");
  assert.equal(record.harness, "codex", "Router V2 must route the replacement to a harness other than the dead one");
  assert.ok(live(record.pid), "the real replacement (codex wrapper) process must be alive");
  supervisorBWrapperPid = record.pid;

  // --- B must not duplicate the already-done work, and must complete -----
  await waitFor("real Supervisor B (codex) to finish acting on the delivered context", () =>
    existsSync(path.join(state, "supervisor-b-real-done")), 90000);
  const bOutput = readFileSync(path.join(state, "supervisor-b-real-output.txt"), "utf8").trim();
  assert.equal(bOutput, "SUPERVISOR-B-SKIPPED-DUPLICATE",
    "Supervisor B must genuinely read the delivered context, resolve the original-prompt pointer, " +
    "inspect the preserved worktree, and recognize the task was already done rather than redoing it");

  const progressAfterB = readFileSync(progressFile, "utf8");
  const markerCount = (progressAfterB.match(new RegExp(marker, "g")) || []).length;
  assert.equal(markerCount, 1, "the marker must appear exactly once: B must not have duplicated A's work");

  const events = readFileSync(path.join(data, "missions", missionId, "events.jsonl"), "utf8");
  assert.match(events, /task_dispatched/);
  assert.match(events, /phase_transition/);
  assert.match(events, /SUPERVISOR_FAILOVER:claude/);

  // Duplication check (the worker is dispatched exactly once across the
  // failover) and captain-intervention count (failover creates zero new
  // captain holds, blocks, or resolutions) - same acceptance bar as round 1,
  // now proven against real harness processes on both ends.
  const dispatchCount = (events.match(/"type":"task_dispatched"/g) || []).length;
  assert.equal(dispatchCount, 1, "worker must not be re-dispatched by the failover");
  const holdCreatedCount = (events.match(/"type":"captain_hold_created"/g) || []).length;
  assert.equal(holdCreatedCount, 1, "failover must not create a new captain hold");
  assert.doesNotMatch(events, /"type":"task_blocked"/, "failover must not block the task on the captain");
  assert.doesNotMatch(events, /"type":"captain_hold_resolved"/, "failover requires no captain resolution");
});
