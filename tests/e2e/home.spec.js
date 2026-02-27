// @ts-check
import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared data
// ---------------------------------------------------------------------------
const GAME_CARDS = [
  { label: 'Connect Five',  ariaLabel: 'Play Connect Five',  route: /connectfive/  },
  { label: 'Tic Tac Toe',   ariaLabel: 'Play Tic Tac Toe',   route: /tictactoe/   },
  { label: 'Voxel Shooter', ariaLabel: 'Play Voxel Shooter', route: /voxelshooter/ },
  { label: 'PoFight',       ariaLabel: 'Play PoFight',       route: /pofight/      },
  { label: 'PoDropSquare',  ariaLabel: 'Play PoDropSquare',  route: /podropsquare/ },
  { label: 'PoBabyTouch',   ariaLabel: 'Play PoBabyTouch',   route: /pobabytouch/  },
  { label: 'PoRaceRagdoll', ariaLabel: 'Play PoRaceRagdoll', route: /poraceragdoll/},
];

const HIGH_SCORE_GAMES = [
  'Connect Five', 'Tic Tac Toe', 'Voxel Shooter',
  'PoFight', 'PoDropSquare', 'PoBabyTouch', 'PoRaceRagdoll',
];

// ---------------------------------------------------------------------------
// Home page – page load
// ---------------------------------------------------------------------------
test.describe('Home page – page load', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('displays the PoMiniGames title', async ({ page }) => {
    await expect(page.locator('h1.home-title')).toContainText('PoMiniGames');
  });

  test('displays the subtitle', async ({ page }) => {
    await expect(page.locator('.home-subtitle')).toContainText('Choose a game to play');
  });

  test('displays the player name input', async ({ page }) => {
    const input = page.getByLabel('Player name');
    await expect(input).toBeVisible();
    await expect(input).toBeEditable();
  });

  test('renders all 7 game card headings', async ({ page }) => {
    for (const game of GAME_CARDS) {
      await expect(page.locator(`h2:has-text("${game.label}")`)).toBeVisible();
    }
  });

  test('each game card has a Play button', async ({ page }) => {
    const playBtns = page.locator('.play-btn');
    await expect(playBtns).toHaveCount(GAME_CARDS.length);
  });

  test('game grid is visible', async ({ page }) => {
    await expect(page.locator('.game-cards')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Home page – game selection / navigation
// ---------------------------------------------------------------------------
test.describe('Home page – game selection', () => {
  test('navigates to Connect Five and back', async ({ page }) => {
    await page.goto('/');
    await page.click('[aria-label="Play Connect Five"]');
    await expect(page).toHaveURL(/connectfive/);
    await expect(page.locator('h1')).toContainText('Connect Five');
    await page.goBack();
    await expect(page).toHaveURL('/');
    await expect(page.locator('h1.home-title')).toContainText('PoMiniGames');
  });

  test('navigates to Tic Tac Toe and back', async ({ page }) => {
    await page.goto('/');
    await page.click('[aria-label="Play Tic Tac Toe"]');
    await expect(page).toHaveURL(/tictactoe/);
    await expect(page.locator('h1')).toContainText('Tic Tac Toe');
    await page.goBack();
    await expect(page).toHaveURL('/');
  });

  test('navigates to Voxel Shooter', async ({ page }) => {
    await page.goto('/');
    await page.click('[aria-label="Play Voxel Shooter"]');
    await expect(page).toHaveURL(/voxelshooter/);
  });

  test('navigates to PoFight', async ({ page }) => {
    await page.goto('/');
    await page.click('[aria-label="Play PoFight"]');
    await expect(page).toHaveURL(/pofight/);
  });

  test('navigates to PoDropSquare', async ({ page }) => {
    await page.goto('/');
    await page.click('[aria-label="Play PoDropSquare"]');
    await expect(page).toHaveURL(/podropsquare/);
  });

  test('navigates to PoBabyTouch', async ({ page }) => {
    await page.goto('/');
    await page.click('[aria-label="Play PoBabyTouch"]');
    await expect(page).toHaveURL(/pobabytouch/);
  });

  test('navigates to PoRaceRagdoll', async ({ page }) => {
    await page.goto('/');
    await page.click('[aria-label="Play PoRaceRagdoll"]');
    await expect(page).toHaveURL(/poraceragdoll/);
  });

  test('game card links are keyboard-focusable', async ({ page }) => {
    await page.goto('/');
    const firstCard = page.getByLabel('Play Connect Five');
    await firstCard.focus();
    await expect(firstCard).toBeFocused();
  });
});

// ---------------------------------------------------------------------------
// Home page – high scores
// ---------------------------------------------------------------------------
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
    // Wait for loading to finish
    await page.waitForSelector('.home-highscores-card, .home-highscores-empty', {
      timeout: 10_000,
    });
    for (const label of HIGH_SCORE_GAMES) {
      await expect(page.locator(`.home-highscores-game:has-text("${label}")`)).toBeVisible();
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

// ---------------------------------------------------------------------------
// Home page – player name
// ---------------------------------------------------------------------------
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
    await page.click('[aria-label="Play Connect Five"]');
    await page.goBack();
    await expect(page.getByLabel('Player name')).toHaveValue('PersistMe');
  });

  test('player name persists across page reloads', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Player name').fill('ReloadPersist');
    await page.reload();
    await expect(page.getByLabel('Player name')).toHaveValue('ReloadPersist');
  });
});
