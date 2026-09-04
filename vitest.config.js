import { defineConfig } from 'vitest/config';

// Vitest covers the pure simulation modules that do not need a DOM. Browser-
// bound WebGL engine code remains exercised by the E2E-UI tier.
export default defineConfig({
  test: {
    include: ['tests/PoEcosystem.Sim/**/*.test.js', 'tests/SandPlayground.Sim/**/*.test.js'],
    environment: 'node',
    // LONG=1 unlocks the multi-minute population runs (see plan CP-C).
    testTimeout: process.env.LONG ? 600_000 : 20_000,
    coverage: {
      provider: 'v8',
      include: [
        'src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/**/*.js',
        'src/PoMiniGames.Client/wwwroot/js/sand-playground-calibration.js',
      ],
      reporter: ['text', 'lcov', 'cobertura'],
      reportsDirectory: 'coverage/poecosystem',
      thresholds: { lines: 80 },
    },
  },
});
