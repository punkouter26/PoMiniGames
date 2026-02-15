/** Difficulty levels for AI opponents. */
export enum Difficulty {
  Easy = 'Easy',
  Medium = 'Medium',
  Hard = 'Hard',
}

/** Result of a completed game. */
export enum GameResult {
  InProgress = 'InProgress',
  Win = 'Win',
  Loss = 'Loss',
  Draw = 'Draw',
}

/** Cell value for Tic Tac Toe. */
export enum CellValue {
  None = 0,
  X = 1,
  O = 2,
}

/** Piece for Connect Five. */
export enum Piece {
  None = 0,
  Red = 1,
  Yellow = 2,
}

/** Statistics for a specific difficulty level. */
export interface DifficultyStats {
  wins: number;
  losses: number;
  draws: number;
  totalGames: number;
  winStreak: number;
  winRate: number;
}

/** Player statistics stored in localStorage / synced to API. */
export interface PlayerStats {
  playerId: string;
  playerName: string;
  easy: DifficultyStats;
  medium: DifficultyStats;
  hard: DifficultyStats;
  totalWins: number;
  totalLosses: number;
  totalDraws: number;
  totalGames: number;
  winRate: number;
  overallWinRate: number;
  createdAt: string;
  updatedAt: string;
}

/** DTO shape matching the .NET API response. */
export interface PlayerStatsDto {
  name: string;
  game: string;
  stats: PlayerStats;
}

/** Create empty difficulty stats. */
export function emptyDifficultyStats(): DifficultyStats {
  return { wins: 0, losses: 0, draws: 0, totalGames: 0, winStreak: 0, winRate: 0 };
}

/** Create empty player stats. */
export function emptyPlayerStats(playerName = '', playerId = ''): PlayerStats {
  return {
    playerId: playerId || generatePlayerId(),
    playerName,
    easy: emptyDifficultyStats(),
    medium: emptyDifficultyStats(),
    hard: emptyDifficultyStats(),
    totalWins: 0,
    totalLosses: 0,
    totalDraws: 0,
    totalGames: 0,
    winRate: 0,
    overallWinRate: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Generate a unique player ID for identity tracking across name changes. */
export function generatePlayerId(): string {
  return `po_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** Get or create the persistent player ID. */
export function getOrCreatePlayerId(): string {
  const STORAGE_KEY = 'pomini_player_id';
  let playerId = localStorage.getItem(STORAGE_KEY);
  if (!playerId) {
    playerId = generatePlayerId();
    localStorage.setItem(STORAGE_KEY, playerId);
  }
  return playerId;
}
