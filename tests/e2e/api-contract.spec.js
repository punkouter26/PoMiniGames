// @ts-check
import { test, expect } from '@playwright/test';

test.describe('API contract', () => {
  test('health ping returns pong', async ({ request }) => {
    const response = await request.get('/api/health/ping');
    expect(response.ok()).toBeTruthy();
    const text = await response.text();
    expect(text).toContain('pong');
  });

  test('diag endpoint returns JSON with environment', async ({ request }) => {
    const response = await request.get('/api/diag');
    expect(response.ok()).toBeTruthy();
    const json = await response.json();
    expect(json.environment).toBeDefined();
  });

  test('leaderboard endpoint returns 200', async ({ request }) => {
    const response = await request.get('/api/tictactoe/statistics/leaderboard');
    expect(response.ok()).toBeTruthy();
  });
});
