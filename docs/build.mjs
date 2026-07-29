#!/usr/bin/env node
// DOCS/build.mjs — assembles self-contained HTML reports for PoMiniGames.
//
// What this does:
//   1. Reads each DOCS/_src/pages/<name>.html
//   2. Replaces <!--@MARKER--> placeholders with inlined content:
//        @STYLE            → inlined DOCS/_src/partials/theme.css
//        @SHELL            → inlined DOCS/_src/partials/shell.js
//        @SVG:<name>       → inlined DOCS/_src/diagrams/<name>.svg
//        @RAIL:<file>      → inlined raw text file from DOCS/_src/rails/<file>
//        @HISTORY          → inlined DOCS/diagnostic_history.json (or a labelled
//                            gap marker if the file is absent)
//   3. Writes each rendered page to DOCS/<name>.html (root-level sibling to _src/)
//   4. Optionally invokes `mmdc` (Mermaid CLI) on any DOCS/_src/diagrams/*.mmd
//      sources to refresh the corresponding .svg. Skipped with --no-mmd or
//      when mmdc is not installed — pre-stored .svg files then remain in place.
//
// Constraints honored (per the original NET_DOCS contract):
//   • No CDN for Chart.js, Mermaid, fonts, or CSS.
//   • Two themes (dark default, light via data-theme="light").
//   • Self-contained — every asset is inlined; safe over file://.
//
// Usage:
//   node DOCS/build.mjs             # build all (will run mmdc if present)
//   node DOCS/build.mjs --no-mmd    # build without invoking mmdc

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = __dirname;
const PAGES_DIR  = path.join(ROOT, '_src', 'pages');
const DIAGRAMS   = path.join(ROOT, '_src', 'diagrams');
const RAILS_DIR  = path.join(ROOT, '_src', 'rails');
const HISTORY    = path.join(ROOT, 'diagnostic_history.json');
const HISTORY_GAP = path.join(ROOT, 'diagnostic_history.GAP.json');

const argv = process.argv.slice(2);
const NO_MMD = argv.includes('--no-mmd');

function log(...args) { console.log('[build]', ...args); }

async function readText(p) {
  return await readFile(p, 'utf8');
}

async function safeReadText(p) {
  try { return await readText(p); } catch { return null; }
}

async function listHtml(dir) {
  const out = [];
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith('.html')) continue;
    out.push(path.join(dir, entry));
  }
  return out.sort();
}

function replaceAll(haystack, needle, replacement) {
  if (haystack.indexOf(needle) === -1) return haystack;
  return haystack.split(needle).join(replacement);
}

// Mermaid CLI is optional; we only invoke it when explicitly available AND not in --no-mmd mode.
async function tryCompileMermaid() {
  if (NO_MMD) { log('--no-mmd: skipping Mermaid compilation'); return; }
  let probe;
  try { probe = spawnSync('mmdc', ['--version'], { stdio: 'ignore' }); }
  catch { probe = null; }
  if (!probe || probe.status !== 0) {
    log('mmdc not on PATH (or non-zero exit); using pre-stored .svg diagrams');
    return;
  }
  const files = (await readdir(DIAGRAMS)).filter((f) => f.endsWith('.mmd'));
  if (files.length === 0) return;
  log(`compiling ${files.length} Mermaid diagram(s)`);
  for (const f of files) {
    const src = path.join(DIAGRAMS, f);
    const dst = path.join(DIAGRAMS, f.replace(/\.mmd$/, '.svg'));
    const r = spawnSync('mmdc', ['-i', src, '-o', dst, '-b', 'transparent'], { stdio: 'inherit' });
    if (r.status !== 0) {
      log(`  ! ${f} → exit ${r.status}; leaving existing .svg if any`);
    }
  }
}

async function expandPlaceholders(html) {
  // @STYLE — inline theme.css
  const style = await safeReadText(path.join(ROOT, '_src', 'partials', 'theme.css'));
  if (style !== null) {
    html = replaceAll(html, '<!--@STYLE-->', `<style>${style}</style>`);
  } else {
    html = replaceAll(html, '<!--@STYLE-->', '<style>/* theme.css missing */</style>');
  }

  // @SHELL — inline shell.js
  const shell = await safeReadText(path.join(ROOT, '_src', 'partials', 'shell.js'));
  if (shell !== null) {
    html = replaceAll(html, '<!--@SHELL-->', `<script>${shell}</script>`);
  } else {
    html = replaceAll(html, '<!--@SHELL-->', '<script>/* shell.js missing */</script>');
  }

  // @SVG:<name> — inline diagram SVG
  html = html.replace(/<!--@SVG:([a-zA-Z0-9_-]+)-->/g, (m, name) => {
    const p = path.join(DIAGRAMS, `${name}.svg`);
    return existsSync(p)
      ? readFileSyncSafe(p)
      : `<!-- diagram "${name}" missing at ${p} -->`;
  });

  // @RAIL:<file> — inline raw file from _src/rails/<file>
  html = html.replace(/<!--@RAIL:([a-zA-Z0-9_.\-\/]+)-->/g, (m, file) => {
    const p = path.join(RAILS_DIR, file);
    return existsSync(p)
      ? readFileSyncSafe(p)
      : `<!-- rail "${file}" missing at ${p} -->`;
  });

  // @HISTORY — inline diagnostic_history.json (or labelled gap if absent)
  if (existsSync(HISTORY)) {
    const text = await readText(HISTORY);
    html = replaceAll(html, '<!--@HISTORY-->', `<script type="application/json" id="diagnostic-history">${text}</script>`);
  } else if (existsSync(HISTORY_GAP)) {
    const text = await readText(HISTORY_GAP);
    html = replaceAll(html, '<!--@HISTORY-->', `<script type="application/json" id="diagnostic-history">${text}</script>`);
  } else {
    const gap = JSON.stringify({
      _gap: true,
      reason: 'diagnostic_history.json not found. Run scripts/collect-vitals.mjs to populate; in the meantime, no synthetic numbers are fabricated.',
      samples: [],
      collectedAtUtc: null
    }, null, 2);
    html = replaceAll(html, '<!--@HISTORY-->', `<script type="application/json" id="diagnostic-history">${gap}</script>`);
  }

  return html;
}

function readFileSyncSafe(p) {
  // sync read used inside the SVG/RAIL replace callbacks (small files only).
  return readFileSync(p, 'utf8');
}

async function buildPage(srcPath) {
  const baseName = path.basename(srcPath, '.html');
  const raw = await readText(srcPath);
  const out = await expandPlaceholders(raw);
  const target = path.join(ROOT, `${baseName}.html`);
  await writeFile(target, out, 'utf8');
  const s = await stat(target);
  log(`  ✓ ${path.relative(process.cwd(), target)}  (${(s.size / 1024).toFixed(1)} KB)`);
}

async function buildIndex() {
  // Build a small index page that lists every report.
  const pages = (await readdir(PAGES_DIR)).filter((f) => f.endsWith('.html')).sort();
  const items = pages.map((p) => {
    const base = path.basename(p, '.html');
    const title = base.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return `<a class="tile" href="${base}.html"><div class="num">${base}</div><div class="name">${title}</div><div class="desc">${descFor(base)}</div></a>`;
  }).join('\n');

  const indexHtml = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PoMiniGames — DOCS</title>
<!--@STYLE-->
</head>
<body>
<div class="shell">
  <header class="top">
    <div class="brand"><span class="dot"></span>PoMiniGames · DOCS</div>
    <div class="crumbs">v1 · built ${new Date().toISOString().slice(0,19)}Z</div>
    <div class="spacer"></div>
    <button class="toggle" aria-label="toggle theme">◑ dark</button>
  </header>
  <main>
    <h1>PoMiniGames — self-contained report suite</h1>
    <p class="muted">Eight reports auditing the real source in <code>src/PoMiniGames</code>. Every asset is inlined; the files open over <code>file://</code> with no network. Source: <code>DOCS/_src/</code>. Build: <code>node DOCS/build.mjs --no-mmd</code>.</p>
    <hr>
    <div class="nav">${items}</div>
    <hr>
    <h2>Findings surfaced across the suite</h2>
    <ul>
      <li><strong>Unit tier at the ceiling:</strong> 100 methods (excluding the guard); the structural test passes only because the guard is excluded from its own count.</li>
      <li><strong>No Anthropic:</strong> the only AI provider is the central Azure AI Foundry hub. There is no Anthropic integration anywhere in <code>src/</code>.</li>
      <li><strong>No per-token pricing configured:</strong> cost projections are explicitly labelled as assumptions against assumed volumes, not derived from per-token prices.</li>
      <li><strong>No role checks:</strong> the auth engine has one <code>IsInRole("guest")</code> lookup in <code>RequestIdentity</code>; every other authorization decision is "authenticated vs anonymous". The role columns in the matrix collapse.</li>
      <li><strong>Diagnostic pipeline absent:</strong> <code>DOCS/collect-vitals.mjs</code> is not present in this workspace; the DIAGNOSTIC_METRICS report shows the gap, not invented numbers.</li>
      <li><strong>Orphan rate-limit policy:</strong> <code>face-analysis</code> is declared in <code>RateLimitingExtensions</code> but never bound to any endpoint.</li>
      <li><strong>PoFace is a no-op:</strong> <code>GameKey.Face = "face"</code> and an <code>AIFoundryOptions.Deployments.Face</code> key exist, but there is no <code>Features/PoFace/</code> folder, no <code>IFaceAnalysisService</code> implementation, and no <code>/api/face/*</code> endpoints in the current tree.</li>
    </ul>
  </main>
  <footer>
    <div>PoMiniGames DOCS · self-contained · dark/light themes · no CDN</div>
    <div class="build">build: ${new Date().toISOString()}</div>
  </footer>
</div>
<!--@SHELL-->
</body>
</html>`;
  const expanded = await expandPlaceholders(indexHtml);
  const target = path.join(ROOT, 'index.html');
  await writeFile(target, expanded, 'utf8');
  log(`  ✓ ${path.relative(process.cwd(), target)}  (index)`);
}

function descFor(base) {
  return ({
    'ai-services': 'AI providers, service matrix, capabilities matrix, cost projection',
    'architecture': 'C4 containers, slice × MapGroup matrix, middleware order, request sequence',
    'slice-isolation': 'ProjectReference graph, layer-leak verdicts, shared DTO surface',
    'auth-lifecycle': 'Auth engine switch, BFF handshake, 401-not-302, X-Reauth: 1, WASM boot mask',
    'diagnostic-metrics': 'interactiveMs / CLS / WASM memory — separate charts, inventory of instrumentation',
    'testing-tier-hierarchy': 'Real counts vs the 100/50/25/25 ceilings, dotnet test --filter matrix',
    'roles-permissions-matrix': 'Verdict-driven principal × environment grid; role columns collapse',
    'user-workflow': 'UI submit → SignalR hub → orchestrator → Azure Tables; failure surfaces',
  })[base] || '—';
}

(async () => {
  log('starting build');
  await tryCompileMermaid();
  log('compiling index + pages');
  await buildIndex();
  for (const p of await listHtml(PAGES_DIR)) {
    await buildPage(p);
  }
  log('done');
})().catch((err) => {
  console.error('[build] FAILED:', err && err.stack || err);
  process.exit(1);
});