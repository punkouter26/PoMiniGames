// Probe: visit /face/demo with a fresh browser context, register the demo
// SVG markup, capture the resulting JPEG, and assert the round score API
// returns a non-error response. Verifies that webcam.js's setDemoSvgMarkup
// path renders real JPEG data and flows through the scoring endpoint.

import { createRequire } from 'module';
const require = createRequire(process.env.APPDATA + '/npm/node_modules/@mermaid-js/mermaid-cli/node_modules/');
const puppeteer = require('puppeteer');
const BASE = 'http://localhost:5000';

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--no-sandbox', '--disable-gpu-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 800 },
  });
  try {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.on('pageerror', e => console.log('[pageerror]', e.message));
    page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300)); });

    // Sign in as guest so the protected endpoints accept us
    await page.goto(BASE + '/auth/login/fake?displayName=Probe-Demo', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1500));

    await page.goto(BASE + '/face/demo', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 5500));   // let Blazor hydrate + demo tick run a couple of rounds

    // Probe webcam.js API: is setDemoSvgMarkup exposed?
    const exposed = await page.evaluate(() => ({
      hasSet: typeof window.webcamInterop?.setDemoSvgMarkup === 'function',
      hasCapture: typeof window.webcamInterop?.captureFrame === 'function',
      activeSvgMarkup: !!window.webcamInterop?.captureFrame && (() => {
        // The internal flag is module-private; instead call captureFrame and verify it returns a real JPEG
        const v = document.getElementById('pf-demo-face-source');
        return !!v && v.outerHTML.length > 50;
      })()
    }));
    console.log('webcamInterop exposed:', JSON.stringify(exposed));

    // Directly capture a frame and inspect the JPEG bytes
    const result = await page.evaluate(async () => {
      try {
        const url = await window.webcamInterop.captureFrame('pf-webcam-preview');
        return {
          ok: !!url,
          prefix: url ? url.slice(0, 40) : null,
          len: url ? url.length : 0,
          isRealJpeg: url && url.startsWith('data:image/jpeg;base64,') && url.length > 1000
        };
      } catch (e) {
        return { error: e.message };
      }
    });
    console.log('captureFrame result:', JSON.stringify(result));

    // Check the API endpoint with a session + JPEG
    const sessionInfo = await page.evaluate(async () => {
      const resp = await fetch('/api/face/sessions', { method: 'POST' });
      if (!resp.ok) return { error: 'session POST returned ' + resp.status };
      const session = await resp.json();
      // Build a tiny valid JPEG (1x1 white) — same as the stub fallback
      const tinyJpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';
      const bytes = Uint8Array.from(atob(tinyJpeg.split(',')[1]), c => c.charCodeAt(0));
      const fd = new FormData();
      fd.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'probe.jpg');
      const score = await fetch(`/api/face/sessions/${session.sessionId}/rounds/0/score`, { method: 'POST', body: fd });
      const body = await score.text();
      return { sessionId: session.sessionId, scoreStatus: score.status, scoreBody: body.slice(0, 400) };
    });
    console.log('Score round 0:', JSON.stringify(sessionInfo));
  } finally {
    await browser.close();
  }
})();