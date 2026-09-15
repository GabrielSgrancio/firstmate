import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_HOME = path.join(HERE, 'fixtures', 'router-v2');

export function makeRouterFixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-v2-fixture-'));
  fs.cpSync(SOURCE_HOME, home, { recursive: true });
  const learnedPath = path.join(home, 'data', 'learned-routing.json');
  const routesPath = path.join(home, 'data', 'provider-catalogs', 'compiled-route-targets.json');
  const legacy = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
  const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
  const taskByRole = {
    fast_precise: 'targeted_edit',
    cheap_tool_worker: 'mechanical_tool_work',
    strong_cheap_worker: 'test_generation',
    general_engineer: 'refactor',
    fast_context: 'large_context_repository_retrieval',
    deep_context: 'large_context_repository_retrieval',
    autonomous_engineer: 'multi_file_feature',
    deep_engineer: 'brownfield_debugging',
    architect_synthesizer: 'architecture_reasoning',
    critical_auditor: 'critical_audit'
  };
  const learned = { version: 4, route_capabilities: {}, model_family_priors: {} };
  for (const [role, candidates] of Object.entries(legacy.role_statistics)) {
    const taskClass = taskByRole[role];
    for (const [selector, prior] of Object.entries(candidates)) {
      const matches = routes.filter((route) => route.route_id === selector ||
        route.model_family === selector || route.resolved_runtime_model === selector);
      for (const route of matches) {
        const bucket = learned.route_capabilities[route.route_id] || {
          route: route.route_id,
          route_id: route.route_id,
          model_family: route.model_family,
          harness: route.harness,
          capabilities: {}
        };
        bucket.capabilities[taskClass] = {
          route_id: route.route_id,
          task_class: taskClass,
          role,
          model_family: route.model_family,
          model: route.model_family,
          harness: route.harness,
          provider: route.provider_path,
          real_n: 15,
          real_successes: 15,
          deterministic_evaluations: taskClass === 'architecture_reasoning' ? 0 : 15,
          deterministic_failures: 0,
          prior_mean: prior.prior_mean ?? prior.posterior_mean ?? 0.5,
          prior_effective_n: prior.prior_effective_n ?? 0,
          posterior_mean: prior.posterior_mean ?? 0.5,
          promotion_eligible_real_n: true,
          routing_status: 'ROUTING_ELIGIBLE',
          uncertainty: {
            method: 'binomial_standard_error',
            real_n: 15,
            effective_n: prior.prior_effective_n ?? 0,
            standard_error: 0,
            status: 'measured'
          }
        };
        learned.route_capabilities[route.route_id] = bucket;
      }
    }
  }
  fs.writeFileSync(learnedPath, `${JSON.stringify(learned, null, 2)}\n`);
  process.env.FM_HOME = home;
  process.env.FM_DISABLE_LIVE_QUOTA = '1';
  return home;
}
