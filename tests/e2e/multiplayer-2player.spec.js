// @ts-check
/**
 * 2-Player Multiplayer E2E Tests
 *
 * Covers:
 *  1. Lobby: two players join, host starts a game, both redirect → game page
 *  2. Lobby: single-player waiting state
 *  3. TicTacToe ad-lib match: two browsers play a full game to completion
 *  4. ConnectFive ad-lib match: two browsers play moves until one wins / draws
 *  5. Leave match: player 2 abandons mid-game, player 1 sees "Opponent left"
 *
 * Prerequisites: .NET API on :5000 + Vite client on :5173 must be running.
 */

const { test, expect } = require('@playwright/test');

// Run all tests in this file sequentially — multiplayer tests share a global
// matchmaking queue and parallel execution would let players from different
// tests accidentally match each other.
test.describe.configure({ mode: 'serial' });

const BASE_URL = 'http://localhost:5173';
// Allow longer timeout for full game-play tests (matchmaking + SignalR + moves)
const GAME_TIMEOUT = 90_000;

// ─── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Authenticate via in-browser fetch so the cookie is scoped to :5173.
 * @param {import('@playwright/test').Page} page
 * @param {{ userId: string; displayName: string }} player
 */
async function loginPlayer(page, player) {
  await page.goto('/');
  const status = await page.evaluate(async (data) => {
    const resp = await fetch('/api/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      credentials: 'include',
    });
    return resp.status;
  }, { userId: player.userId, displayName: player.displayName });

  if (status !== 200) {
    throw new Error(`dev-login for ${player.displayName} returned HTTP ${status}`);
  }
}

/**
 * Create two authenticated browser contexts + pages, staggered so player1
 * is always the first to reach the server (becomes host / seat-0).
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {string} prefix  - unique prefix for userIds
 * @returns {Promise<any>}
 */
async function createTwoPlayers(browser, prefix) {
  const ts = Date.now();
  const p1 = { userId: `${prefix}-p1-${ts}`, displayName: `${prefix}_P1` };
  const p2 = { userId: `${prefix}-p2-${ts}`, displayName: `${prefix}_P2` };

  const ctx1 = await browser.newContext({ baseURL: BASE_URL });
  const ctx2 = await browser.newContext({ baseURL: BASE_URL });

  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  await loginPlayer(page1, p1);
  await loginPlayer(page2, p2);

  return { ctx1, ctx2, page1, page2, p1, p2 };
}

/**
 * Play random ad-lib moves in a TicTacToe online match until the game ends.
 * Alternates between the two pages; the current page's status badge reveals
 * whose turn it is.
 *
 * @param {import('@playwright/test').Page} page1
 * @param {import('@playwright/test').Page} page2
 * @param {{ displayName: string }} p1
 * @param {{ displayName: string }} p2
 */
async function playTicTacToeToEnd(page1, page2, p1, p2) {
  const GAME_END_RE = /wins|Draw!/i;
  const MAX_MOVES = 36; // 6×6 board at most

  for (let move = 0; move < MAX_MOVES; move++) {
    // Check if either page shows a game-over status
    const p1End = await page1.locator('.gps-status-badge').filter({ hasText: GAME_END_RE }).count();
    const p2End = await page2.locator('.gps-status-badge').filter({ hasText: GAME_END_RE }).count();
    if (p1End > 0 || p2End > 0) break;

    // Find which page has an enabled (non-disabled) empty cell → it's their turn
    const p1Cells = page1.locator('.ttt-cell[aria-label="Empty cell"]:not(.disabled)');
    const p2Cells = page2.locator('.ttt-cell[aria-label="Empty cell"]:not(.disabled)');

    const p1Count = await p1Cells.count();
    const p2Count = await p2Cells.count();

    if (p1Count > 0) {
      // Pick middle or first available cell for variation
      const idx = Math.min(Math.floor(p1Count / 2), p1Count - 1);
      await p1Cells.nth(idx).click();
      await page1.waitForTimeout(300);
    } else if (p2Count > 0) {
      const idx = Math.min(Math.floor(p2Count / 2), p2Count - 1);
      await p2Cells.nth(idx).click();
      await page2.waitForTimeout(300);
    } else {
      // Neither can move — game must be over
      break;
    }
  }
}

/**
 * Play random ad-lib moves in a ConnectFive online match.
 * Column drop buttons are enabled only on the active player's page.
 *
 * @param {import('@playwright/test').Page} page1
 * @param {import('@playwright/test').Page} page2
 * @param {number} maxMoves  - stop after this many moves regardless of outcome
 */
async function playConnectFiveMoves(page1, page2, maxMoves = 30) {
  const GAME_END_RE = /wins|Draw!/i;

  for (let move = 0; move < maxMoves; move++) {
    const p1End = await page1.locator('.gps-status-badge').filter({ hasText: GAME_END_RE }).count();
    const p2End = await page2.locator('.gps-status-badge').filter({ hasText: GAME_END_RE }).count();
    if (p1End > 0 || p2End > 0) break;

    const p1Btns = page1.locator('.cf-drop-btn:not([disabled])');
    const p2Btns = page2.locator('.cf-drop-btn:not([disabled])');

    const p1Count = await p1Btns.count();
    const p2Count = await p2Btns.count();

    // Vary column selection so pieces spread across the board
    if (p1Count > 0) {
      const col = move % p1Count;
      await p1Btns.nth(col).click();
      await page1.waitForTimeout(300);
    } else if (p2Count > 0) {
      const col = move % p2Count;
      await p2Btns.nth(col).click();
      await page2.waitForTimeout(300);
    } else {
      break;
    }
  }
}

// ─── Test suite: Lobby ───────────────────────────────────────────────────────

test.describe('2-player multiplayer lobby', () => {
  test.beforeEach(async () => { test.setTimeout(GAME_TIMEOUT); });

  test('two players join lobby and host starts a game', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2, p1, p2 } = await createTwoPlayers(browser, 'lobby');

    try {
      // Player 1 → lobby first to become host
      await page1.goto('/lobby');
      await expect(
        page1.locator('.lobby-player-name', { hasText: p1.displayName }),
      ).toBeVisible({ timeout: 30_000 });

      // Player 2 joins
      await page2.goto('/lobby');
      await expect(
        page1.locator('.lobby-player-name', { hasText: p2.displayName }),
      ).toBeVisible({ timeout: 30_000 });

      // Both appear on player 2's view
      await expect(
        page2.locator('.lobby-player-name', { hasText: p1.displayName }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        page2.locator('.lobby-player-name', { hasText: p2.displayName }),
      ).toBeVisible({ timeout: 10_000 });

      await expect(page1.locator('h2:has-text("Players (2)")')).toBeVisible();

      const startBtn = page1.locator('button.lobby-btn-start', { hasText: 'Start Game' });
      await expect(startBtn).toBeEnabled({ timeout: 5_000 });

      await expect(
        page2.locator('.lobby-waiting-start', { hasText: 'Waiting for the host to start' }),
      ).toBeVisible({ timeout: 5_000 });

      await startBtn.click();

      await Promise.all([
        expect(page1).toHaveURL(/\/(tictactoe|connectfive)\?online=1/, { timeout: 10_000 }),
        expect(page2).toHaveURL(/\/(tictactoe|connectfive)\?online=1/, { timeout: 10_000 }),
      ]);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('lobby shows waiting state when only one player is present', async ({ browser }) => {
    const ts = Date.now();
    const solo = { userId: `solo-${ts}`, displayName: `Solo_${ts}` };
    const ctx = await browser.newContext({ baseURL: BASE_URL });
    try {
      const page = await ctx.newPage();
      await loginPlayer(page, solo);
      await page.goto('/lobby');

      await expect(
        page.locator('.lobby-player-name', { hasText: solo.displayName }),
      ).toBeVisible({ timeout: 30_000 });

      await expect(
        page.locator('.lobby-waiting-hint', { hasText: 'Waiting for at least 1 more player' }),
      ).toBeVisible({ timeout: 5_000 });

      await expect(page.locator('button.lobby-btn-start')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('lobby: host can pick ConnectFive before starting', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2, p1, p2 } = await createTwoPlayers(browser, 'lobbyPick');

    try {
      await page1.goto('/lobby');
      await expect(
        page1.locator('.lobby-player-name', { hasText: p1.displayName }),
      ).toBeVisible({ timeout: 30_000 });

      await page2.goto('/lobby');
      await expect(
        page1.locator('.lobby-player-name', { hasText: p2.displayName }),
      ).toBeVisible({ timeout: 30_000 });

      // Select ConnectFive radio
      await page1.locator('.lobby-game-option', { hasText: 'Connect Five' }).click();
      await expect(
        page1.locator('input[value="connectfive"]'),
      ).toBeChecked();

      const startBtn = page1.locator('button.lobby-btn-start');
      await expect(startBtn).toBeEnabled({ timeout: 5_000 });
      await startBtn.click();

      await Promise.all([
        expect(page1).toHaveURL(/\/connectfive\?online=1/, { timeout: 10_000 }),
        expect(page2).toHaveURL(/\/connectfive\?online=1/, { timeout: 10_000 }),
      ]);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});

// ─── Test suite: TicTacToe ad-lib 2-player match ─────────────────────────────

test.describe('TicTacToe ad-lib 2-player match', () => {
  test.beforeEach(async () => { test.setTimeout(GAME_TIMEOUT); });

  test('both players are matched and see opponent name', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2, p1, p2 } = await createTwoPlayers(browser, 'ttt');

    try {
      // Navigate directly to game with ?online=1 — auto-joins queue when connected
      await page1.goto('/tictactoe?online=1');
      // Wait for the status badge to appear (may go straight past "Finding opponent")
      await expect(page1.locator('.gps-status-badge')).toBeVisible({ timeout: 30_000 });

      await page2.goto('/tictactoe?online=1');

      // Both should transition to "InProgress" — opponent name appears
      await expect(
        page1.locator('text=Playing against'),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page2.locator('text=Playing against'),
      ).toBeVisible({ timeout: 20_000 });

      // P1 should be playing against P2 and vice-versa
      await expect(page1.locator('body')).toContainText(p2.displayName);
      await expect(page2.locator('body')).toContainText(p1.displayName);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('both players can play turns and the board updates on both screens', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2 } = await createTwoPlayers(browser, 'tttTurns');

    try {
      await page1.goto('/tictactoe?online=1');
      await expect(page1.locator('.gps-status-badge')).toBeVisible({ timeout: 30_000 });

      await page2.goto('/tictactoe?online=1');
      await expect(
        page1.locator('text=Playing against'),
      ).toBeVisible({ timeout: 30_000 });

      // Player 1 is seat 0 / X — should be their turn first
      await expect(
        page1.locator('.gps-status-badge', { hasText: 'Your turn (X)' }),
      ).toBeVisible({ timeout: 10_000 });

      // P1 clicks a cell — wait for ≥1 enabled empty cell with an explicit timeout
      const enabledCells1 = page1.locator('.ttt-cell[aria-label="Empty cell"]:not(.disabled)');
      await expect(enabledCells1.first()).toBeVisible({ timeout: 15_000 });
      await enabledCells1.nth(Math.min(4, (await enabledCells1.count()) - 1)).click();

      // After P1's move, P2 should now have their turn
      await expect(
        page2.locator('.gps-status-badge', { hasText: 'Your turn (O)' }),
      ).toBeVisible({ timeout: 10_000 });

      // Board on P2's screen shows the X that P1 placed
      await expect(page2.locator('.ttt-cell[aria-label="X"]')).toHaveCount(1, { timeout: 5_000 });

      // P2 makes a move
      const enabledCells2 = page2.locator('.ttt-cell[aria-label="Empty cell"]:not(.disabled)');
      await expect(enabledCells2.first()).toBeVisible({ timeout: 15_000 });
      await enabledCells2.first().click();

      // Back to P1's turn
      await expect(
        page1.locator('.gps-status-badge', { hasText: 'Your turn (X)' }),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('ad-lib: play full TicTacToe game to completion', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2, p1, p2 } = await createTwoPlayers(browser, 'tttFull');

    try {
      await page1.goto('/tictactoe?online=1');
      await expect(page1.locator('.gps-status-badge')).toBeVisible({ timeout: 30_000 });

      await page2.goto('/tictactoe?online=1');
      await expect(page1.locator('text=Playing against')).toBeVisible({ timeout: 30_000 });
      await expect(page2.locator('text=Playing against')).toBeVisible({ timeout: 20_000 });

      // Play the game to completion using ad-lib random moves
      await playTicTacToeToEnd(page1, page2, p1, p2);

      // At least one page must show a game-over status (win / loss / draw)
      const GAME_END_RE = /wins|Draw!/i;
      await expect
        .poll(async () => {
          const p1Badge = await page1.locator('.gps-status-badge').filter({ hasText: GAME_END_RE }).count();
          const p2Badge = await page2.locator('.gps-status-badge').filter({ hasText: GAME_END_RE }).count();
          return p1Badge + p2Badge;
        }, { timeout: 30_000, message: 'Game should reach a win/loss/draw status' })
        .toBeGreaterThan(0);

      // Both pages should not show "Your turn" anymore
      await expect(page1.locator('.gps-status-badge', { hasText: 'Your turn' })).toHaveCount(0);
      await expect(page2.locator('.gps-status-badge', { hasText: 'Your turn' })).toHaveCount(0);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('player cannot move when it is not their turn', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2 } = await createTwoPlayers(browser, 'tttTurn');

    try {
      await page1.goto('/tictactoe?online=1');
      await expect(page1.locator('.gps-status-badge')).toBeVisible({ timeout: 30_000 });

      await page2.goto('/tictactoe?online=1');
      await expect(page1.locator('text=Playing against')).toBeVisible({ timeout: 30_000 });

      // P1 is X (seat 0) — confirm P2 cells are ALL disabled while it's P1's turn
      const p2Enabled = page2.locator('.ttt-cell[aria-label="Empty cell"]:not(.disabled)');
      await expect(p2Enabled).toHaveCount(0, { timeout: 5_000 });

      // P2 cells with disabled class = all 36
      await expect(page2.locator('.ttt-cell.disabled')).toHaveCount(36);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});

// ─── Test suite: ConnectFive ad-lib 2-player match ───────────────────────────

test.describe('ConnectFive ad-lib 2-player match', () => {
  test.beforeEach(async () => { test.setTimeout(GAME_TIMEOUT); });

  test('both players are matched and board is shown', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2, p1, p2 } = await createTwoPlayers(browser, 'cf');

    try {
      await page1.goto('/connectfive?online=1');
      // P1 joins queue — status shows "Finding opponent" or quickly advances
      await expect(
        page1.locator('.gps-status-badge'),
      ).toBeVisible({ timeout: 30_000 });

      await page2.goto('/connectfive?online=1');

      // Wait for match to form — "Playing against" appears on both screens
      await expect(
        page1.locator('text=Playing against'),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page2.locator('text=Playing against'),
      ).toBeVisible({ timeout: 20_000 });

      // 9×9 board should be on both screens
      await expect(page1.locator('.cf-cell')).toHaveCount(81);
      await expect(page2.locator('.cf-cell')).toHaveCount(81);

      // P1 (Red) goes first
      await expect(
        page1.locator('.gps-status-badge', { hasText: 'Your turn (Red)' }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(page2.locator('.gps-status-badge', { hasText: 'Your turn' })).toHaveCount(0);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('ad-lib: drop pieces — board updates on both screens', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2 } = await createTwoPlayers(browser, 'cfDrop');

    try {
      await page1.goto('/connectfive?online=1');
      await expect(page1.locator('.gps-status-badge')).toBeVisible({ timeout: 30_000 });

      await page2.goto('/connectfive?online=1');
      await expect(
        page1.locator('text=Playing against'),
      ).toBeVisible({ timeout: 30_000 });

      await expect(
        page1.locator('.gps-status-badge', { hasText: 'Your turn (Red)' }),
      ).toBeVisible({ timeout: 10_000 });

      // P1 drops into column 4 (centre)
      await page1.locator('.cf-drop-btn:not([disabled])').nth(4).click();
      await page1.waitForTimeout(400);

      // P1 should now see a red piece; P2 should see the same board
      await expect(page1.locator('.cf-cell.red')).toHaveCount(1, { timeout: 5_000 });
      await expect(page2.locator('.cf-cell.red')).toHaveCount(1, { timeout: 5_000 });

      // P2's turn (Yellow)
      await expect(
        page2.locator('.gps-status-badge', { hasText: 'Your turn (Yellow)' }),
      ).toBeVisible({ timeout: 10_000 });

      // P2 drops into column 4
      await page2.locator('.cf-drop-btn:not([disabled])').nth(4).click();
      await page2.waitForTimeout(400);

      await expect(page2.locator('.cf-cell.yellow')).toHaveCount(1, { timeout: 5_000 });
      await expect(page1.locator('.cf-cell.yellow')).toHaveCount(1, { timeout: 5_000 });
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('ad-lib: play ConnectFive through many moves', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2 } = await createTwoPlayers(browser, 'cfFull');

    try {
      await page1.goto('/connectfive?online=1');
      await expect(page1.locator('.gps-status-badge')).toBeVisible({ timeout: 30_000 });

      await page2.goto('/connectfive?online=1');
      await expect(
        page1.locator('text=Playing against'),
      ).toBeVisible({ timeout: 30_000 });

      // Play 20 moves — might or might not end the game on a 9×9 board
      await playConnectFiveMoves(page1, page2, 20);

      // Board should have pieces on both screens
      await expect
        .poll(async () => {
          return await page1.locator('.cf-cell.red').count();
        }, { timeout: 10_000 })
        .toBeGreaterThan(0);

      await expect
        .poll(async () => {
          return await page2.locator('.cf-cell.red').count();
        }, { timeout: 5_000 })
        .toBeGreaterThan(0);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});

// ─── Test suite: Mid-game abandonment ────────────────────────────────────────

test.describe('mid-game abandonment', () => {
  test.beforeEach(async () => { test.setTimeout(GAME_TIMEOUT); });

  test('TicTacToe: player 2 leaves — player 1 sees "Opponent left" status', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2 } = await createTwoPlayers(browser, 'tttLeave');

    try {
      await page1.goto('/tictactoe?online=1');
      await expect(page1.locator('.gps-status-badge')).toBeVisible({ timeout: 30_000 });

      await page2.goto('/tictactoe?online=1');
      await expect(page1.locator('text=Playing against')).toBeVisible({ timeout: 30_000 });

      // Make one move so the match is fully in-progress
      const p1Cells = page1.locator('.ttt-cell[aria-label="Empty cell"]:not(.disabled)');
      await p1Cells.first().click();
      await page1.waitForTimeout(400);

      // P2 clicks "Leave Match"
      await page2.locator('button', { hasText: 'Leave Match' }).click();

      // P1 should see abandoned / opponent-left state
      await expect(
        page1.locator('.gps-status-badge', { hasText: /left the match|Abandoned/i }),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('ConnectFive: player 2 leaves — player 1 sees "Opponent left" status', async ({ browser }) => {
    const { ctx1, ctx2, page1, page2 } = await createTwoPlayers(browser, 'cfLeave');

    try {
      await page1.goto('/connectfive?online=1');
      await expect(page1.locator('.gps-status-badge')).toBeVisible({ timeout: 30_000 });

      await page2.goto('/connectfive?online=1');
      await expect(page1.locator('text=Playing against')).toBeVisible({ timeout: 30_000 });

      // P1 drops one piece
      await page1.locator('.cf-drop-btn:not([disabled])').first().click();
      await page1.waitForTimeout(400);

      // P2 leaves
      await page2.locator('button', { hasText: 'Leave Match' }).click();

      await expect(
        page1.locator('.gps-status-badge', { hasText: /left the match|Abandoned/i }),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});
