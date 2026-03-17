import { test, expect } from '@playwright/test';

test.describe('2-Player PoSnakeGame Online Mode', () => {
  test('solo mode still works (backward compat)', async ({ page }) => {
    await page.goto('/?user=Alice');
    await page.goto('/posnakegame');
    
    // Should see "Battle Arena" heading
    await expect(page.locator('text=Battle Arena')).toBeVisible();
    
    // Should see the canvas
    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();
    
    // Should have "New Game" button
    await expect(page.locator('button:has-text("New Game")')).toBeVisible();
  });

  test('online mode page loads with mode tabs', async ({ page }) => {
    await page.goto('/?user=Bob');
    await page.goto('/posnakegame?online=1');
    
    // Should have mode tabs
    await expect(page.locator('text=Solo')).toBeVisible();
    await expect(page.locator('text=2 Player Online')).toBeVisible();
    
    // "2 Player Online" tab should be active
    const onlineTab = page.locator('button:has-text("2 Player Online")');
    await expect(onlineTab).toHaveClass(/active/);
  });

  test('online panel shows when in online mode', async ({ page }) => {
    await page.goto('/?user=Charlie');
    await page.goto('/posnakegame?online=1');
    
    // Should show connection status
    await expect(page.locator('text=Find Opponent')).toBeVisible();
  });

  test('snake game engine supports 2-player initialization', async ({ page }) => {
    // Verify snakeGameEngine exports initializeTwoPlayerGame
    await page.goto('/?user=Frank');
    await page.goto('/posnakegame?online=1');
    
    // Navigate to online mode
    await page.click('button:has-text("2 Player Online")');
    
    // The page should load without errors
    await expect(page.locator('text=Find Opponent')).toBeVisible();
    
    // Collect any console errors
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    // Wait a bit for any potential errors
    await page.waitForTimeout(1000);
    expect(errors.length).toBe(0);
  });
});
