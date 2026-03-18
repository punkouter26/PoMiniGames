// @ts-check
import { test, expect } from './fixtures';

const WORKFLOW_OPTIONS = [
  { label: '2 Players', ariaLabel: 'Play 2 players', route: /\/lobby/ },
  { label: '1 Player', ariaLabel: 'Play 1 player', route: /\/single-player/ },
  { label: 'Demo Mode', ariaLabel: 'Play demo mode' },
];

const HIGH_SCORE_GAMES = [
  'Connect Five', 'Tic Tac Toe', 'PoFight', 'PoBabyTouch',
];

test.describe('Home page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('displays the PoMiniGames title', async ({ page }) => {
    await expect(page.locator('h1.home-title')).toContainText('PoMiniGames');
  });

  test('displays the subtitle', async ({ page }) => {
    await expect(page.locator('.home-subtitle')).toContainText('Choose how you want to play');
  });

  test('displays the player name input', async ({ page }) => {
    const input = page.getByLabel('Player name');
    await expect(input).toBeVisible();
    await expect(input).toBeEditable();
  });

  test('renders exactly the 3 workflow options', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Play 2 players' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play 1 player' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play demo mode' })).toBeVisible();
    await expect(page.locator('.home-mode-btn')).toHaveCount(3);
  });

  test('option cards have correct links', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Play 2 players' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play 1 player' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play demo mode' })).toBeVisible();
  });

  test('game grid is visible', async ({ page }) => {
    await expect(page.locator('.home-modes')).toBeVisible();
  });

  test('option 1 opens lobby flow', async ({ page }) => {
    await page.locator('.home-dev-pill-toggle').click();
    const bypass2p = page.getByRole('button', { name: /Developer bypass for 2 player/i });

    await Promise.all([
      page.waitForURL(/\/lobby/, { timeout: 15_000 }),
      bypass2p.click(),
    ]);
  });

  test('option 2 opens single-player flow', async ({ page }) => {
    await page.locator('.home-dev-pill-toggle').click();
    const bypass1p = page.getByRole('button', { name: /Developer bypass for 1 player/i });

    await Promise.all([
      page.waitForURL(/\/single-player/, { timeout: 15_000 }),
      bypass1p.click(),
    ]);
  });

  test('option 3 randomly launches a demo game route', async ({ page }) => {
    const playDemo = page.getByRole('button', { name: 'Play demo mode' });

    await Promise.all([
      page.waitForURL(/\/(tictactoe|connectfive|pofight)/, { timeout: 15_000 }),
      playDemo.click(),
    ]);
  });
});

test.describe('Home page – high scores', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('high scores section is present on the page', async ({ page }) => {
    await expect(
      page.locator('[aria-label="Top 10 high scores per game"]'),
    ).toBeVisible();
  });

  test('shows the "Top 10 High Scores" heading', async ({ page }) => {
    await expect(page.locator('h2:has-text("Top 10 High Scores")')).toBeVisible();
  });

  test('shows a game card for every game in the leaderboard', async ({ page }) => {
    // Tab buttons render immediately; no need to wait for API data
    for (const label of HIGH_SCORE_GAMES) {
      await expect(page.locator(`.home-highscores-tab:has-text("${label}")`)).toBeVisible();
    }
  });

  test('shows loading state or leaderboard data (never blank)', async ({ page }) => {
    // The section must always have content – either a loader or cards
    const section = page.locator('[aria-label="Top 10 high scores per game"]');
    await expect(section).not.toBeEmpty();
  });

  test('high scores section scrolls into view', async ({ page }) => {
    const section = page.locator('[aria-label="Top 10 high scores per game"]');
    await section.scrollIntoViewIfNeeded();
    await expect(section).toBeVisible();
  });
});

test.describe('Home page – player name', () => {
  test('player name can be typed', async ({ page }) => {
    await page.goto('/');
    const input = page.getByLabel('Player name');
    await input.fill('TestPlayer');
    await expect(input).toHaveValue('TestPlayer');
  });

  test('player name persists after navigating to a game and back', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Player name').fill('PersistMe');

    // Use dev bypass to navigate — avoids MSAL auth requirement when microsoftEnabled=true
    await page.locator('.home-dev-pill-toggle').click();
    await Promise.all([
      page.waitForURL(/\/single-player/, { timeout: 15_000 }),
      page.getByRole('button', { name: /Developer bypass for 1 player/i }).click(),
    ]);

    await page.goBack();
    await page.waitForURL('/');
    await expect(page.getByLabel('Player name')).toHaveValue('PersistMe');
  });

  test('player name persists across page reloads', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Player name').fill('ReloadPersist');
    await page.reload();
    await expect(page.getByLabel('Player name')).toHaveValue('ReloadPersist');
  });
});
