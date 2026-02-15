// @ts-check
import { test, expect } from '@playwright/test';

test.describe('Home page', () => {
  test('shows game selector cards', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=PoMiniGames')).toBeVisible();
    await expect(page.locator('text=Connect Five')).toBeVisible();
    await expect(page.locator('text=Tic Tac Toe')).toBeVisible();
  });

  test('navigates to Connect Five', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Connect Five');
    await expect(page).toHaveURL(/connectfive/);
    await expect(page.locator('h1')).toContainText('Connect Five');
  });

  test('navigates to Tic Tac Toe', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Tic Tac Toe');
    await expect(page).toHaveURL(/tictactoe/);
    await expect(page.locator('h1')).toContainText('Tic Tac Toe');
  });
});
