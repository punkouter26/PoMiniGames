// Browser-side Playwright test for all demo games
// Usage: this script is run via the run_playwright_code tool on the active page.

const url = page.url();
const viewport = page.viewportSize();
const title = await page.title();
const main = await page.evaluate(() => {
  const m = document.querySelector('main');
  if (!m) return null;
  const r = m.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, scroll: document.documentElement.scrollHeight };
});
const kiosk = await page.evaluate(() => {
  const ks = document.querySelector('[class*="kiosk"], [class*="Kiosk"]');
  return ks ? { tag: ks.tagName, cls: ks.className } : null;
});
const overflow = await page.evaluate(() => {
  return { x: document.documentElement.scrollWidth, y: document.documentElement.scrollHeight, vw: window.innerWidth, vh: window.innerHeight };
});
const hasDemoBadge = await page.evaluate(() => !!document.body.textContent.includes('Demo mode'));
const hasGuest = await page.evaluate(() => !!document.body.textContent.includes('Guest'));
return { url, viewport, title, main, kiosk, overflow, hasDemoBadge, hasGuest };