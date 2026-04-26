import { MODE, type GameMode, MIN_WORLD_WIDTH, START_LINE_X } from './constants';
import type { ConfettiParticle, GameOverAnim, HighScoreEntry, LocalSprite, ServerPlayer } from './types';

export interface GameState {
  // ── Mode ────────────────────────────────────────────────────────────────────
  mode: GameMode;

  // ── Network ──────────────────────────────────────────────────────────────────
  connectionId: string | null;
  connectionError: string;

  // ── Game logic ───────────────────────────────────────────────────────────────
  serverPlayers: Record<string, ServerPlayer>;
  gameStatus: 'waiting' | 'readycheck' | 'countdown' | 'playing' | 'gameover';
  countdownStartTimeMs: number;
  raceStartTimeMs: number;
  finishedPlayerId: string;
  lastRaceTimeMs: number;
  raceTimedOut: boolean;

  // ── High scores ──────────────────────────────────────────────────────────────
  topScores: HighScoreEntry[];
  qualifiesForHighScore: boolean;
  initialsFormShown: boolean;
  initialsFormAvailableAtMs: number;
  leaderboardExpanded: boolean;

  // ── Input / combo ────────────────────────────────────────────────────────────
  comboIndex: number;
  /** P2 combo index for local 2-player mode */
  comboIndex2: number;
  hintDismissed: boolean;

  // ── Local sprite state ───────────────────────────────────────────────────────
  localSprite: LocalSprite;
  /** P2 local sprite for local 2-player mode */
  localSprite2: LocalSprite;
  tPoseFrame: number;

  // ── Effects ──────────────────────────────────────────────────────────────────
  confettiParticles: ConfettiParticle[];
  localCrossedFinish: boolean;
  localFinishTimeMs: number;
  gameOverAnim: GameOverAnim | null;

  // ── Camera ────────────────────────────────────────────────────────────────────
  cameraX: number;

  // ── World / viewport ──────────────────────────────────────────────────────────
  worldWidth: number;
  readonly finishLineX: number;

  // ── Countdown audio timing ───────────────────────────────────────────────────
  lastBeepSec: number;
  countdownGunFired: boolean;

  // ── Asset loading ────────────────────────────────────────────────────────────
  assetsLoaded: boolean;

  // ── Demo mode ────────────────────────────────────────────────────────────────
  demoMode: boolean;

  // ── 2P local tracking ────────────────────────────────────────────────────────
  /** True when P2 crosses the finish line in local 2P mode. */
  localCrossedFinish2: boolean;
  localFinishTimeMs2: number;
}

const _state: GameState = {
  mode: MODE,

  connectionId: null,
  connectionError: '',

  serverPlayers: {},
  gameStatus: 'waiting',
  countdownStartTimeMs: 0,
  raceStartTimeMs: 0,
  finishedPlayerId: '',
  lastRaceTimeMs: 0,
  raceTimedOut: false,

  topScores: [],
  qualifiesForHighScore: false,
  initialsFormShown: false,
  initialsFormAvailableAtMs: 0,
  leaderboardExpanded: false,

  comboIndex: 0,
  comboIndex2: 0,
  hintDismissed: MODE === 'demo',

  localSprite: { action: 'idle', frame: 0, frameTimer: 0 },
  localSprite2: { action: 'idle', frame: 0, frameTimer: 0 },
  tPoseFrame: 0,

  confettiParticles: [],
  localCrossedFinish: false,
  localFinishTimeMs: 0,
  gameOverAnim: null,

  cameraX: 0,

  worldWidth: Math.max(MIN_WORLD_WIDTH, window.innerWidth),
  get finishLineX(): number {
    return this.worldWidth - START_LINE_X;
  },

  lastBeepSec: -1,
  countdownGunFired: false,

  assetsLoaded: false,

  demoMode: MODE === 'demo',

  localCrossedFinish2: false,
  localFinishTimeMs2: 0,
};

export const state = _state;