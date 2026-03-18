// @ts-check
import { test as base, expect } from '@playwright/test';

const ALLOWED_CONSOLE_ERRORS = Symbol('allowedConsoleErrors');

export function allowConsoleErrors(page, patterns) {
  page[ALLOWED_CONSOLE_ERRORS] = patterns;
}

/**
 * Shared fixture that fails tests on browser runtime faults.
 *
 * It captures both uncaught runtime exceptions (`pageerror`) and
 * console-level errors (`console.error`) to keep failure signals consistent.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    /** @type {string[]} */
    const browserErrors = [];

    page.on('pageerror', (err) => {
      browserErrors.push(`[pageerror] ${err.message}`);
    });

    page.on('console', (msg) => {
      if (msg.type() !== 'error') {
        return;
      }

      const text = msg.text();
      const allowed = page[ALLOWED_CONSOLE_ERRORS] ?? [];
      const isAllowed = allowed.some((pattern) => (
        typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)
      ));

      if (!isAllowed) {
        browserErrors.push(`[console.error] ${text}`);
      }
    });

    await use(page);

    if (browserErrors.length > 0) {
      throw new Error(
        `${browserErrors.length} browser error(s) detected during test:\n` +
          browserErrors.map((entry) => `  • ${entry}`).join('\n'),
      );
    }
  },
});

export { expect };
