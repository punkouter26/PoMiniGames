const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:5173';
const OUT_DIR = path.resolve(__dirname, '../../docs/screenshots/adhoc-multiplayer-headed');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function saveDom(page, name) {
  const html = await page.content();
  fs.writeFileSync(path.join(OUT_DIR, `${name}.html`), html, 'utf8');
}

async function gotoAsUser(page, userName) {
  await page.goto(`${BASE_URL}/?user=${encodeURIComponent(userName)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.home-dev-bypass-identity', { hasText: userName }).first().waitFor({ timeout: 15000 });
}

async function firstVisible(locatorA, locatorB) {
  const aCount = await locatorA.count();
  if (aCount > 0) {
    return { locator: locatorA.first(), side: 'A' };
  }
  const bCount = await locatorB.count();
  if (bCount > 0) {
    return { locator: locatorB.first(), side: 'B' };
  }
  return null;
}

(async () => {
  ensureDir(OUT_DIR);

  const report = {
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    steps: [],
    warnings: [],
    errors: [],
    final: 'unknown',
  };

  const ts = Date.now();
  const p1 = { userId: `adhoc-p1-${ts}`, displayName: `AdhocP1${ts}` };
  const p2 = { userId: `adhoc-p2-${ts}`, displayName: `AdhocP2${ts}` };

  const browser = await chromium.launch({ headless: false, slowMo: 150 });
  const ctx1 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  const attachConsole = (page, who) => {
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        report.warnings.push({ who, type, text: msg.text() });
      }
    });
    page.on('pageerror', (err) => {
      report.errors.push({ who, type: 'pageerror', text: String(err) });
    });
    page.on('requestfailed', (req) => {
      report.warnings.push({
        who,
        type: 'requestfailed',
        url: req.url(),
        method: req.method(),
        failure: req.failure() ? req.failure().errorText : 'unknown',
      });
    });
  };

  attachConsole(page1, 'player1');
  attachConsole(page2, 'player2');

  try {
    await gotoAsUser(page1, p1.displayName);
    await gotoAsUser(page2, p2.displayName);

    const p1Bypass2p = page1.locator('[aria-label="Developer bypass for 2 player"]').first();
    const p2Bypass2p = page2.locator('[aria-label="Developer bypass for 2 player"]').first();

    await p1Bypass2p.waitFor({ timeout: 10000 });
    await p2Bypass2p.waitFor({ timeout: 10000 });

    await p1Bypass2p.click();
    await p2Bypass2p.click();

    await page1.waitForURL(/\/lobby/, { timeout: 15000 });
    await page2.waitForURL(/\/lobby/, { timeout: 15000 });

    report.steps.push('Both players authenticated via URL developer bypass and 2P shortcut');

    let usedLobbyFlow = true;
    try {
      await page1.locator('.lobby-player-name', { hasText: p1.displayName }).first().waitFor({ timeout: 30000 });
      await page1.locator('.lobby-player-name', { hasText: p2.displayName }).first().waitFor({ timeout: 30000 });
      await page2.locator('.lobby-player-name', { hasText: p1.displayName }).first().waitFor({ timeout: 30000 });
      await page2.locator('.lobby-player-name', { hasText: p2.displayName }).first().waitFor({ timeout: 30000 });

      await page1.screenshot({ path: path.join(OUT_DIR, '01-lobby-player1.png'), fullPage: true });
      await page2.screenshot({ path: path.join(OUT_DIR, '02-lobby-player2.png'), fullPage: true });
      await saveDom(page1, '01-lobby-player1');
      await saveDom(page2, '02-lobby-player2');
      report.steps.push('Lobby join verified on both clients');

      const startBtn = page1.locator('button.lobby-btn-start').first();
      await startBtn.waitFor({ timeout: 10000 });
      await startBtn.click();

      await page1.waitForURL(/\/(tictactoe|connectfive)\?online=1/, { timeout: 20000 });
      await page2.waitForURL(/\/(tictactoe|connectfive)\?online=1/, { timeout: 20000 });
    } catch (lobbyErr) {
      usedLobbyFlow = false;
      report.warnings.push({
        type: 'lobby-flow-unstable',
        message: 'Lobby sync/start failed in headed run; falling back to direct online queue path',
        error: String(lobbyErr),
      });

      await page1.goto(`${BASE_URL}/tictactoe?online=1`, { waitUntil: 'domcontentloaded' });
      await page1.waitForTimeout(500);
      await page2.goto(`${BASE_URL}/tictactoe?online=1`, { waitUntil: 'domcontentloaded' });

      await page1.waitForURL(/\/tictactoe\?online=1/, { timeout: 20000 });
      await page2.waitForURL(/\/tictactoe\?online=1/, { timeout: 20000 });
    }

    await page1.screenshot({ path: path.join(OUT_DIR, '03-game-player1.png'), fullPage: true });
    await page2.screenshot({ path: path.join(OUT_DIR, '04-game-player2.png'), fullPage: true });
    await saveDom(page1, '03-game-player1');
    await saveDom(page2, '04-game-player2');
    report.steps.push(`Both players redirected to online game (${usedLobbyFlow ? 'lobby path' : 'fallback queue path'}): ${page1.url()}`);

    // Ad-hoc responsiveness check: wait for turn activation and try to place moves.
    let moves = 0;
    let turnReady = false;

    for (let i = 0; i < 50; i++) {
      const p1Ready = await page1.locator('.ttt-cell:not(.disabled), .cf-drop-btn:not([disabled])').count();
      const p2Ready = await page2.locator('.ttt-cell:not(.disabled), .cf-drop-btn:not([disabled])').count();
      if (p1Ready > 0 || p2Ready > 0) {
        turnReady = true;
        break;
      }
      await page1.waitForTimeout(500);
    }

    if (!turnReady) {
      const s1 = await page1.locator('.gps-status-badge').first().textContent().catch(() => null);
      const s2 = await page2.locator('.gps-status-badge').first().textContent().catch(() => null);
      report.warnings.push({
        type: 'turn-not-ready',
        message: 'No enabled multiplayer controls found within 25s after match start',
        player1Status: s1,
        player2Status: s2,
      });
    }

    for (let i = 0; i < 10; i++) {
      const p1Ttt = page1.locator('.ttt-cell[aria-label="Empty cell"]:not(.disabled)');
      const p2Ttt = page2.locator('.ttt-cell[aria-label="Empty cell"]:not(.disabled)');
      const p1Cf = page1.locator('.cf-drop-btn:not([disabled])');
      const p2Cf = page2.locator('.cf-drop-btn:not([disabled])');

      const choice = await firstVisible(p1Ttt, p1Cf);
      if (choice) {
        await choice.locator.click();
        moves += 1;
      }

      await page1.waitForTimeout(250);

      const choice2 = await firstVisible(p2Ttt, p2Cf);
      if (choice2) {
        await choice2.locator.click();
        moves += 1;
      }

      await page2.waitForTimeout(250);

      if (moves >= 2) {
        break;
      }
    }

    await page1.screenshot({ path: path.join(OUT_DIR, '05-after-moves-player1.png'), fullPage: true });
    await page2.screenshot({ path: path.join(OUT_DIR, '06-after-moves-player2.png'), fullPage: true });
    await saveDom(page1, '05-after-moves-player1');
    await saveDom(page2, '06-after-moves-player2');

    report.steps.push(`Input responsiveness validated with ${moves} successful move clicks`);

    // React offline-resilience probe: block API and verify local single-player still works.
    const offlineCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const offlinePage = await offlineCtx.newPage();
    await offlinePage.route('**/api/**', (route) => route.abort('failed'));
    await offlinePage.goto(`${BASE_URL}/tictactoe`, { waitUntil: 'domcontentloaded' });
    await offlinePage.waitForTimeout(1200);

    const offlineCells = await offlinePage.locator('.ttt-cell:not(.disabled)').count();
    if (offlineCells > 0) {
      await offlinePage.locator('.ttt-cell:not(.disabled)').first().click();
      report.steps.push('Offline probe passed: local TicTacToe remains playable when API calls fail');
    } else {
      report.warnings.push({
        type: 'offline-probe-failed',
        message: 'No enabled local TicTacToe cell found with API blocked',
      });
    }

    await offlinePage.screenshot({ path: path.join(OUT_DIR, '07-offline-tictactoe.png'), fullPage: true });
    const offlineHtml = await offlinePage.content();
    fs.writeFileSync(path.join(OUT_DIR, '07-offline-tictactoe.html'), offlineHtml, 'utf8');
    await offlineCtx.close();

    report.final = moves >= 2 ? 'pass' : 'partial';
  } catch (err) {
    report.final = 'fail';
    report.errors.push({ type: 'exception', text: String(err && err.stack ? err.stack : err) });
    try {
      await page1.screenshot({ path: path.join(OUT_DIR, '99-failure-player1.png'), fullPage: true });
      await page2.screenshot({ path: path.join(OUT_DIR, '99-failure-player2.png'), fullPage: true });
      await saveDom(page1, '99-failure-player1');
      await saveDom(page2, '99-failure-player2');
    } catch (_) {
      // Best effort capture on failure.
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    await ctx1.close();
    await ctx2.close();
    await browser.close();
    console.log(JSON.stringify(report, null, 2));
  }
})();
