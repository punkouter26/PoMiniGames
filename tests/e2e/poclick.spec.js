// @ts-check
import { test, expect } from './fixtures';

test.describe('PoClick game', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/poclick');
  });

  test('renders BPM config card on load', async ({ page }) => {
    // Check that the BPM config card is visible
    await expect(page.locator('.cyber-card')).toBeVisible();
    
    // Check for BPM display
    await expect(page.locator('.bpm-display-value')).toContainText('BPM');
    
    // Check for tempo buttons
    await expect(page.locator('.btn-tempo')).toHaveCount(5);
    
    // Check for duration buttons
    await expect(page.locator('.btn-duration')).toHaveCount(3);
  });

  test('can change BPM via buttons', async ({ page }) => {
    // Click on 120 BPM button
    const bpmButtons = page.locator('.btn-tempo');
    await bpmButtons.nth(3).click(); // 120 BPM
    
    // Verify the BPM display updated
    await expect(page.locator('.bpm-display-value')).toContainText('120');
  });

  test('can change duration', async ({ page }) => {
    // Click on 30s duration
    const durationButtons = page.locator('.btn-duration');
    await durationButtons.nth(1).click(); // 30s
    
    // Verify the start button text changed
    await expect(page.locator('.cyber-btn')).toContainText('30s');
  });

  test('can start game and see countdown', async ({ page }) => {
    // Click start button
    await page.click('.cyber-btn:has-text("Start")');
    
    // Wait for countdown to appear
    await expect(page.locator('.countdown-display')).toBeVisible();
    
    // Wait for countdown to finish (3 seconds)
    await page.waitForTimeout(3500);
    
    // Game HUD should be visible now
    await expect(page.locator('.hud-time')).toBeVisible();
  });

  test('game HUD shows correct elements', async ({ page }) => {
    // Start game
    await page.click('.cyber-btn:has-text("Start")');
    await page.waitForTimeout(3500);
    
    // Check HUD elements
    await expect(page.locator('.hud-time')).toBeVisible();
    await expect(page.locator('.hud-item')).toHaveCount(4); // Streak, Points, Perfects, Misses
    await expect(page.locator('.visualizer-container')).toBeVisible();
  });

  test('can abort game', async ({ page }) => {
    // Start game
    await page.click('.cyber-btn:has-text("Start")');
    await page.waitForTimeout(3500);
    
    // Click abort button
    await page.click('button:has-text("Abort")');
    
    // Should be back to config screen
    await expect(page.locator('.cyber-card')).toBeVisible();
  });

  test('BPM preview works', async ({ page }) => {
    // Click preview button
    const previewBtn = page.locator('.preview-toggle');
    await previewBtn.click();
    
    // Button should show stop icon
    await expect(previewBtn).toContainText('⏹');
    
    // Click again to stop
    await previewBtn.click();
    await expect(previewBtn).toContainText('▶');
  });

  test('demo mode auto-plays', async ({ page }) => {
    await page.goto('/poclick/1');
    
    // Demo mode indicator should be visible
    await expect(page.locator('.cf-status--demo')).toBeVisible();
    
    // Wait for countdown to appear
    await expect(page.locator('.countdown-display')).toBeVisible({ timeout: 10000 });
    
    // Wait for countdown to finish and game to start
    await expect(page.locator('.hud-time')).toBeVisible({ timeout: 15000 });
  });

  test('new game button resets game', async ({ page }) => {
    // Start game
    await page.click('.cyber-btn:has-text("Start")');
    await page.waitForTimeout(3500);
    
    // Abort game - should return to config screen
    await page.click('button:has-text("Abort")');
    await page.waitForTimeout(500);
    
    // Should be back to config screen
    await expect(page.locator('.cyber-card')).toBeVisible();
    
    // Start a new game by clicking the Start button again
    await page.click('.cyber-btn:has-text("Start")');
    
    // Wait for countdown to appear
    await expect(page.locator('.countdown-display')).toBeVisible();
    
    // Wait for countdown to finish
    await page.waitForTimeout(3500);
    
    // Game should be running
    await expect(page.locator('.hud-time')).toBeVisible();
  });

  test('navigates back to single-player page', async ({ page }) => {
    // Click back button (using correct class from GameShell)
    await page.click('.gps-back-btn');
    
    // Should be on single-player page
    await expect(page).toHaveURL(/.*single-player/);
  });
});