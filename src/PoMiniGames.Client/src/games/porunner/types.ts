// ── Player representation (shared client/server) ──────────────────────────────
export interface ServerPlayer {
  id: string;
  x: number;
  y: number;
  direction: 'east' | 'west' | 'north' | 'south';
  action: 'idle' | 'walk';
  currentFrame: number;
  colorTint: string;
  isReady: boolean;
}

// ── Confetti particle ──────────────────────────────────────────────────────────
export interface ConfettiParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  w: number;
  h: number;
  rot: number;
  rotSpeed: number;
  life: number;
  decay: number;
}

// ── Game-over victory walk animation state ─────────────────────────────────────
export interface GameOverAnim {
  spriteX: number;
  frame: number;
  frameTimer: number;
  winnerIsTPose: boolean;
  loserIsTPose: boolean;
  loserExists: boolean;
  done: boolean;
}

// ── Demo bot internal state ────────────────────────────────────────────────────
export interface DemoBot {
  id: string;
  baseSpeed: number;
  currentSpeed: number;
  burstTimer: number;
  frameTimer: number;
  walkFrame: number;
  finished: boolean;
}

// ── Leaderboard entry ──────────────────────────────────────────────────────────
export interface HighScoreEntry {
  rank: number;
  timeMs: number;
  initials: string;
}

// ── Persistent player profile ──────────────────────────────────────────────────
export interface PlayerProfile {
  initials: string;
  personalBestMs: number | null;
  wins: number;
  losses: number;
  winStreak: number;
  currentStreak: number;
}

// ── Local sprite animation state ───────────────────────────────────────────────
export interface LocalSprite {
  action: 'idle' | 'walk';
  frame: number;
  frameTimer: number;
}