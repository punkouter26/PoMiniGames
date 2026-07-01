# PoMiniGames Documentation Suite

The documentation set in this directory is now aligned with [AGENT.MD](../AGENT.MD) and organised as a compact, machine-readable architecture package. Each Mermaid source has a simplified companion for fast stakeholder review.

## Core documents
- [PRD_Master.md](./PRD_Master.md) — product and implementation contract for the vertical-slice architecture.

## Architecture and flow diagrams
- [Architecture_VSA_Blueprint.mmd](./Architecture_VSA_Blueprint.mmd) and [Architecture_VSA_Blueprint_simplified.mmd](./Architecture_VSA_Blueprint_simplified.mmd)
- [Interaction_Trace.mmd](./Interaction_Trace.mmd) and [Interaction_Trace_simplified.mmd](./Interaction_Trace_simplified.mmd)
- [DatabaseSchema.mmd](./DatabaseSchema.mmd) and [DatabaseSchema_simplified.mmd](./DatabaseSchema_simplified.mmd)
- [User_Journey.mmd](./User_Journey.mmd) and [User_Journey_simplified.mmd](./User_Journey_simplified.mmd)
- [UI_Screen_Matrix.mmd](./UI_Screen_Matrix.mmd) and [UI_Screen_Matrix_simplified.mmd](./UI_Screen_Matrix_simplified.mmd)
- [Flow_Identity_BFF.mmd](./Flow_Identity_BFF.mmd) and [Flow_Identity_BFF_simplified.mmd](./Flow_Identity_BFF_simplified.mmd)
- [Flow_Validation_Failures.mmd](./Flow_Validation_Failures.mmd) and [Flow_Validation_Failures_simplified.mmd](./Flow_Validation_Failures_simplified.mmd)
- [Flow_RealTime_Lobby.mmd](./Flow_RealTime_Lobby.mmd) and [Flow_RealTime_Lobby_simplified.mmd](./Flow_RealTime_Lobby_simplified.mmd)

## Rendering
Render any diagram with:

```bash
npx @mermaid-js/mermaid-cli -i <file>.mmd -o <file>.svg -t dark
```

The older planning-only markdown assets in this folder have been removed to keep the directory focused on the current architecture and runtime flows.
