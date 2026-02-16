// @ts-check
import { test, expect } from '@playwright/test';

test.describe('API contract', () => {
  test('health ping returns pong', async ({ request }) => {
    const response = await request.get('/api/health/ping');
    expect(response.ok()).toBeTruthy();
    const text = await response.text();
    expect(text).toContain('pong');
  });

  test('diag endpoint returns JSON with config keys', async ({ request }) => {
    const response = await request.get('/diag');
    expect(response.ok()).toBeTruthy();
    const json = await response.json();
    // Verify that some known configuration keys exist (case-insensitive or mapped)
    const hasStorage = json.AZURE_STORAGE_ACCOUNT_NAME !== undefined || 
                       json["ConnectionStrings:Tables"] !== undefined ||
                       json["PoMiniGames:StorageAccountName"] !== undefined;
    expect(hasStorage).toBeTruthy();
  });

  test('leaderboard endpoint returns 200', async ({ request }) => {
    const response = await request.get('/api/tictactoe/statistics/leaderboard');
    expect(response.ok()).toBeTruthy();
  });
});
