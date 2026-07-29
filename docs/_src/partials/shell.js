/* DOCS/_src/partials/shell.js — minimal vanilla JS used across all DOCS/*.html pages.
   - Persists theme choice in localStorage (key: pominigames-docs-theme).
   - Renders inline SVG charts (no Chart.js, no CDN).
   - No other behaviour. */

(function () {
  "use strict";

  // ── Theme ──────────────────────────────────────────────────────────────
  const html = document.documentElement;
  const stored = (() => {
    try { return localStorage.getItem("pominigames-docs-theme"); }
    catch (e) { return null; }
  })();
  if (stored === "light" || stored === "dark") {
    html.setAttribute("data-theme", stored);
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("button.toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = html.getAttribute("data-theme") === "light" ? "dark" : "light";
        html.setAttribute("data-theme", next);
        try { localStorage.setItem("pominigames-docs-theme", next); } catch (e) { /* ignore */ }
        btn.textContent = next === "light" ? "◐ light" : "◑ dark";
        document.dispatchEvent(new CustomEvent("docs:themechange", { detail: { theme: next } }));
      });
      btn.textContent = html.getAttribute("data-theme") === "light" ? "◐ light" : "◑ dark";
    });

    // Auto-render any <div data-chart="line|bar|hbar" data-src="#id"> ... </div>
    document.querySelectorAll("[data-chart]").forEach((el) => renderChart(el));
  });

  // ── Chart palette (Okabe-Ito, 8 colors) ────────────────────────────────
  const PALETTE = ["#0072B2", "#E69F00", "#009E73", "#CC79A7", "#56B4E9", "#D55E00", "#F0E442", "#111827"];

  function getCss(name) {
    return getComputedStyle(html).getPropertyValue(name).trim();
  }

  function fmtNum(v) {
    if (v == null || Number.isNaN(v)) return "";
    const abs = Math.abs(v);
    if (abs >= 1e9) return (v / 1e9).toFixed(1) + "B";
    if (abs >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (abs >= 1e3) return (v / 1e3).toFixed(1) + "k";
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(2);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  }

  // ── Public chart API ───────────────────────────────────────────────────
  function renderChart(el) {
    const kind = el.getAttribute("data-chart");
    const srcId = el.getAttribute("data-src");
    if (!srcId) return;
    const dataEl = document.querySelector(srcId);
    if (!dataEl) return;
    let payload;
    try { payload = JSON.parse(dataEl.textContent); }
    catch (e) { el.innerHTML = "<p class='faint'>chart parse error</p>"; return; }

    if (kind === "line")   return renderLineChart(el, payload);
    if (kind === "bar")    return renderBarChart(el, payload);
    if (kind === "hbar")   return renderHBarChart(el, payload);
    if (kind === "pie")    return renderPieChart(el, payload);
    if (kind === "stacked")return renderStackedChart(el, payload);
  }

  // ── Line chart (multiple series, shared x-axis) ────────────────────────
  function renderLineChart(el, p) {
    const W = 720, H = 260, PAD = { l: 48, r: 16, t: 16, b: 36 };
    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;
    const xLabels = p.x || [];
    const series = p.series || [];
    const yMin = p.yMin != null ? p.yMin : Math.min(...series.flatMap((s) => s.values));
    const yMax = p.yMax != null ? p.yMax : Math.max(...series.flatMap((s) => s.values));
    const yPad = (yMax - yMin) * 0.08 || 1;
    const lo = yMin - yPad, hi = yMax + yPad;
    const sx = (i) => PAD.l + (xLabels.length <= 1 ? innerW / 2 : (i * innerW) / (xLabels.length - 1));
    const sy = (v) => PAD.t + innerH - ((v - lo) / (hi - lo)) * innerH;

    let g = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(p.title || "line chart")}">`;

    // Grid + y-axis
    g += `<g class="grid">`;
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const y = PAD.t + (i * innerH) / ticks;
      const v = hi - (i * (hi - lo)) / ticks;
      g += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}" />`;
      g += `<text class="axis" x="${PAD.l - 6}" y="${y + 3}" text-anchor="end">${escapeHtml(fmtNum(v))}</text>`;
    }
    g += `</g>`;

    // X-axis labels
    g += `<g class="axis">`;
    xLabels.forEach((label, i) => {
      const x = sx(i);
      const text = String(label).length > 14 ? String(label).slice(0, 12) + "…" : String(label);
      g += `<text x="${x}" y="${H - 14}" text-anchor="middle">${escapeHtml(text)}</text>`;
    });
    g += `</g>`;

    // Series
    series.forEach((s, idx) => {
      const color = s.color || PALETTE[idx % PALETTE.length];
      let d = "";
      s.values.forEach((v, i) => { d += (i === 0 ? "M" : "L") + sx(i) + "," + sy(v) + " "; });
      g += `<g class="series"><path class="line" d="${d}" stroke="${color}" /></g>`;
      g += `<g class="series">`;
      s.values.forEach((v, i) => {
        g += `<circle class="pt" cx="${sx(i)}" cy="${sy(v)}" r="3.2" fill="${color}" />`;
      });
      g += `</g>`;
    });

    g += `</svg>`;

    // Legend
    const legend = (series.map((s, idx) => {
      const color = s.color || PALETTE[idx % PALETTE.length];
      return `<span><i class="swatch" style="background:${color}"></i>${escapeHtml(s.name)}</span>`;
    })).join("");

    el.innerHTML = `${g}<div class="legend">${legend}</div>`;
  }

  // ── Vertical bar chart (one series) ───────────────────────────────────
  function renderBarChart(el, p) {
    const W = 720, H = 240, PAD = { l: 48, r: 16, t: 16, b: 36 };
    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;
    const data = p.data || [];
    const max = Math.max(...data.map((d) => d.value), 1);
    const bw = innerW / data.length * 0.7;
    let g = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(p.title || "bar chart")}">`;
    g += `<g class="grid">`;
    for (let i = 0; i <= 4; i++) {
      const y = PAD.t + (i * innerH) / 4;
      const v = max - (i * max) / 4;
      g += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}" />`;
      g += `<text class="axis" x="${PAD.l - 6}" y="${y + 3}" text-anchor="end">${escapeHtml(fmtNum(v))}</text>`;
    }
    g += `</g>`;
    data.forEach((d, i) => {
      const x = PAD.l + ((i + 0.5) * innerW) / data.length - bw / 2;
      const h = (d.value / max) * innerH;
      const y = PAD.t + innerH - h;
      const cls = d.warn ? "warn" : (d.alt ? "alt" : "");
      g += `<rect class="bar ${cls}" x="${x}" y="${y}" width="${bw}" height="${h}" />`;
      g += `<text class="axis" x="${x + bw / 2}" y="${H - 14}" text-anchor="middle">${escapeHtml(d.label)}</text>`;
      if (d.valueLabel) {
        g += `<text class="axis" x="${x + bw / 2}" y="${y - 4}" text-anchor="middle">${escapeHtml(d.valueLabel)}</text>`;
      }
    });
    g += `</svg>`;
    el.innerHTML = g + (p.note ? `<div class="legend"><span class="muted">${escapeHtml(p.note)}</span></div>` : "");
  }

  // ── Horizontal bar chart (for tier counts) ────────────────────────────
  function renderHBarChart(el, p) {
    const data = p.data || [];
    const max = Math.max(...data.map((d) => d.value), 1);
    const W = 720;
    const ROW = 26, GAP = 8;
    const LABEL = 180, VALUE = 60;
    const innerW = W - LABEL - VALUE - 16;
    const H = 32 + data.length * (ROW + GAP);
    let g = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(p.title || "hbar chart")}">`;
    data.forEach((d, i) => {
      const y = 16 + i * (ROW + GAP);
      const w = (d.value / max) * innerW;
      const color = d.color || PALETTE[i % PALETTE.length];
      g += `<text class="axis" x="0" y="${y + ROW * 0.65}">${escapeHtml(d.label)}</text>`;
      g += `<rect class="bar" x="${LABEL}" y="${y}" width="${w}" height="${ROW}" fill="${color}" />`;
      g += `<text class="axis" x="${LABEL + w + 6}" y="${y + ROW * 0.65}">${escapeHtml(fmtNum(d.value))}${d.secondary ? " / " + fmtNum(d.secondary) : ""}</text>`;
    });
    g += `</svg>`;
    el.innerHTML = g + (p.note ? `<div class="legend"><span class="muted">${escapeHtml(p.note)}</span></div>` : "");
  }

  // ── Pie / donut (used sparingly) ───────────────────────────────────────
  function renderPieChart(el, p) {
    const data = p.data || [];
    const total = data.reduce((s, d) => s + d.value, 0) || 1;
    const W = 320, H = 220, R = 80, cx = W / 2, cy = H / 2;
    let g = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(p.title || "pie chart")}">`;
    let a0 = -Math.PI / 2;
    data.forEach((d, i) => {
      const a1 = a0 + (d.value / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0);
      const x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
      const color = d.color || PALETTE[i % PALETTE.length];
      g += `<path d="M${cx},${cy} L${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} Z" fill="${color}" />`;
      a0 = a1;
    });
    g += `</svg>`;
    const legend = data.map((d, i) => {
      const color = d.color || PALETTE[i % PALETTE.length];
      return `<span><i class="swatch" style="background:${color}"></i>${escapeHtml(d.label)} (${fmtNum(d.value)})</span>`;
    }).join("");
    el.innerHTML = g + `<div class="legend">${legend}</div>`;
  }

  // ── Stacked bar (counts across categories) ────────────────────────────
  function renderStackedChart(el, p) {
    const categories = p.categories || [];
    const series = p.series || [];
    const totals = categories.map((_, i) => series.reduce((s, sr) => s + (sr.values[i] || 0), 0));
    const max = Math.max(...totals, 1);
    const W = 720, H = 240, PAD = { l: 48, r: 16, t: 16, b: 36 };
    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;
    const bw = innerW / categories.length * 0.7;
    let g = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(p.title || "stacked bar chart")}">`;
    g += `<g class="grid">`;
    for (let i = 0; i <= 4; i++) {
      const y = PAD.t + (i * innerH) / 4;
      const v = max - (i * max) / 4;
      g += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}" />`;
      g += `<text class="axis" x="${PAD.l - 6}" y="${y + 3}" text-anchor="end">${escapeHtml(fmtNum(v))}</text>`;
    }
    g += `</g>`;
    categories.forEach((cat, i) => {
      const x = PAD.l + ((i + 0.5) * innerW) / categories.length - bw / 2;
      let yCursor = PAD.t + innerH;
      series.forEach((s, si) => {
        const v = s.values[i] || 0;
        const h = (v / max) * innerH;
        yCursor -= h;
        const color = s.color || PALETTE[si % PALETTE.length];
        g += `<rect class="bar" x="${x}" y="${yCursor}" width="${bw}" height="${h}" fill="${color}" />`;
      });
      g += `<text class="axis" x="${x + bw / 2}" y="${H - 14}" text-anchor="middle">${escapeHtml(cat)}</text>`;
    });
    g += `</svg>`;
    const legend = series.map((s, i) => {
      const color = s.color || PALETTE[i % PALETTE.length];
      return `<span><i class="swatch" style="background:${color}"></i>${escapeHtml(s.name)}</span>`;
    }).join("");
    el.innerHTML = g + `<div class="legend">${legend}</div>`;
  }

  // Expose for debugging if needed
  window.__pominigames_docs__ = { renderChart, PALETTE };
})();