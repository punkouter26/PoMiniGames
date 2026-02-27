// @ts-check
import { test, expect } from './fixtures';

test.describe('Connect Five game', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/connectfive');
  });

  test('renders 9x9 board with column drop buttons', async ({ page }) => {
    const cells = page.locator('.cf-cell');
    await expect(cells).toHaveCount(81); // 9 * 9

    const dropBtns = page.locator('.cf-drop-btn');
    await expect(dropBtns).toHaveCount(9);
  });

  test('clicking column drops a red piece', async ({ page }) => {
    const dropBtn = page.locator('.cf-drop-btn').nth(4); // centre column
    await dropBtn.click();

    const redCells = page.locator('.cf-cell.red');
    await expect(redCells).toHaveCount(1);
  });

  test('AI responds with yellow piece', async ({ page }) => {
    await page.locator('.cf-drop-btn').nth(4).click();
    await page.waitForTimeout(500);

    const yellowCells = page.locator('.cf-cell.yellow');
    await expect(yellowCells).toHaveCount(1);
  });

  test('new game button clears board', async ({ page }) => {
    await page.locator('.cf-drop-btn').nth(4).click();
    await page.waitForTimeout(500);

    await page.click('text=New Game');

    const redCount = await page.locator('.cf-cell.red').count();
    const yellowCount = await page.locator('.cf-cell.yellow').count();
    expect(redCount + yellowCount).toBe(0);
  });

  test('difficulty selector works', async ({ page }) => {
    const select = page.locator('select');
    await select.selectOption('Easy');
    await expect(select).toHaveValue('Easy');

    await select.selectOption('Hard');
    await expect(select).toHaveValue('Hard');
  });
});
