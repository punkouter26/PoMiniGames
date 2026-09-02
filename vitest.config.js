import { defineConfig } from 'vitest/config';

// Vitest covers only the PoEcosystem simulation (pure ES modules, no DOM). The
// rest of wwwroot/js is browser-bound engine code exercised by the E2E-UI tier.
export default defineConfig({
  test: {
    include: ['tests/PoEcosystem.Sim/**/*.test.js'],
    environment: 'node',
    // LONG=1 unlocks the multi-minute population runs (see plan CP-C).
    testTimeout: process.env.LONG ? 600_000 : 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/**/*.js'],
      reporter: ['text', 'lcov', 'cobertura'],
      reportsDirectory: 'coverage/poecosystem',
      thresholds: { lines: 80 },
    },
  },
});
