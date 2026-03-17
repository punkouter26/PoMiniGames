import { apiService, type SnakeHighScore } from '../shared/apiService';

export type { SnakeHighScore };

const LOCAL_KEY = 'posnakegame_highscores';

function readLocal(): SnakeHighScore[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as SnakeHighScore[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(scores: SnakeHighScore[]): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(scores));
  } catch { /* ignore */ }
}

/** Fetch top high scores; falls back to localStorage if the API is offline. */
export async function getHighScores(): Promise<SnakeHighScore[]> {
  const data = await apiService.getSnakeHighScores();
  if (data) {
    writeLocal(data);
    return data;
  }
  return readLocal();
}

/** Submit a high score; stores locally if the API is offline. */
export async function submitHighScore(
  entry: Omit<SnakeHighScore, 'date'>,
): Promise<SnakeHighScore | null> {
  const result = await apiService.submitSnakeHighScore(entry);
  if (result) return result;

  // Offline fallback
  const full: SnakeHighScore = { ...entry, date: new Date().toISOString() };
  const existing = readLocal();
  existing.push(full);
  existing.sort((a, b) => b.score - a.score);
  writeLocal(existing.slice(0, 20));
  return full;
}
