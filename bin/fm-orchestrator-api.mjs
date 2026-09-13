#!/usr/bin/env node
/**
 * The eight-verb Orchestrator API for FirstMate.
 *
 * Read-only verbs use the current FirstMate snapshot and state primitives.
 * Dispatch accepts a requested role, effort, and data class, then delegates
 * concrete RouteTarget selection and Herdr dispatch to Router V2.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { dispatchThroughHerdr } from "./fm-router-v2.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const BIN_DIR = resolve(ROOT_DIR, "bin");

export const TOOLS = [
  {
    name: "get_backlog",
    description: "List the coordinator's tracked work items, including identifier, state, title, and any hold.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional state filter (for example queued or done)." }
      }
    }
  },
  {
    name: "get_task",
    description: "Retrieve one work item's current coordinator record and execution state by identifier.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task identifier." }
      },
      required: ["id"]
    }
  },
  {
    name: "dispatch",
    description: "Start a provisioned work item through Router V2 and the Herdr dispatch seam.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique task identifier." },
        description: { type: "string", description: "Brief description of the work." },
        role: { type: "string", description: "Requested canonical role profile." },
        dataClass: { type: "string", description: "Required data classification for Router V2 policy evaluation." },
        effort: { type: "string", description: "Optional requested reasoning effort." },
        scout: { type: "boolean", description: "Whether to dispatch as a disposable scout (default: true)." }
      },
      required: ["id", "description", "dataClass"]
    }
  },
  {
    name: "list_workers",
    description: "List the coordinator's active workers and their current execution state.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "send",
    description: "Send a coordinator message to a running worker.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task identifier." },
        message: { type: "string", description: "The message to send." }
      },
      required: ["id", "message"]
    }
  },
  {
    name: "status",
    description: "Get the current execution state of one work item by identifier.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task identifier." }
      },
      required: ["id"]
    }
  },
  {
    name: "cancel",
    description: "Request orderly cancellation of one work item by identifier.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task identifier." },
        reason: { type: "string", description: "Reason for cancellation." },
        teardown: { type: "boolean", description: "Whether to tear down the worktree after cancellation." }
      },
      required: ["id"]
    }
  },
  {
    name: "needs_attention",
    description: "List active work that is blocked, failed, parked, or awaiting a decision.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

function runScript(scriptName, args = [], options = {}) {
  const scriptPath = resolve(BIN_DIR, scriptName);
  const result = spawnSync(scriptPath, args, {
    cwd: ROOT_DIR,
    encoding: "utf-8",
    env: { ...process.env, ...options.env }
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error?.message || null
  };
}

function parseSnapshot(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    return { error: `Failed to parse ${label} snapshot: ${error.message}`, raw: stdout };
  }
}

export async function executeVerb(verb, params = {}, hooks = {}) {
  switch (verb) {
    case "get_backlog": {
      const { stdout } = runScript("fm-fleet-snapshot.sh", ["--json"]);
      const snapshot = parseSnapshot(stdout, "backlog");
      if (snapshot.error) return snapshot;
      let records = snapshot?.backlog?.records || [];
      if (params.filter) records = records.filter((record) => record.state === params.filter);
      return records.map((record) => ({
        id: record.id,
        state: record.state,
        title: record.title,
        hold: record.hold_reason || record.hold || null
      }));
    }

    case "get_task":
    case "status": {
      if (!params.id) throw new Error("Missing required parameter: id");
      const result = runScript("fm-crew-state.sh", [params.id]);
      return {
        id: params.id,
        state: result.stdout.trim() || result.stderr.trim(),
        exitCode: result.code
      };
    }

    case "list_workers": {
      const { stdout } = runScript("fm-fleet-snapshot.sh", ["--json"]);
      const snapshot = parseSnapshot(stdout, "worker");
      if (snapshot.error) return snapshot;
      return (snapshot?.tasks || []).map((task) => ({
        id: task.id,
        kind: task.kind,
        state: task.state || "unknown",
        harness: task.harness,
        endpoint: task.endpoint
      }));
    }

    case "send": {
      if (!params.id || !params.message) throw new Error("Missing required parameters: id, message");
      const result = runScript("fm-send.sh", [params.id, params.message]);
      return {
        id: params.id,
        sent: result.code === 0,
        output: result.stdout.trim(),
        error: result.code !== 0 ? result.stderr.trim() || result.error : null
      };
    }

    case "cancel": {
      if (!params.id) throw new Error("Missing required parameter: id");
      const args = [params.id, "--json"];
      if (params.reason) args.push("--reason", params.reason);
      if (params.teardown) args.push("--teardown");
      const result = runScript("fm-cancel.sh", args);
      try {
        return JSON.parse(result.stdout);
      } catch {
        return {
          id: params.id,
          cancelled: result.code === 0,
          output: result.stdout.trim() || result.stderr.trim() || result.error
        };
      }
    }

    case "needs_attention": {
      const { stdout } = runScript("fm-fleet-snapshot.sh", ["--json"]);
      const snapshot = parseSnapshot(stdout, "attention");
      if (snapshot.error) return snapshot;
      const attentionItems = [];
      for (const task of snapshot?.tasks || []) {
        const state = (task.state || "").toLowerCase();
        if (["blocked", "failed", "parked", "decision"].some((term) => state.includes(term))) {
          attentionItems.push({
            type: "task",
            id: task.id,
            state: task.state,
            kind: task.kind,
            reason: `Task state is ${task.state}`
          });
        }
      }
      for (const record of snapshot?.backlog?.records || []) {
        if (record.hold_reason || record.hold) {
          attentionItems.push({
            type: "backlog",
            id: record.id,
            state: record.state,
            title: record.title,
            hold: record.hold_reason || record.hold
          });
        }
      }
      return attentionItems;
    }

    case "dispatch": {
      if (!params.id) throw new Error("Missing required parameter: id");
      if (!params.description) throw new Error("Missing required parameter: description");
      if (!params.dataClass || params.dataClass === "UNKNOWN") {
        throw new Error("Missing or invalid required parameter: dataClass (fail-closed policy)");
      }
      if (params.harness || params.model) {
        throw new Error("harness/model overrides are not accepted; Router V2 owns concrete RouteTarget selection");
      }
      const result = dispatchThroughHerdr({
        taskId: params.id,
        role: params.role || "general_engineer",
        dataClass: params.dataClass,
        targetEffort: params.effort || null,
        intent: params.description,
        spec: params.spec || params.description,
        scout: params.scout !== false,
        projectDir: ROOT_DIR,
        ...(hooks.spawnRunner ? { spawnRunner: hooks.spawnRunner } : {})
      });
      return {
        id: params.id,
        role: result.routeDecision?.role,
        routeId: result.selectedRoute?.route_id,
        harness: result.selectedRoute?.harness,
        model: result.selectedRoute?.resolved_runtime_model,
        effort: result.selectedRoute?.reasoning_effort,
        herdr: result.herdr,
        dispatched: result.success,
        output: result.spawnOutput,
        error: result.error || null
      };
    }

    default:
      throw new Error(`Unknown orchestrator verb: ${verb}`);
  }
}

function runMcpServer() {
  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const sendResponse = (id, result, error = null) => {
    const response = { jsonrpc: "2.0", id };
    if (error) {
      response.error = typeof error === "string" ? { code: -32603, message: error } : error;
    } else {
      response.result = result;
    }
    process.stdout.write(`${JSON.stringify(response)}\n`);
  };

  readline.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      const { id, method, params } = message;
      switch (method) {
        case "initialize":
          sendResponse(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "firstmate-orchestrator", version: "1.0.0" }
          });
          break;
        case "notifications/initialized":
          break;
        case "tools/list":
          sendResponse(id, { tools: TOOLS });
          break;
        case "tools/call": {
          const toolName = params?.name?.replace(/^mcp__orchestrator__|^orchestrator__/, "");
          try {
            const outcome = await executeVerb(toolName, params?.arguments || {});
            sendResponse(id, {
              content: [{ type: "text", text: typeof outcome === "string" ? outcome : JSON.stringify(outcome, null, 2) }]
            });
          } catch (error) {
            sendResponse(id, {
              content: [{ type: "text", text: `Error: ${error.message}` }],
              isError: true
            });
          }
          break;
        }
        default:
          if (id) sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
      }
    } catch (error) {
      sendResponse(null, null, { code: -32700, message: `Parse error: ${error.message}` });
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--mcp")) {
    runMcpServer();
    return;
  }
  const verb = args[0];
  if (!verb || verb === "--help" || verb === "-h") {
    console.log("FirstMate - 8-Verb Orchestrator API");
    console.log("Usage: fm-orchestrator-api.mjs <verb> [json-params] | --mcp");
    for (const tool of TOOLS) console.log(`  ${tool.name.padEnd(18)} ${tool.description}`);
    return;
  }
  try {
    let params = {};
    if (args[1]) {
      try {
        params = JSON.parse(args[1]);
      } catch {
        params = { id: args[1], message: args[2] };
      }
    }
    const result = await executeVerb(verb, params);
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Error executing ${verb}:`, error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
