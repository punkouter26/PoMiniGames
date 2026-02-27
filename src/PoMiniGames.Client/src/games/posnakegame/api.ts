/**
 * PoSnakeGame API client — embedded inside PoMiniGames.
 * The Vite dev server proxies /api → http://localhost:5000,
 * so these calls hit the PoMiniGames .NET backend.
 */

const BASE = '/api/snake/highscores';
const LOCAL_KEY = 'posnakegame_highscores';

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* ignore */ }
}

async function safeFetch(url: string, options?: RequestInit): Promise<Response | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch {
    return null;
  }
}

export interface SnakeHighScore {
  initials: string;
  score: number;
  date: string;
  gameDuration: number;
  snakeLength: number;
  foodEaten: number;
}

/** Fetch top high scores; falls back to localStorage if the API is offline. */
export async function getHighScores(): Promise<SnakeHighScore[]> {
  const res = await safeFetch(BASE);
  if (res?.ok) {
    const data = (await res.json()) as SnakeHighScore[];
    writeLocal(LOCAL_KEY, data);
    return data;
  }
  return readLocal<SnakeHighScore[]>(LOCAL_KEY, []);
}

/** Submit a high score; stores locally if the API is offline. */
export async function submitHighScore(
  entry: Omit<SnakeHighScore, 'date'>,
): Promise<SnakeHighScore | null> {
  const full: SnakeHighScore = { ...entry, date: new Date().toISOString() };
  const res = await safeFetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(full),
  });
  if (res?.ok) {
    return (await res.json()) as SnakeHighScore;
  }
  // Offline fallback
  const existing = readLocal<SnakeHighScore[]>(LOCAL_KEY, []);
  existing.push(full);
  existing.sort((a, b) => b.score - a.score);
  writeLocal(LOCAL_KEY, existing.slice(0, 20));
  console.info('[PoSnakeGame] High score saved locally (offline mode)');
  return full;
}
