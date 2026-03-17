// @ts-check
import { test, expect } from './fixtures';

test.describe('PoFight demo mode', () => {
  test('demo query launches CPU-vs-CPU flow', async ({ page }) => {
    await page.goto('/pofight?demo=1');

    await expect(page).toHaveURL(/\/pofight\?demo=1/);

    await expect(
      page.getByText(/CPU 1 SELECTING|CPU 2 SELECTING|READY!/i),
    ).toBeVisible({ timeout: 6000 });
  });
});
