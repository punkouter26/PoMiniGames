// @ts-check
/**
 * E2E tests for URL-based Developer Bypass Identity
 *
 * Covers:
 *  1. ?user=Name auto-authenticates on page load — identity badge visible
 *  2. /api/auth/me returns the correct per-URL user profile
 *  3. No ?user= param → Dev Admin fallback via DevBypassAuthHandler
 *  4. Two browser contexts with different ?user= params get distinct identities
 *  5. Bypass → 2P button authenticates and navigates to /lobby
 *  6. Bypass → 1P button authenticates and navigates to /single-player
 *  7. Both URL-identity users can join the lobby simultaneously with distinct names
 *
 * Prerequisites: .NET API on :5000 + Vite client on :5173 must be running.
 * The second browser context simulates an incognito tab by using a fresh context.
 */

const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = 'http://localhost:5173';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Navigate to the home page with a ?user= param and wait for the React app to
 * finish the auto-bypass initialisation (i.e. the identity badge appears).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} userName
 */
async function gotoAsUser(page, userName) {
  await page.goto(`/?user=${encodeURIComponent(userName)}`);
  // Wait for the identity badge that Home.tsx renders only after URL-param auth
  await expect(
    page.locator('.home-dev-bypass-identity', { hasText: userName }),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Read the current authenticated profile via the API.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ userId: string; displayName: string; email: string } | null>}
 */
async function getMe(page) {
  return page.evaluate(async () => {
    const resp = await fetch('/api/auth/me', { credentials: 'include' });
    if (!resp.ok) return null;
    return resp.json();
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('Dev-Bypass URL identity', () => {
  test('?user=Alice auto-authenticates and shows identity badge', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE_URL });
    const page = await ctx.newPage();

    try {
      await gotoAsUser(page, 'Alice');

      // Identity badge chip must be shown in the Developer Bypass panel
      await expect(
        page.locator('.home-dev-bypass-identity'),
      ).toHaveText('Alice');

      // Panel description must use the auto-authenticated variant
      await expect(
        page.locator('.home-dev-bypass-desc'),
      ).toContainText('Auto-authenticated as');
      await expect(
        page.locator('.home-dev-bypass-desc strong'),
      ).toHaveText('Alice');
    } finally {
      await ctx.close();
    }
  });

  test('/api/auth/me returns the correct profile for the URL-param user', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE_URL });
    const page = await ctx.newPage();

    try {
      await gotoAsUser(page, 'TestPlayer');

      const profile = await getMe(page);

      expect(profile).not.toBeNull();
      expect(profile.displayName).toBe('TestPlayer');
      expect(profile.userId).toBe('dev-testplayer');
      expect(profile.email).toBe('dev-testplayer@local.dev');
    } finally {
      await ctx.close();
    }
  });

  test('no ?user= param → Dev Admin fallback (DevBypassAuthHandler)', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE_URL });
    const page = await ctx.newPage();

    try {
      await page.goto('/');
      // No identity badge when no ?user= param
      await expect(page.locator('.home-dev-bypass-identity')).toHaveCount(0);

      // The panel description fallback must mention URL usage instructions
      await expect(
        page.locator('.home-dev-bypass-desc'),
      ).toContainText('?user=Name');

      // API still returns a valid dev user via the DevBypassAuthHandler fallback
      // (it may be "Dev Admin" from the handler, or the prior cookie if one exists;
      //  either way the request is authenticated)
      const profile = await getMe(page);
      expect(profile).not.toBeNull();
      expect(typeof profile.displayName).toBe('string');
    } finally {
      await ctx.close();
    }
  });

  test('two contexts with different ?user= params get distinct identities', async ({ browser }) => {
    const ctx1 = await browser.newContext({ baseURL: BASE_URL });
    const ctx2 = await browser.newContext({ baseURL: BASE_URL });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      // Authenticate both tabs concurrently
      await Promise.all([
        gotoAsUser(page1, 'Player1'),
        gotoAsUser(page2, 'Player2'),
      ]);

      const [me1, me2] = await Promise.all([getMe(page1), getMe(page2)]);

      expect(me1).not.toBeNull();
      expect(me2).not.toBeNull();

      // Must be different users
      expect(me1.displayName).toBe('Player1');
      expect(me2.displayName).toBe('Player2');
      expect(me1.userId).not.toBe(me2.userId);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('Bypass → 2P button authenticates and navigates to /lobby', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE_URL });
    const page = await ctx.newPage();

    try {
      await gotoAsUser(page, 'LobbyTester');

      // Button label is personalised: "LobbyTester → 2P"
      const btn = page.locator('[aria-label="Developer bypass for 2 player"]');
      await expect(btn).toBeVisible();
      await expect(btn).toContainText('LobbyTester → 2P');

      await btn.click();
      await expect(page).toHaveURL(/\/lobby/, { timeout: 10_000 });
    } finally {
      await ctx.close();
    }
  });

  test('Bypass → 1P button authenticates and navigates to /single-player', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE_URL });
    const page = await ctx.newPage();

    try {
      await gotoAsUser(page, 'SoloBypasser');

      const btn = page.locator('[aria-label="Developer bypass for 1 player"]');
      await expect(btn).toBeVisible();
      await expect(btn).toContainText('SoloBypasser → 1P');

      await btn.click();
      await expect(page).toHaveURL(/\/single-player/, { timeout: 10_000 });
    } finally {
      await ctx.close();
    }
  });
});

test.describe('Dev-Bypass URL identity – Lobby integration', () => {
  test.setTimeout(60_000);

  test('two URL-identity users join lobby with distinct display names', async ({ browser }) => {
    const ts = Date.now();
    const name1 = `BypassA${ts % 10000}`;
    const name2 = `BypassB${ts % 10000}`;

    const ctx1 = await browser.newContext({ baseURL: BASE_URL });
    const ctx2 = await browser.newContext({ baseURL: BASE_URL });
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      // Auto-authenticate both via URL param
      await gotoAsUser(page1, name1);
      await gotoAsUser(page2, name2);

      // Player 1 navigates to lobby first (becomes host)
      await page1.goto('/lobby');
      await expect(
        page1.locator('.lobby-player-name', { hasText: name1 }),
      ).toBeVisible({ timeout: 20_000 });

      // Player 2 joins
      await page2.goto('/lobby');
      await expect(
        page2.locator('.lobby-player-name', { hasText: name2 }),
      ).toBeVisible({ timeout: 20_000 });

      // Both entries visible on Player 1's view
      await expect(
        page1.locator('.lobby-player-name', { hasText: name2 }),
      ).toBeVisible({ timeout: 10_000 });

      // Player count heading shows 2
      await expect(page1.locator('h2:has-text("Players (2)")')).toBeVisible({ timeout: 10_000 });

      // The two user IDs must be different (verified via API)
      const [me1, me2] = await Promise.all([
        page1.evaluate(async () => (await (await fetch('/api/auth/me', { credentials: 'include' })).json())),
        page2.evaluate(async () => (await (await fetch('/api/auth/me', { credentials: 'include' })).json())),
      ]);

      expect(me1.userId).not.toBe(me2.userId);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});
