/**
 * Ad-hoc PoRun discovery test - validates current UI state
 * NOT part of the regular E2E suite — run manually for diagnostics only
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'http://localhost:5000';
const SCREENSHOT_DIR = path.join(__dirname, 'test-results', 'porun-discovery');

async function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function shot(page, name) {
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false, timeout: 8000 });
    console.log(`  📸  ${name} → ${file}`);
  } catch (e) {
    console.log(`  ⚠️  screenshot ${name} failed: ${e.message.split('\n')[0]}`);
  }
}

async function main() {
  await ensureDir(SCREENSHOT_DIR);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: undefined,
  });
  const page = await context.newPage();

  // Capture console errors
  const consoleErrors = [];
  const jsErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => jsErrors.push(err.message));

  console.log('\n=== PoRun Discovery Test ===\n');

  // ── 1. Home page ───────────────────────────────────────────────────
  console.log('1. Home page');
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await shot(page, '01-home');

  // Check game cards
  const gameLinks = await page.locator('a[href]').evaluateAll(els =>
    els.map(e => ({ href: e.getAttribute('href'), text: e.innerText?.trim() }))
       .filter(x => x.href && !x.href.startsWith('#') && !x.href.startsWith('http'))
  );
  console.log('  Game links found:', gameLinks.length, gameLinks.map(g => g.href).join(', '));

  // ── 2. Health endpoint ─────────────────────────────────────────────
  console.log('2. /health endpoint');
  const healthResp = await page.goto(`${BASE_URL}/health`);
  console.log('  Status:', healthResp?.status());
  const healthBody = await page.textContent('body');
  console.log('  Body:', healthBody?.substring(0, 100));

  // ── 3. /diag endpoint ─────────────────────────────────────────────
  console.log('3. /diag endpoint');
  const diagResp = await page.goto(`${BASE_URL}/diag`);
  console.log('  Status:', diagResp?.status());
  await shot(page, '03-diag');
  const diagText = await page.textContent('body');
  console.log('  Keys exposed (first 300 chars):', diagText?.substring(0, 300));

  // ── 4. VoxelShooter page (newest game) ────────────────────────────
  console.log('4. VoxelShooter page');
  await page.goto(`${BASE_URL}/voxelshooter`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000); // let WebGL/Three.js init
  await shot(page, '04-voxelshooter-initial');

  // Check canvas is present
  const canvas = await page.locator('canvas').first();
  const canvasVisible = await canvas.isVisible().catch(() => false);
  console.log('  Canvas visible:', canvasVisible);
  const canvasBB = await canvas.boundingBox().catch(() => null);
  console.log('  Canvas size:', canvasBB ? `${Math.round(canvasBB.width)}x${Math.round(canvasBB.height)}` : 'N/A');

  // Try clicking the canvas (game interaction)
  if (canvasBB) {
    await page.mouse.click(canvasBB.x + canvasBB.width / 2, canvasBB.y + canvasBB.height / 2);
    await page.waitForTimeout(500);
    await shot(page, '04-voxelshooter-after-click');
  }

  // Check for Start / Play button (do NOT click — WebGL game can hang screenshot pipeline)
  const startBtn = page.locator('button').filter({ hasText: /start|play|begin/i }).first();
  const startVisible = await startBtn.isVisible().catch(() => false);
  console.log('  Start/Play button visible:', startVisible);
  if (startVisible) {
    const startText = await startBtn.textContent().catch(() => '');
    console.log('  Start button text:', startText?.trim());
  }

  // ── 5. PoSnakeGame ────────────────────────────────────────────────
  console.log('5. PoSnakeGame page');
  await page.goto(`${BASE_URL}/posnakegame`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot(page, '05-posnakegame');
  const snakeCanvas = await page.locator('canvas').first();
  const snakeVisible = await snakeCanvas.isVisible().catch(() => false);
  console.log('  Snake canvas visible:', snakeVisible);

  // ── 6. PoFight page ───────────────────────────────────────────────
  console.log('6. PoFight page');
  await page.goto(`${BASE_URL}/pofight`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot(page, '06-pofight');

  // ── 7. PoRaceRagdoll page ─────────────────────────────────────────
  console.log('7. PoRaceRagdoll page');
  await page.goto(`${BASE_URL}/poraceragdoll`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot(page, '07-poraceragdoll');

  // ── 8. PoBabyTouch page ───────────────────────────────────────────
  console.log('8. PoBabyTouch page');
  await page.goto(`${BASE_URL}/pobabytouch`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot(page, '08-pobabytouch');

  // ── 9. TicTacToe page ─────────────────────────────────────────────
  console.log('9. TicTacToe page');
  await page.goto(`${BASE_URL}/tictactoe`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await shot(page, '09-tictactoe');
  // Try clicking a cell
  const cells = page.locator('[data-testid], .cell, td, .board-cell, .square').first();
  const cellVisible = await cells.isVisible().catch(() => false);
  console.log('  TicTacToe cell visible:', cellVisible);

  // ── 10. ConnectFive page ───────────────────────────────────────────
  console.log('10. ConnectFive page');
  await page.goto(`${BASE_URL}/connectfive`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await shot(page, '10-connectfive');

  // ── 11. PoDropSquare page ─────────────────────────────────────────
  console.log('11. PoDropSquare page');
  await page.goto(`${BASE_URL}/podropsquare`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await shot(page, '11-podropsquare');

  // ── 12. Offline resilience: API down check ────────────────────────
  console.log('12. Checking offline resilience (api/snake/highscores)');
  const apiResp = await page.goto(`${BASE_URL}/api/snake/highscores`);
  console.log('  API highscores status:', apiResp?.status());

  // ── 13. Auth config endpoint ──────────────────────────────────────
  console.log('13. Auth config check');
  const authResp = await page.goto(`${BASE_URL}/api/auth/config`);
  const authBody = await page.textContent('body');
  console.log('  Auth config:', authBody?.substring(0, 200));

  // ── 14. Return to home, nav check ─────────────────────────────────
  console.log('14. Home page again (nav check)');
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await shot(page, '14-home-final');

  // Check for any viewport/responsive issues
  await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14 Pro
  await page.waitForTimeout(500);
  await shot(page, '14-home-mobile');

  // ── Summary ───────────────────────────────────────────────────────
  console.log('\n=== Summary ===');
  console.log('Console errors:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [ERR ${i+1}] ${e.substring(0, 200)}`));
  console.log('JS runtime errors:', jsErrors.length);
  jsErrors.forEach((e, i) => console.log(`  [JS ${i+1}] ${e.substring(0, 200)}`));

  await browser.close();
  console.log('\nDone. Screenshots in:', SCREENSHOT_DIR);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
