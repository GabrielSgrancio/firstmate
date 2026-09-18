#!/usr/bin/env node
// Full-pool before/after shadow replay runner (correction pass item 6).
// Deterministic read-only replay: same 30 real tasks and the same quota
// snapshot overrides as b5/b7/b8. One snapshot = one scoreAndSelectRoute per
// task with requireSpawnable=false. No state mutation beyond this process.
//
// Usage: FM_ROUTER_MODULE=<bin/fm-router-v2.mjs path> FM_HOME=<home> \
//        FM_REPLAY_OUT=<file> node evidence/router/full_pool_replay.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
process.env.FM_HOME = process.env.FM_HOME || path.join(REPO, 'data');

const { scoreAndSelectRoute, loadConfigs } = await import(
  process.env.FM_ROUTER_MODULE || path.join(REPO, 'bin', 'fm-router-v2.mjs'));

// Task set identical to the b5 shadow replay's 30 tasks (roles/classes verbatim
// from the recorded b7 evidence; the three critical_auditor tasks included).
const TASK_TASK_SET = JSON.parse(fs.readFileSync(path.join(HERE, 'replay-task-set.json'), 'utf8'));

const SNAPSHOT_OVERRIDES = {
  snapshot_1_current_real: {
    codex_plus: { status: 'EXHAUSTED', scarcity_state: 'EXHAUSTED', windows: { five_hour: { percent_remaining: 0 }, weekly: { percent_remaining: 0 } } },
    claude_pro: { status: 'HEALTHY', scarcity_state: 'CONSERVE', windows: { five_hour: { percent_remaining: 39 }, seven_day: { percent_remaining: 24 } } },
    antigravity_gemini: { status: 'HEALTHY', scarcity_state: 'ABUNDANT', windows: { 'gemini-5h': { percent_remaining: 77 }, 'gemini-weekly': { percent_remaining: 78 } } },
    antigravity_3p: { status: 'HEALTHY', scarcity_state: 'NORMAL', windows: { '3p-5h': { percent_remaining: 100 }, '3p-weekly': { percent_remaining: 31 } } },
    opencode_go: {
      status: 'HEALTHY', scarcity_state: 'ABUNDANT',
      windows: { rolling_5h: { percent_remaining: 100 }, weekly: { percent_remaining: 54 }, monthly: { percent_remaining: 61 } }
    }
  },
  snapshot_2_claude_codex_exhausted: {
    codex_plus: { status: 'EXHAUSTED', scarcity_state: 'EXHAUSTED', windows: { five_hour: { percent_remaining: 0 }, weekly: { percent_remaining: 0 } } },
    claude_pro: { status: 'EXHAUSTED', scarcity_state: 'EXHAUSTED', windows: { five_hour: { percent_remaining: 0 }, seven_day: { percent_remaining: 0 } } },
    antigravity_gemini: { status: 'HEALTHY', scarcity_state: 'ABUNDANT', windows: { 'gemini-5h': { percent_remaining: 77 }, 'gemini-weekly': { percent_remaining: 78 } } },
    antigravity_3p: { status: 'HEALTHY', scarcity_state: 'NORMAL', windows: { '3p-5h': { percent_remaining: 100 }, '3p-weekly': { percent_remaining: 31 } } },
    opencode_go: {
      status: 'HEALTHY', scarcity_state: 'ABUNDANT',
      windows: { rolling_5h: { percent_remaining: 100 }, weekly: { percent_remaining: 54 }, monthly: { percent_remaining: 61 } }
    }
  },
  snapshot_3_balanced_headroom: {
    codex_plus: { status: 'HEALTHY', scarcity_state: 'NORMAL', windows: { five_hour: { percent_remaining: 62 }, weekly: { percent_remaining: 57 } } },
    claude_pro: { status: 'HEALTHY', scarcity_state: 'NORMAL', windows: { five_hour: { percent_remaining: 71 }, seven_day: { percent_remaining: 48 } } },
    antigravity_gemini: { status: 'HEALTHY', scarcity_state: 'ABUNDANT', windows: { 'gemini-5h': { percent_remaining: 84 }, 'gemini-weekly': { percent_remaining: 72 } } },
    antigravity_3p: { status: 'HEALTHY', scarcity_state: 'ABUNDANT', windows: { '3p-5h': { percent_remaining: 100 }, '3p-weekly': { percent_remaining: 66 } } },
    opencode_go: {
      status: 'HEALTHY', scarcity_state: 'ABUNDANT',
      windows: { rolling_5h: { percent_remaining: 100 }, weekly: { percent_remaining: 46 }, monthly: { percent_remaining: 54 } }
    }
  }
};

function applyOverrides(basePools, overrides) {
  const pools = {};
  for (const [name, base] of Object.entries(basePools)) {
    const override = overrides[name];
    if (!override) { pools[name] = base; continue; }
    const joined = { ...base, ...override };
    joined._explicit_override = true;
    pools[name] = joined;
  }
  return pools;
}

const out = {};
for (const [snapshotName, overrides] of Object.entries(SNAPSHOT_OVERRIDES)) {
  const taskRuns = [];
  for (const task of TASK_TASK_SET) {
    try {
      const decision = scoreAndSelectRoute({
        role: task.role,
        taskClass: task.task_class,
        dataClass: task.data_class,
        targetEffort: task.effort,
        critical: task.critical,
        retryTolerant: task.retry_tolerant,
        quotaOverrides: applyOverrides(loadConfigs().quotaMap.pools, overrides),
        useLiveAxi: false,
        telemetryRecords: [],
        requireSpawnable: false,
        explorationRandom: null
      });
      taskRuns.push({
        task_id: task.task_id, role: task.role, data_class: task.data_class,
        effort: task.effort, critical: task.critical, retry_tolerant: task.retry_tolerant,
        snapshot: snapshotName,
        outcome: 'routed',
        selected_route_id: decision.selectedRoute.route_id,
        selected_harness: decision.harness,
        selected_model: decision.selectedModelId,
        task_class: decision.taskClass,
        final_score: decision.finalScore,
        quality_floor: decision.qualityFloor,
        viable: decision.viableCandidatesCount,
        sufficient: decision.sufficientCandidatesCount,
        candidates: decision.candidateRoutesCount,
        selected_economics: decision.selectedRouteEconomics,
        top: decision.topCandidates.slice(0, 3),
        stageC_ranking: (decision.stages.stageC.ranking || []).slice(0, 6),
        stageA_survivors: decision.stages.stageA.survivor_count,
        stageB_survivors: decision.stages.stageB.survivor_count
      });
    } catch (error) {
      taskRuns.push({
        task_id: task.task_id, role: task.role, data_class: task.data_class,
        effort: task.effort, critical: task.critical, retry_tolerant: task.retry_tolerant,
        snapshot: snapshotName, outcome: 'rejected', error: String(error.message).slice(0, 200)
      });
    }
  }
  out[snapshotName] = { snapshot_info: { overrides }, task_runs: taskRuns };
}
const targetPath = process.env.FM_REPLAY_OUT ||
  path.join(HERE, `c9_${process.argv[2] || 'run'}_full_pool_replay.json`);
fs.writeFileSync(targetPath, JSON.stringify(out, null, 1));
console.log('wrote', targetPath, 'tasks', TASK_TASK_SET.length);
