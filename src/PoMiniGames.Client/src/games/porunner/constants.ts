// ── Game mode ─────────────────────────────────────────────────────────────────
/** Injected by the React wrapper before the game module loads. */
export type GameMode = '1p' | '2p' | 'multi' | 'demo';
export const MODE = (typeof window !== 'undefined' ? (window as any).__poRunnerMode : null) as GameMode ?? '1p';

// ── Game mechanics ────────────────────────────────────────────────────────────
/** Ordered key sequence the player must type to move forward. */
export const COMBO = ['t', 'y', 'g', 'h'] as const;
/** P2 key combo for local 2-player mode. */
export const COMBO_P2 = ['q', 'w', 'e', 'r'] as const;
/** Pixels added to the player's X position on each completed combo. */
export const JUMP_PX = 60;
/** Animation frame-rate for the banana-suit walk cycle. */
export const WALK_FPS = 12;
/** Number of frames in the banana-suit walk animation. */
export const BANANA_WALK_FRAMES = 6;
/** Number of frames in the t-pose run animation. */
export const TPOSE_WALK_FRAMES = 8;

// ── World geometry ─────────────────────────────────────────────────────────────
/** X position of the start line in world-space pixels. */
export const START_LINE_X = 150;
/** Minimum world width regardless of viewport. */
export const MIN_WORLD_WIDTH = 1200;
/** Fraction of screen height occupied by the scrolling ground tile. */
export const GROUND_HEIGHT_RATIO = 0.35;
/** Sprites are rendered this many px below the top of the ground band. */
export const PLAYER_BASE_Y_OFFSET = 130;

// ── Sprite rendering ───────────────────────────────────────────────────────────
/** Draw scale multiplier for the banana-suit character. */
export const BANANA_SCALE = 3;
/** Draw scale multiplier for the t-pose character (sprites are 160×160px). */
export const TPOSE_SCALE = 1.8;

// ── Camera ─────────────────────────────────────────────────────────────────────
/** If the camera needs to move more than this many px, snap instead of lerp. */
export const CAMERA_SNAP_THRESHOLD = 200;
/** Linear interpolation factor applied to the camera each frame. */
export const CAMERA_LERP = 0.1;

// ── Confetti ───────────────────────────────────────────────────────────────────
/** Number of confetti particles spawned when the local player crosses the finish line. */
export const CONFETTI_COUNT = 90;
/** Palette used when choosing a random confetti colour. */
export const CONFETTI_COLORS = ['#fcd34d', '#10b981', '#3b82f6', '#f87171', '#a78bfa', '#fb923c'];

// ── UI timings ─────────────────────────────────────────────────────────────────
/** Delay after gameOver before the initials entry form is shown (ms). */
export const INITIALS_FORM_DELAY_MS = 1000;
/** Maximum race duration in milliseconds. A race not finished within this window is declared over. */
export const MAX_RACE_DURATION_MS = 20_000;

// ── Player colour palette ──────────────────────────────────────────────────────
/** Maps each PlayerColor name (lowercase) to a CSS colour used in UI overlays. */
export const PLAYER_COLOR_MAP: Record<string, string> = {
    yellow: '#fcd34d',
    blue: '#3b82f6',
    red: '#ef4444',
    green: '#22c55e',
    purple: '#a855f7',
    orange: '#f97316',
    pink: '#ec4899',
    teal: '#14b8a6',
};

/**
 * Degrees to rotate the banana-suit sprite hue for each player colour.
 * Banana-suit yellow sits at ~46° on the HSL wheel; these offsets shift it
 * to the target colour while preserving the sprite's natural shading.
 * Blue players use the T-pose sprite so they don't need an entry here.
 */
export const COLOR_HUE_ROTATE: Record<string, number> = {
    yellow: 0,
    red: -46,
    green: 96,
    purple: 225,
    orange: -21,
    pink: 284,
    teal: 128,
};

// ── Game-over victory walk ─────────────────────────────────────────────────────
/** Speed at which the winning sprite walks in from the left edge (px/s). */
export const GAMEOVER_WALK_SPEED = 200;
/** X position the winner sprite targets as a fraction of canvas width. */
export const WINNER_X_RATIO = 0.35;
/** X position of the dejected loser sprite as a fraction of canvas width. */
export const LOSER_X_RATIO = 0.72;