#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRouterFixtureHome } from "./router-v2-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const API_SCRIPT = resolve(ROOT, "bin/fm-orchestrator-api.mjs");
const home = makeRouterFixtureHome();
const { TOOLS, executeVerb } = await import("../bin/fm-orchestrator-api.mjs");

const expectedNames = [
  "cancel",
  "dispatch",
  "get_backlog",
  "get_task",
  "list_workers",
  "needs_attention",
  "send",
  "status"
].sort();
assert.deepEqual(TOOLS.map((tool) => tool.name).sort(), expectedNames);
assert.deepEqual(TOOLS.find((tool) => tool.name === "dispatch").inputSchema.required, ["id", "description", "dataClass"]);

const backlog = await executeVerb("get_backlog");
assert.ok(Array.isArray(backlog));
const workers = await executeVerb("list_workers");
assert.ok(Array.isArray(workers));
const attention = await executeVerb("needs_attention");
assert.ok(Array.isArray(attention));
const status = await executeVerb("status", { id: "api-test-missing" });
assert.equal(status.id, "api-test-missing");

const taskId = "api-router-dispatch";
fs.mkdirSync(path.join(home, "data", taskId), { recursive: true });
fs.writeFileSync(path.join(home, "data", taskId, "brief.md"), "# synthetic API brief\n");
let spawnArgs;
const dispatch = await executeVerb("dispatch", {
  id: taskId,
  description: "Synthetic API dispatch through Router V2",
  role: "general_engineer",
  dataClass: "PUBLIC",
  effort: "medium",
  scout: true
}, {
  spawnRunner: (args) => {
    spawnArgs = args;
    fs.mkdirSync(path.join(home, "state"), { recursive: true });
    fs.writeFileSync(path.join(home, "state", `${taskId}.meta`), "backend=herdr\nharness=codex\nmodel=gpt-5.6-terra\neffort=medium\n");
    return { success: true, output: "synthetic API launch" };
  }
});
assert.equal(dispatch.dispatched, true);
assert.equal(dispatch.routeId, "codex:gpt-5.6-terra:medium");
assert.equal(dispatch.model, "gpt-5.6-terra");
assert.ok(spawnArgs.includes("--backend"));
assert.equal(spawnArgs[spawnArgs.indexOf("--backend") + 1], "herdr");
assert.ok(fs.readFileSync(path.join(home, "data", "routing-executions.jsonl"), "utf8").includes(taskId));

await assert.rejects(
  () => executeVerb("dispatch", { id: taskId, description: "missing classification" }),
  /dataClass.*fail-closed/
);
await assert.rejects(
  () => executeVerb("dispatch", { id: taskId, description: "concrete override", dataClass: "PUBLIC", harness: "claude" }),
  /Router V2 owns concrete RouteTarget selection/
);

function runMcpTest() {
  return new Promise((resolveTest, rejectTest) => {
    const child = spawn("node", [API_SCRIPT, "--mcp"], {
      cwd: ROOT,
      env: { ...process.env, FM_HOME: home, FM_DISABLE_LIVE_QUOTA: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let nextId = 1;
    let buffer = "";
    const pending = new Map();
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const pendingRequest = pending.get(message.id);
        if (!pendingRequest) continue;
        pending.delete(message.id);
        if (message.error) pendingRequest.reject(new Error(message.error.message));
        else pendingRequest.resolve(message.result);
      }
    });
    child.on("error", rejectTest);
    child.on("exit", (code) => {
      if (code !== null && code !== 0 && pending.size) rejectTest(new Error(`MCP exited ${code}: ${stderr.join("")}`));
    });
    const request = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
      const id = nextId++;
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    (async () => {
      try {
        const initialized = await request("initialize");
        assert.equal(initialized.serverInfo.name, "firstmate-orchestrator");
        const tools = await request("tools/list");
        assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), expectedNames);
        for (const name of ["get_backlog", "list_workers", "needs_attention"]) {
          const call = await request("tools/call", { name, arguments: {} });
          assert.ok(call.content?.[0]?.text);
          assert.ok(Array.isArray(JSON.parse(call.content[0].text)));
        }
        child.kill();
        resolveTest();
      } catch (error) {
        child.kill();
        rejectTest(error);
      }
    })();
  });
}

await runMcpTest();
console.log("Orchestrator API eight-verb and Router V2 seam fixtures passed");
