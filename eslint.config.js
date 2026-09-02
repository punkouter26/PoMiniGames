import js from '@eslint/js';
import globals from 'globals';

// Flat config (ESLint 10). Scope is deliberately the PoEcosystem sim + its
// tests only: the older engines under wwwroot/js were never linted and would
// need their own baseline before being pulled in.
export default [
  js.configs.recommended,
  {
    files: ['src/PoMiniGames.Client/wwwroot/js/poecosystem/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      'eqeqeq': ['error', 'smart'],
    },
  },
  {
    // Determinism gate: nothing under sim/ may consult Math.random — every draw
    // goes through the seeded streams in sim/core/prng.js.
    files: ['src/PoMiniGames.Client/wwwroot/js/poecosystem/sim/**/*.js'],
    rules: {
      'no-restricted-properties': ['error', {
        object: 'Math', property: 'random',
        message: 'Use the seeded PRNG streams (sim/core/prng.js) so worlds stay reproducible.',
      }],
      'no-restricted-globals': ['error', 'window', 'document', 'navigator'],
    },
  },
  {
    files: ['tests/PoEcosystem.Sim/**/*.js', 'vitest.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
