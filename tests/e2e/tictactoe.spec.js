// @ts-check
import { test, expect } from '@playwright/test';

test.describe('Tic Tac Toe game', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tictactoe');
  });

  test('renders 6x6 board', async ({ page }) => {
    const cells = page.locator('.ttt-cell');
    await expect(cells).toHaveCount(36); // 6 * 6
  });

  test('player can place X by clicking empty cell', async ({ page }) => {
    const firstCell = page.locator('.ttt-cell').first();
    await firstCell.click();
    await expect(firstCell).toHaveAttribute('aria-label', 'X');
  });

  test('AI responds after player move', async ({ page }) => {
    const firstCell = page.locator('.ttt-cell').first();
    await firstCell.click();

    // Wait for AI to make a move (O)
    const oCell = page.locator('.ttt-cell[aria-label="O"]');
    await expect(oCell.first()).toBeVisible();
  });

  test('new game button resets board', async ({ page }) => {
    const firstCell = page.locator('.ttt-cell').first();
    await firstCell.click();
    await page.waitForTimeout(500);

    await page.click('text=New Game');

    const xCount = await page.locator('.ttt-cell[aria-label="X"]').count();
    const oCount = await page.locator('.ttt-cell[aria-label="O"]').count();
    expect(xCount + oCount).toBe(0);
  });

  test('difficulty selector works', async ({ page }) => {
    const select = page.locator('select');
    await select.selectOption('Easy');
    await expect(select).toHaveValue('Easy');

    await select.selectOption('Hard');
    await expect(select).toHaveValue('Hard');
  });
});
