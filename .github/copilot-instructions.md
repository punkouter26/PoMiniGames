# Copilot Instructions

Read [AGENT.MD](../AGENT.MD) before making repository changes. It is the authoritative project guide for architecture, local run behavior, branch policy, testing, auth, and deployment.

Keep these high-friction habits in mind for this repo:

- Work on `master` unless the user explicitly says otherwise. Delete feature branches after merge.
- The app is a same-origin ASP.NET Core host serving Blazor WebAssembly; do not start a separate frontend server.
- Local runtime uses port `5000` and Azurite. Prefer the Docker Azurite container, but if Docker/WSL is broken on this Windows machine, use the existing local Azurite fallback only after reporting the reason.
- For broad QA requests, run one named phase at a time, report findings, and stop before widening scope unless the user asked for full remediation.
- For UI removal requests, identify the visible label, route, and owning component before editing. Preserve existing navigation affordances unless the user explicitly asks to remove them.
- Avoid asking the user to paste large terminal or browser transcripts when the same state can be recovered from files, terminal output, app endpoints, or a browser session.