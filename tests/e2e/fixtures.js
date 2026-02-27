// @ts-check
import { test as base, expect } from '@playwright/test';

/**
 * Extended test fixture that automatically fails any test in which the browser
 * reports a JavaScript page-level error (window.onerror / unhandled rejections).
 *
 * Import `test` and `expect` from this file instead of `@playwright/test`
 * in every E2E spec to get automatic JS-error detection for free.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    /** @type {Error[]} */
    const jsErrors = [];
    page.on('pageerror', (err) => jsErrors.push(err));

    await use(page);

    // Report any errors collected during the test
    if (jsErrors.length > 0) {
      throw new Error(
        `${jsErrors.length} browser JS error(s) detected during test:\n` +
          jsErrors.map((e) => `  • ${e.message}`).join('\n'),
      );
    }
  },
});

export { expect };
