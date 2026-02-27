// @ts-check
import { test, expect } from './fixtures';

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
    // Verify SQLite config key is present
    const hasSqlite = json['Sqlite:DataDirectory'] !== undefined ||
                      json['Sqlite__DataDirectory'] !== undefined;
    expect(hasSqlite).toBeTruthy();
  });

  test('leaderboard endpoint returns 200', async ({ request }) => {
    const response = await request.get('/api/tictactoe/statistics/leaderboard');
    expect(response.ok()).toBeTruthy();
  });
});
