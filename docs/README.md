# PoMiniGames — Documentation Index

**Single source of truth:** [`/AGENT.MD`](../AGENT.MD) at the repository root.
It describes the *live* architecture, build/run flow, auth model, and conventions.
When any document below disagrees with `AGENT.MD`, **`AGENT.MD` wins** — the others
are point-in-time analysis and may have drifted.

## Authoritative
| Doc | Scope |
| --- | --- |
| [`/AGENT.MD`](../AGENT.MD) | Architecture, build/run, auth, data, observability, conventions. Kept current. |
| [`/README.md`](../README.md) | Public overview + the diagram catalogue (links into the `.mmd` files below). |

## Historical / point-in-time (not authoritative — read with a date in mind)
| Doc | Captured | Nature |
| --- | --- | --- |
| [Project_Architecture_Blueprint.md](./Project_Architecture_Blueprint.md) | 2026-04-27 | Generated architecture snapshot. |
| [RefactorAnalysis.md](./RefactorAnalysis.md) | — | Dependency blast-radius analysis (derived from `ServiceMap_MASTER.mmd`). |
| [DEPLOYMENT_OPTIMIZATION.md](./DEPLOYMENT_OPTIMIZATION.md) | — | Cost / resource-utilization strategies. |
| [qa-fixes-runbook.md](./qa-fixes-runbook.md) | — | Runbook for QA items needing external Azure resources. |

## Diagrams (`.mmd`)
Each diagram ships in a full (`*_MASTER.mmd` / base name) and a `*_SIMPLE.mmd`
reduced variant. The full variant is canonical; `_SIMPLE` is a presentation aid.
See the catalogue table in [`/README.md`](../README.md) for what each one covers.
