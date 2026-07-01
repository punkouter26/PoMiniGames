---
description: Run a bounded PoMiniGames QA or engineering analysis phase.
---

# Bounded QA Phase

Act as a senior .NET engineer for one bounded phase only. Do not turn this into a full audit unless the user explicitly asks.

Before acting:

1. Read [AGENT.MD](../../AGENT.MD) for repo rules.
2. Name the phase you are executing, such as build verification, API smoke, auth flow, UI layout, or targeted bug fix.
3. State the cheapest check that could disconfirm your current hypothesis.

During the phase:

- Prefer narrow checks over whole-repo sweeps.
- If editing, make the smallest local change and immediately run the focused validation.
- Stop and report before widening to a second phase unless the user requested full remediation.
- For test guidance, remember CI is build-only and local tests run through `scripts/test-all.ps1` when a full tiered run is needed.

Final response format:

- Phase executed
- Result
- Files changed, if any
- Validation command and outcome
- Next recommended phase, if useful