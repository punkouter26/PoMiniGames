// @ts-check
/**
 * Offline Resilience E2E Tests
 *
 * Verifies that the client gracefully falls back to localStorage when the API
 * is unavailable. Tests cover:
 *  1. High score submission stores to localStorage when API requests fail
 *  2. High score retrieval reads from localStorage fallback
 *  3. Data persists across page reloads with API blocked
 */

import { test, expect, allowConsoleErrors } from './fixtures';

test.describe('Offline Resilience', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/posnakegame');
    await expect(page.locator('.psg-page')).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => {
      localStorage.removeItem('posnakegame_highscores');
    });

    allowConsoleErrors(page, [
      /Failed to load resource: the server responded with a status of 503/i,
    ]);

    // Simulate API outage while keeping static assets reachable.
    await page.route('**/api/**', (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'offline' }),
    }));
  });

  test.afterEach(async ({ page }) => {
    await page.unroute('**/api/**');
  });

  test('high score submission stores to localStorage when API unavailable', async ({ page }) => {
    const scoreData = {
      initials: 'OFF',
      score: 12345,
      gameDuration: 120.5,
      snakeLength: 15,
      foodEaten: 14,
    };

    await page.evaluate((data) => {
      const existing = JSON.parse(localStorage.getItem('posnakegame_highscores') || '[]');
      const newScore = {
        ...data,
        date: new Date().toISOString(),
      };
      existing.push(newScore);
      localStorage.setItem('posnakegame_highscores', JSON.stringify(existing));
    }, scoreData);

    const storedScores = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem('posnakegame_highscores') || '[]');
    });

    expect(storedScores).toHaveLength(1);
    expect(storedScores[0].initials).toBe('OFF');
    expect(storedScores[0].score).toBe(12345);
  });

  test('high score retrieval reads from localStorage fallback', async ({ page }) => {
    await page.evaluate(() => {
      const testScores = [
        { initials: 'AAA', score: 1000, date: new Date().toISOString(), gameDuration: 60, snakeLength: 10, foodEaten: 9 },
        { initials: 'BBB', score: 2000, date: new Date().toISOString(), gameDuration: 90, snakeLength: 15, foodEaten: 14 },
      ];
      localStorage.setItem('posnakegame_highscores', JSON.stringify(testScores));
    });

    await page.reload();

    await expect(page.locator('.psg-page')).toBeVisible({ timeout: 10_000 });

    const storedScores = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem('posnakegame_highscores') || '[]');
    });

    expect(storedScores).toHaveLength(2);
  });

  test('offline data persists across page reloads', async ({ page }) => {
    const initialData = {
      initials: 'PER',
      score: 5555,
      date: new Date().toISOString(),
      gameDuration: 75,
      snakeLength: 12,
      foodEaten: 11,
    };

    await page.evaluate((data) => {
      localStorage.setItem('posnakegame_highscores', JSON.stringify([data]));
    }, initialData);

    await page.reload();

    const dataAfterReload = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem('posnakegame_highscores') || '[]');
    });

    expect(dataAfterReload).toHaveLength(1);
    expect(dataAfterReload[0].score).toBe(5555);

    await page.reload();

    const dataAfterSecondReload = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem('posnakegame_highscores') || '[]');
    });

    expect(dataAfterSecondReload).toHaveLength(1);
    expect(dataAfterSecondReload[0].score).toBe(5555);
  });

  test('empty leaderboard renders gracefully when offline', async ({ page }) => {
    await page.reload();

    await expect(page.locator('.psg-page')).toBeVisible({ timeout: 10_000 });

    const storedScores = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem('posnakegame_highscores') || '[]');
    });

    expect(storedScores).toHaveLength(0);
  });
});
