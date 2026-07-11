// Direct verification: load webcam.js in a static page, register a fake
// SVG markup, call captureFrame, and check the returned data URL is a
// real JPEG (not the 1x1 stub). Confirms the SVG → canvas → JPEG pipeline.

import { createRequire } from 'module';
import { writeFileSync } from 'fs';
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
    const page = await browser.newPage();
    // Static page that imports the real webcam.js (so we get its exports)
    // and lets us invoke them with a synthetic SVG.
    await page.goto(BASE + '/auth/login/fake?displayName=Probe-SVG', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1000));

    // Inject webcam.js's exports by loading the script directly
    await page.evaluate(async () => {
      const s = document.createElement('script');
      s.src = '/js/webcam.js';
      await new Promise((res, rej) => { s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    });

    const result = await page.evaluate(async () => {
      // 1) Confirm webcamInterop is loaded
      const hasSet = typeof window.webcamInterop?.setDemoSvgMarkup === 'function';
      const hasCapture = typeof window.webcamInterop?.captureFrame === 'function';
      if (!hasSet || !hasCapture) return { error: 'webcamInterop missing', hasSet, hasCapture };

      // 2) Build a synthetic SVG (200x200 circle face) — same shape PoFace demo renders
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
        <rect width="200" height="200" fill="#ffd29a"/>
        <circle cx="100" cy="100" r="80" fill="#f6a85b" stroke="#b06a2c" stroke-width="3"/>
        <circle cx="70" cy="90" r="8" fill="#222"/>
        <circle cx="130" cy="90" r="8" fill="#222"/>
        <path d="M70 138 Q100 168 130 138" stroke="#222" stroke-width="5" fill="none"/>
      </svg>`;

      // 3) Register the markup, then capture
      window.webcamInterop.setDemoSvgMarkup(svg);
      const url = await window.webcamInterop.captureFrame('pf-webcam-preview');

      // 4) Inspect the result
      return {
        url,
        isJpegPrefix: url.startsWith('data:image/jpeg;base64,'),
        urlLen: url.length,
        // Decode the base64 portion to byte length
        b64: url.split(',')[1],
        // Compute the JPEG SOI marker (FFD8FF) to confirm it's a real JPEG
        hexHead: url.slice(23, 30)
      };
    });
    console.log('Direct webcam.js probe result:');
    console.log(JSON.stringify(result, null, 2));

    if (result.b64) {
      const buf = Buffer.from(result.b64, 'base64');
      const head = buf.subarray(0, 4);
      console.log(`Decoded ${buf.length} bytes; JPEG SOI marker: ${head.toString('hex')}`);
      const isJpeg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
      console.log(isJpeg ? '✓ Real JPEG (SOI FFD8FF present)' : '✗ NOT a real JPEG');
      // Save the JPEG for visual inspection
      writeFileSync('docs/audit-2026-07-11/poface-demo-captured.jpg', buf);
      console.log('Saved demo-captured JPEG to docs/audit-2026-07-11/poface-demo-captured.jpg');
    }
  } finally {
    await browser.close();
  }
})();