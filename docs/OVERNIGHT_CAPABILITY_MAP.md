# Overnight Capability Map

This document summarizes the capability-level reconciliation in [`data/overnight-capability-map/report.md`](../data/overnight-capability-map/report.md).

The overnight branch is a historical stack and should not be cherry-picked commit-by-commit.

The next phase should canonicalize the connected Router V2 chain first, then adapt adjacent front-door and recovery capabilities around current FirstMate owners.

| Capability | Source commits | Current main | Reconciliation refs | Private data dependency | Verdict |
| --- | --- | --- | --- | --- | --- |
| Router V2 | `e4499f26`, `3369c603`, `613dbde3`, `ef2e8b03`, `2c468734`, `5644821f` | Absent | None | Registry, policy, priors, data policy, quota map, learned routing, compiled targets, telemetry | REBUILD |
| Provider discovery | `613dbde3`, `ef2e8b03`, `2c468734` | Absent | None | Provider snapshots and compiled RouteTargets | ADAPT |
| Quota truth and normalization | `613dbde3`, `ef2e8b03`, `2c468734`, `5644821f` | `quota-axi` compatibility only | None | Quota pool map and OpenCode snapshot | ADAPT |
| OpenCode economics | `b6202a5a`, `613dbde3`, `ef2e8b03`, `2c468734` | Native OpenCode harness exists, economics absent | None | OpenCode auth, usage endpoint, shared pool map | ADAPT |
| Router to Herdr | `3369c603`, `613dbde3`, `ef2e8b03`, `2c468734`, `5644821f` | Herdr/spawn seam exists, router caller absent | None | All Router V2 inputs and telemetry | REBUILD |
| Orchestrator API | `9186aac1`, `c270d22e` | Underlying primitives exist, API absent | None | Dispatch inherits Router V2 inputs | ADAPT |
| Gabriel/FirstMate TUI | `9186aac1`, `d2e3268e`, `2b47aeb8`, `c270d22e` | Absent | None | Chat history and Gabriel OS/OpenClaw paths | ADAPT |
| `gabriel` launcher/doctor | `d2e3268e`, `5644821f`, `c270d22e` | Absent | None | Gabriel OS/OpenClaw paths | ADAPT |
| Worker quota failover | `5644821f`, `c270d22e` | Host/supervisor recovery only | None | Task metadata, lease, checkpoint, Router V2 inputs | REBUILD |
| Mission/session/harness | `5644821f`, `b6202a5a`, `d2e3268e`, `c270d22e` | Mission capsule and harness contracts already canonical | Supervisor-continuity lineage | Mission state only | KEEP |
| Context compiler/handoff | `d7f254b0`, `9186aac1`, `c270d22e` | Absent | None | Brief, research decision, handoff, context deltas | ADAPT |
| Research gate/preflight | `d7f254b0`, `9186aac1`, `c270d22e` | Absent | None | Brief and research decision | ADAPT |
| Host checkpoint/resume | `d7f254b0`, `5644821f`, `c270d22e` | Present with `FM_HOME` fixes | Current continuity lineage | Host checkpoint and quota snapshot | KEEP |
| Security fixes | `9186aac1`, `3369c603`, `5644821f`, `c270d22e` | Landed | `reconcile/security-fixes` | None unique | KEEP |
| Architecture/research docs | `d7f254b0`, `9186aac1`, `2b47aeb8`, `e4499f26`, `c270d22e` | Partial and owner-split | Sprint/stale-base/supervisor refs | External research sources | ADAPT |
| Second-brain archaeology | `2b47aeb8`, `c270d22e` | No FirstMate implementation | None | External Gabriel OS data | ARCHIVE |
| AGY Stop-hook adapter | `d7f254b0`, `c270d22e` | Generic AGY adapter exists | None | No Router V2 file | ADAPT |
| OpenClaw/TUI/token evidence | `9186aac1`, `d2e3268e`, `b6202a5a` | Partial harness support | None | Harness auth and external workspace | ARCHIVE |
| Governed Gateway/front-door boundary | `c270d22e` plus adjacent Gabriel OS repair refs | FirstMate primitives exist, cross-project contract not canonical | No FirstMate extraction | Gabriel OS Gateway/OpenClaw and explicit data class | ADAPT |

## Validation headline

The integration oracle passed OpenCode Go acceptance, the eight-verb API, research/delegation gates, host resilience, supervisor continuity, and TUI chat/persistence.

Router enforcement, Herdr dispatch, dynamic discovery, and worker failover remained incomplete because the private routing/catalog files were absent.

The exact missing-file list was:

`config/model-registry.json`, `config/routing-policy.json`, `config/routing-priors.json`, `config/crew-dispatch.json`, `config/data-policy.json`, `data/learned-routing.json`, `data/quota-pool-map.json`, `data/provider-catalogs/codex.json`, and `data/routing-executions.jsonl`.

See the report for the inferred schemas, source line references, security findings, and the recommended canonicalization order.
