import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTINUITY = path.join(ROOT, "bin", "fm-supervisor-continuity.sh");
const MISSION = path.join(ROOT, "bin", "fm-mission.sh");

function envFor(home, extra) {
  return {
    ...process.env,
    FM_HOME: home,
    FM_ROOT_OVERRIDE: ROOT,
    FM_DATA_OVERRIDE: path.join(home, "data"),
    FM_STATE_OVERRIDE: path.join(home, "state"),
    ...extra,
  };
}

function run(script, args, env) {
  return execFileSync("bash", [script, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitFor(description, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for " + description + (lastError ? ": " + lastError : ""));
}

function live(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("supervisor continuity survives supervisor and service process loss", async (t) => {
  const home = os.tmpdir() + "/fm-supervisor-continuity-" + process.pid + "-" + Date.now();
  const state = path.join(home, "state");
  const data = path.join(home, "data");
  const missionId = "continuity-e2e";
  const missionDir = path.join(data, "missions", missionId);
  mkdirSync(state, { recursive: true });
  mkdirSync(data, { recursive: true });

  const prompt = path.join(home, "original-prompt.md");
  const graph = path.join(home, "task-graph.json");
  writeFileSync(prompt, "# Durable prompt\\nPreserve this exact intent.\\n");
  writeFileSync(graph, JSON.stringify([
    { id: "step-a", depends_on: [], status: "done" },
    { id: "step-b", depends_on: ["step-a"], status: "next" },
  ]));

  const env = envFor(home, {
    FM_SUPERVISOR_CONTINUITY_INTERVAL: "0.1",
    FM_SUPERVISOR_CONTINUITY_WATCHER_GRACE: "10",
    FM_SUPERVISOR_ROUTE_COMMAND: path.join(home, "route.sh"),
    FM_POLL: "1",
    FM_SIGNAL_GRACE: "0",
    FM_CHECK_INTERVAL: "999999",
    FM_HEARTBEAT: "1",
  });

  const replacement = path.join(home, "replacement.sh");
  writeFileSync(replacement, [
    "#!/usr/bin/env bash",
    "set -u",
    "printf '%s\\n' \"$$\" > \"$FM_HOME/state/replacement.pid\"",
    "\"$FM_ROOT_OVERRIDE/bin/fm-supervisor-continuity.sh\" record-supervisor \"$FM_MISSION_ID\" \"$$\" codex \"$FM_SUPERVISOR_SESSION_ID\"",
    "sleep 30",
    "",
  ].join("\n"));
  chmodSync(replacement, 0o700);

  const route = path.join(home, "route.sh");
  writeFileSync(route, [
    "#!/usr/bin/env bash",
    "printf 'harness=codex\\n'",
    "printf 'command=%s\\n' \"$FM_SUPERVISOR_REPLACEMENT_COMMAND\"",
    "",
  ].join("\n"));
  chmodSync(route, 0o700);

  const routeEnv = { ...env, FM_SUPERVISOR_REPLACEMENT_COMMAND: replacement };
  t.after(() => {
    for (const child of [continuity, replacementProcess, supervisor]) {
      if (child && !child.killed) child.kill("SIGKILL");
    }
    rmSync(home, { recursive: true, force: true });
  });

  run(MISSION, [
    "init", missionId, "--intent", "Keep the mission alive across supervisor quota exhaustion",
    "--prompt-file", prompt, "--task-graph-file", graph,
    "--next", "step-b",
  ], env);
  run(MISSION, ["session-start", missionId, "--harness", "claude", "--session-id", "session-a"], env);

  const supervisor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: ROOT,
    env: routeEnv,
    stdio: "ignore",
  });
  run(CONTINUITY, ["record-supervisor", missionId, String(supervisor.pid), "claude", "session-a"], env);

  const continuity = spawn("bash", [CONTINUITY, "run"], {
    cwd: ROOT,
    env: routeEnv,
    stdio: "ignore",
  });
  let replacementProcess;
  await waitFor("the actual FirstMate watcher", () => {
    const pid = Number(readFileSync(path.join(state, ".watch.lock", "pid"), "utf8"));
    return live(pid);
  });
  const watcherBefore = Number(readFileSync(path.join(state, ".watch.lock", "pid"), "utf8"));
  assert.notEqual(watcherBefore, continuity.pid, "watcher must not be the continuity process");

  supervisor.kill("SIGKILL");
  await waitFor("a replacement recorded for the same mission", () => existsSync(path.join(state, "supervisor-continuity-replacement.json")));
  const replacementRecord = JSON.parse(readFileSync(path.join(state, "supervisor-continuity-replacement.json"), "utf8"));
  replacementProcess = { pid: replacementRecord.pid, killed: false, kill(signal) { process.kill(this.pid, signal); this.killed = true; } };
  assert.equal(replacementRecord.mission_id, missionId);
  assert.equal(replacementRecord.harness, "codex");
  assert.equal(replacementRecord.original_prompt_pointer, "data/missions/" + missionId + "/original-prompt.md");
  assert.deepEqual(replacementRecord.task_graph, JSON.parse(readFileSync(graph, "utf8")));
  assert.equal(replacementRecord.next_action, "step-b");
  assert.notEqual(replacementRecord.pid, supervisor.pid);
  assert.ok(live(replacementRecord.pid), "replacement must be a real live process");

  const mission = JSON.parse(readFileSync(path.join(missionDir, "mission.json"), "utf8"));
  assert.equal(mission.sessions[0].status, "ENDED");
  assert.equal(mission.sessions[0].end_reason, "SUPERVISOR_FAILOVER:claude");
  assert.equal(mission.sessions[1].harness, "codex");
  assert.equal(mission.sessions[1].status, "RUNNING");

  let watcherDiagnostic = "";
  try {
    watcherDiagnostic = readFileSync(path.join(state, ".supervisor-continuity.log"), "utf8");
    watcherDiagnostic += readFileSync(path.join(state, ".supervisor-continuity-watcher.log"), "utf8");
  } catch {}
  assert.ok(live(watcherBefore), "the watcher must survive the supervisor process death\n" + watcherDiagnostic);
  process.kill(watcherBefore, "SIGKILL");
  await waitFor("the dead watcher to be replaced without an LLM turn", () => {
    const pid = Number(readFileSync(path.join(state, ".watch.lock", "pid"), "utf8"));
    return pid !== watcherBefore && live(pid);
  });
  const watcherAfter = Number(readFileSync(path.join(state, ".watch.lock", "pid"), "utf8"));
  assert.ok(live(watcherAfter));

  continuity.kill("SIGKILL");
  await new Promise((resolve) => continuity.once("exit", resolve));
  assert.ok(live(watcherAfter), "the detached watcher must survive continuity service death");

  const replacementContinuity = spawn("bash", [CONTINUITY, "run"], {
    cwd: ROOT,
    env: routeEnv,
    stdio: "ignore",
  });
  await waitFor("a restarted continuity service to observe the existing replacement", () => live(replacementRecord.pid));
  assert.ok(live(watcherAfter), "a restarted service must not create a duplicate watcher");
  replacementContinuity.kill("SIGKILL");
  await new Promise((resolve) => replacementContinuity.once("exit", resolve));
});
