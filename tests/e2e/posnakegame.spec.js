// @ts-check
import { test, expect } from './fixtures';

test.describe('PoSnakeGame', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/posnakegame');
  });

  test('renders the Battle Arena heading', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Battle Arena');
  });

  test('renders the game canvas', async ({ page }) => {
    await expect(page.locator('canvas')).toBeVisible();
  });

  test('renders the leaderboard section', async ({ page }) => {
    await expect(page.locator('.psg-leaderboard')).toBeVisible();
  });

  test('New Game button is visible and clickable', async ({ page }) => {
    const btn = page.locator('.psg-new-game-btn');
    await expect(btn).toBeVisible();
    await btn.click();
    // After clicking New Game the canvas should still be present
    await expect(page.locator('canvas')).toBeVisible();
  });

  test('navigating to PoSnakeGame from Home works', async ({ page }) => {
    await page.goto('/');
    await page.click('[aria-label="Play PoSnakeGame"]');
    await expect(page).toHaveURL(/posnakegame/);
    await expect(page.locator('h1')).toContainText('Battle Arena');
    await page.goBack();
    await expect(page).toHaveURL('/');
  });
});
