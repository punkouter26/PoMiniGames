# ADR 0001 — Radzen Blazor components are rejected by design

**Status:** Accepted · **Date:** 2026-07-07

## Context

PoMiniGames is a mobile-first .NET 10 Blazor WASM app with a hard
zero-waste / performance-first footprint mandate. Radzen.Blazor is periodically
suggested as a way to get "advanced" data grids, charts, and inputs for free.

An earlier iteration *did* use `RadzenDataGrid` on the PoJoker leaderboard. It was
removed (see `Games/PoJoker/PoJokerLeaderboardPage.razor`) because pulling in a
single Radzen component drags in the entire Radzen JS + CSS bundle (~1.2 MB) into
a WASM payload where every KB is paid for on first load, on every device.

## Decision

**We do not take a dependency on Radzen.Blazor.** Data-heavy surfaces use the
framework-native `<Virtualize>` component (already in use on every leaderboard,
the profile head-to-head table, and the home high-scores block, each with an
explicit `ItemSize`). Visual chrome (glassmorphism, tokens, motion, WebGL
ambient field) is hand-authored against the design-token system in
`wwwroot/css/app.css`.

This intentionally overrides any blanket instruction to "use the most advanced
Radzen controls" — the footprint cost is not justified for this app.

## Consequences

- No 1.2 MB third-party UI bundle; first paint stays gated on `app.css` alone.
- We own the styling surface — consistency is enforced via CSS custom properties,
  not a vendor theme.
- If a genuinely grid-heavy admin surface ever appears, the escape hatch is to
  lazy-load **only** the specific Radzen assembly on that one route — never a
  global registration.

## Revisit if

A future feature needs true spreadsheet-grade grids (column virtualization +
grouping + inline edit) that would cost more to hand-build than the bundle weight.
Until then: closed.
