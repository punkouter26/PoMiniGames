import { test, expect } from './fixtures';

test('home page exposes the current game navigation', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'PoMiniGames' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play 2 players' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play 1 player' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play demo mode' })).toBeVisible();
});

test('PoDropSquare route loads game content', async ({ page }) => {
  await page.goto('/podropsquare');

  await expect(page.getByRole('button', { name: /Start/i })).toBeVisible();
  await expect(page.getByText(/Drop Square/i).first()).toBeVisible();
});

test('PoRaceRagdoll route loads race setup content', async ({ page }) => {
  await page.goto('/poraceragdoll');

  await expect(page.getByText(/PoRaceRagdoll/i).first()).toBeVisible();
  await expect(page.getByText(/Choose Your Champion/i)).toBeVisible();
});