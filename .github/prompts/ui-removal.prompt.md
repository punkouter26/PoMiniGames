---
description: Remove or simplify PoMiniGames UI without disturbing nearby behavior.
---

# UI Removal

Remove the requested visible UI affordance while preserving intended navigation and game behavior.

Start by identifying:

- Visible text or icon requested for removal
- Route or game page where it appears
- Owning Blazor component, usually under `src/PoMiniGames.Client`
- Any event handlers, services, CSS, or tests coupled only to that UI

Edit rules:

- Remove dead handlers and CSS that become unused because of the deleted UI.
- Preserve alternate navigation paths, especially the PoMiniGames brand/home link.
- Keep mobile layout stable; do not introduce a second nav row unless explicitly requested.
- Validate with a focused client build or a browser check when the runtime is already available.

Final response should name the removed UI, the component changed, and the validation performed.