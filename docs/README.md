# PoMiniGames — DOCS report suite

Eight self-contained HTML reports auditing the real source in `src/PoMiniGames/...`. Every asset is inlined — no CDN for Chart.js, Mermaid, fonts or CSS — so the files open safely over `file://`.

## Layout

```
DOCS/
├── README.md                    # this file
├── build.mjs                    # assembles DOCS/*.html from _src/pages/*.html
├── _src/
│   ├── partials/
│   │   ├── theme.css            # tokens + .card / .tiles / .chip / .sec + Okabe-Ito palette
│   │   └── shell.js             # theme toggle + inline SVG chart helpers (no Chart.js)
│   ├── diagrams/                # hand-authored SVG (Mermaid output is one possible source)
│   └── pages/                   # one .html per report, with <!--@MARKER--> placeholders
└── *.html                       # build output (do not edit by hand)
```

## Markers supported by `build.mjs`

| Marker | What it expands to |
| --- | --- |
| `<!--@STYLE-->` | Inlined `_src/partials/theme.css` |
| `<!--@SHELL-->` | Inlined `_src/partials/shell.js` |
| `<!--@SVG:name-->` | Inlined `_src/diagrams/<name>.svg` |
| `<!--@RAIL:file-->` | Inlined `_src/rails/<file>` raw text (for code excerpts) |
| `<!--@HISTORY-->` | Inlined `diagnostic_history.json` if present; otherwise a labelled gap marker |

## Build

```
node DOCS/build.mjs --no-mmd   # offline; uses pre-stored SVGs only
node DOCS/build.mjs            # also runs `mmdc` on any *.mmd in _src/diagrams/ if installed
```

## Themes

Dark by default. Toggle in the top-right persists per browser via `localStorage`. Tokens are CSS variables on `:root` and `:root[data-theme="light"]` — every chart picks them up automatically.

## Report contract

Every report is grounded in real source paths in `src/PoMiniGames/...`. Invented numbers are never used; gaps are surfaced as findings.

| Report | Source audit |
| --- | --- |
| `ai-services.html` | `src/PoMiniGames/Features/*/*.cs`, `Infrastructure/GameServicesExtensions.cs`, `AI/AIFoundryOptions.cs` |
| `architecture.html` | `Program.cs`, `Infrastructure/EndpointRouteExtensions.cs`, `Features/*/*Endpoints.cs` |
| `slice-isolation.html` | `*.csproj` `ProjectReference`s, layer-leak heuristics |
| `auth-lifecycle.html` | `Features/Auth/`, `Infrastructure/AuthExtensions.cs`, `DataProtectionExtensions.cs`, `Client/Services/AuthStateService.cs` |
| `diagnostic-metrics.html` | `Features/Diagnostics/*`, `ConfigurationDiagnosticsSnapshotProvider.cs`, `TelemetryExtensions.cs` |
| `testing-tier-hierarchy.html` | `tests/*TestCountCeilingTests.cs`, `scripts/_count-tests.ps1` |
| `roles-permissions-matrix.html` | grep across `src/` for `RequireRole`, `[Authorize(Roles=…)]`, `IsInRole` |
| `user-workflow.html` | `Features/PoCoupleQuiz/`, `Features/PoFunQuiz/`, `Features/MatchHistory/`, `Infrastructure/Services/StorageService.cs` |

## If `collect-vitals.mjs` is missing

The DIAGNOSTIC_METRICS report reads `DOCS/diagnostic_history.json` via `<!--@HISTORY-->`. If that JSON is absent (this workspace), the build emits a labelled gap token and the page shows:

- Three empty charts (interactiveMs, CLS, WASM memory) with a clear "no samples" badge.
- A live inventory of what the app *does* instrument (`/api/diag`, `/api/diag/telemetry`, `/api/health`, `/api/mockables`, `/api/logs/tail`) — all configuration/status, no client-runtime TTFB/CLS/JS-heap.

The pipeline is **not** rebuilt from scratch. To populate it, write a `DOCS/collect-vitals.mjs` that:

1. Starts Azurite + the API host if they aren't already up (idempotent).
2. Navigates to representative routes with Playwright, recording `performance.now()` deltas around the `load` event, the WASM `interactiveMs` baseline (e.g. the time the Blazor runtime raises `enhancedload` or the first `render` of the root component), CLS via `PerformanceObserver`, and `performance.memory.usedJSHeapSize` snapshots every 250 ms.
3. Appends samples to `DOCS/diagnostic_history.json` with `runs >= 8` per prompt Step 0.

Until that script exists, the report is honest about its absence.