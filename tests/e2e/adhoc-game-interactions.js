/**
 * Ad-hoc game interaction tests — TicTacToe, ConnectFive, PoFight, PoDropSquare
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = path.join(__dirname, 'test-results', 'porun-discovery');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), timeout: 8000 });
    console.log('  📸 ', name);
  } catch (e) {
    console.log('  ⚠️  screenshot failed:', name, e.message.split('\n')[0]);
  }
}

(async () => {
  const b = await chromium.launch({ headless: true });
  const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  // ── TicTacToe ─────────────────────────────────────────────────────────────
  console.log('\n=== TicTacToe interaction test ===');
  await page.goto('http://localhost:5000/tictactoe', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot(page, 'ttt-initial');

  const boardExists = await page.locator('.ttt-board').isVisible().catch(() => false);
  console.log('TTT board visible:', boardExists);
  const boardHTML = await page.locator('.ttt-board').innerHTML().catch(() => 'N/A');
  console.log('Board HTML (300):', boardHTML.substring(0, 300));

  const firstCell = page.locator('.ttt-board > *').first();
  const firstCellTag = await firstCell.evaluate(el => el.tagName).catch(() => 'N/A');
  console.log('First child tag:', firstCellTag);

  if (boardExists) {
    await firstCell.click().catch(e => console.log('click failed:', e.message));
    await page.waitForTimeout(800);
    await shot(page, 'ttt-after-click');
    const afterHTML = await page.locator('.ttt-board').innerHTML().catch(() => 'N/A');
    console.log('Board HTML after click (300):', afterHTML.substring(0, 300));
  }

  // ── ConnectFive ───────────────────────────────────────────────────────────
  console.log('\n=== ConnectFive interaction test ===');
  await page.goto('http://localhost:5000/connectfive', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await shot(page, 'cf5-initial');
  const cf5HTML = await page.locator('body').innerHTML().catch(() => '');
  const boardClasses = cf5HTML.match(/class="[^"]*board[^"]*"/g);
  console.log('Board classes found:', boardClasses ? boardClasses.join(', ') : 'none');

  // ── SinglePlayer page ─────────────────────────────────────────────────────
  console.log('\n=== SinglePlayer page ===');
  await page.goto('http://localhost:5000/single-player', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await shot(page, 'single-player');
  const bodyText = await page.locator('body').innerText().catch(() => '');
  console.log('Page text (400):', bodyText.substring(0, 400).replace(/\n/g, ' | '));

  // ── Lobby page ────────────────────────────────────────────────────────────
  console.log('\n=== Lobby page ===');
  await page.goto('http://localhost:5000/lobby', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await shot(page, 'lobby');
  const lobbyText = await page.locator('body').innerText().catch(() => '');
  console.log('Lobby text (300):', lobbyText.substring(0, 300).replace(/\n/g, ' | '));

  // ── PoSnakeGame interaction ────────────────────────────────────────────────
  console.log('\n=== PoSnakeGame keyboard test ===');
  await page.goto('http://localhost:5000/posnakegame', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot(page, 'snake-initial');
  const snakeText = await page.locator('body').innerText().catch(() => '');
  console.log('Snake page text (300):', snakeText.substring(0, 300).replace(/\n/g, ' | '));

  // Try pressing Space or Enter to start
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  await shot(page, 'snake-after-space');

  // Try arrow key
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  await shot(page, 'snake-after-move');

  // ── PoBabyTouch ────────────────────────────────────────────────────────────
  console.log('\n=== PoBabyTouch interaction test ===');
  await page.goto('http://localhost:5000/pobabytouch', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot(page, 'babytouch-initial');
  const btText = await page.locator('body').innerText().catch(() => '');
  console.log('BabyTouch page text (200):', btText.substring(0, 200).replace(/\n/g, ' | '));

  // ── PoRaceRagdoll ─────────────────────────────────────────────────────────
  console.log('\n=== PoRaceRagdoll ===');
  await page.goto('http://localhost:5000/poraceragdoll', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await shot(page, 'raceragdoll-initial');
  const rrText = await page.locator('body').innerText().catch(() => '');
  console.log('RaceRagdoll text (300):', rrText.substring(0, 300).replace(/\n/g, ' | '));

  // ── PoFight ───────────────────────────────────────────────────────────────
  console.log('\n=== PoFight ===');
  await page.goto('http://localhost:5000/pofight', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot(page, 'pofight-initial');
  const pfText = await page.locator('body').innerText().catch(() => '');
  console.log('PoFight text (300):', pfText.substring(0, 300).replace(/\n/g, ' | '));

  // ── PoDropSquare ──────────────────────────────────────────────────────────
  console.log('\n=== PoDropSquare ===');
  await page.goto('http://localhost:5000/podropsquare', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot(page, 'podropsquare-initial');
  const pdsText = await page.locator('body').innerText().catch(() => '');
  console.log('PoDropSquare text (300):', pdsText.substring(0, 300).replace(/\n/g, ' | '));

  // ── Mobile viewport tests ─────────────────────────────────────────────────
  console.log('\n=== Mobile viewport (390x844) ===');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:5000/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await shot(page, 'mobile-home');
  await page.goto('http://localhost:5000/tictactoe', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await shot(page, 'mobile-tictactoe');

  console.log('\nConsole errors total:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log('ERR', i+1, ':', e.substring(0, 200)));

  await b.close();
  console.log('\nDone.');
})().catch(e => console.error('FATAL:', e.message));
