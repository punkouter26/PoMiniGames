import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:5000';
const SCREENSHOTS_DIR = 'screenshots';

const pages = [
  { name: '01-home-page', path: '/' },
  { name: '02-single-player', path: '/single-player' },
  { name: '03-multiplayer-select', path: '/multi-player-select' },
  { name: '04-online-multiplayer', path: '/online-multiplayer' },
  { name: '05-connect-five', path: '/connectfive' },
];

async function takeScreenshots() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  for (const p of pages) {
    try {
      console.log(`Navigating to ${p.path}...`);
      await page.goto(`${BASE_URL}${p.path}`, { waitUntil: 'networkidle', timeout: 30000 });
      // Give Blazor a moment to fully render
      await page.waitForTimeout(3000);
      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/${p.name}.png`,
        fullPage: true,
      });
      console.log(`✓ Captured: ${p.name}`);
    } catch (err) {
      console.log(`✗ Failed ${p.name}: ${err.message}`);
    }
  }

  await browser.close();
  console.log('All screenshots captured.');
}

takeScreenshots();