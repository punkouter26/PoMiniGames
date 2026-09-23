// pobrawlTape.js — the live half of PoBrawl's tale-of-the-tape card: a portrait from
// Wikipedia's page-summary endpoint. The facts on the card are static
// (Games/PoBrawl/PoBrawlTape.cs); this only fetches the picture.
//
// Same rules as PoEcosystem's naturalist.js: `credentials: 'omit'` (a third-party
// origin never sees the app's cookies), never through the app HttpClient (whose
// handler pipeline is built for OUR origin — antiforgery, credentials, retry), and
// every failure degrades to null so the card simply renders without a portrait.

const TIMEOUT_MS = 4000;
const cache = new Map(); // title → Promise<{ thumbnail, description } | null>

export function summary(title) {
  if (!title || typeof title !== 'string') return Promise.resolve(null);
  if (!cache.has(title)) cache.set(title, load(title));
  return cache.get(title);
}

async function load(title) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const page = await res.json();
    const thumbnail = typeof page?.thumbnail?.source === 'string' ? page.thumbnail.source : '';
    // Only ever render an image from Wikimedia's own media hosts (the summary API serves
    // thumbnails from thumb.wikimedia.org; older responses used upload.wikimedia.org).
    const safeThumb = /^https:\/\/(thumb|upload)\.wikimedia\.org\//.test(thumbnail) ? thumbnail : '';
    return {
      thumbnail: safeThumb,
      description: String(page?.description ?? '').slice(0, 140),
    };
  } catch {
    // Offline, blocked, timed out: the card stands on its static facts.
    cache.delete(title); // let a later visit retry
    return null;
  } finally {
    clearTimeout(timer);
  }
}
