/**
 * po-types.ts — All shared TypeScript interfaces and enums for PoHorseRace.
 * All identifiers carry the `Po` prefix per FR-033.
 * These types are ephemeral (no persistence in v1.0); data-model.md is canonical.
 */

// ---------------------------------------------------------------------------
// PoRaceState (FSM)
// ---------------------------------------------------------------------------

/** Five discrete states for the race lifecycle (FR-001). */
export type PoRacePhase = 'Idle' | 'Countdown' | 'Racing' | 'Finished';

/** Runtime gameplay mode. */
export type PoGameMode = 'normal' | 'demo';

/**
 * Top-level finite state machine for a single game session.
 * State transitions: Idle → Countdown → Racing → Finished → Idle
 */
export interface PoRaceState {
  /** Current phase of the race lifecycle. */
  phase: PoRacePhase;
  /** Count-up stopwatch; increments at 1 Hz only while phase === 'Racing'. */
  elapsedSeconds: number;
  /** 3, 2, 1 during Countdown; null at all other times (FR-002). */
  countdownValue: number | null;
  /** Lane id 1–8 of the finishing horse; null until phase === 'Finished' (FR-004). */
  winnerLaneId: number | null;
}

// ---------------------------------------------------------------------------
// PoLane + PoLaneColor
// ---------------------------------------------------------------------------

/** Eight colour variants — one per lane (FR-033, clarification 2026-02-24). */
export type PoLaneColor =
  | 'PoRed'    // lane 1 — player (FR-014)
  | 'PoBlue'   // lane 2
  | 'PoYellow' // lane 3
  | 'PoGreen'  // lane 4
  | 'PoOrange' // lane 5
  | 'PoPurple' // lane 6
  | 'PoPink'   // lane 7
  | 'PoWhite'; // lane 8

/** One of eight physical channels. Only lane 1 is player-controlled in v1.0. */
export interface PoLane {
  /** 1–8; lane 1 = player. */
  id: number;
  color: PoLaneColor;
  /** Current horse position; clamped to [0, 60]. */
  positionInches: number;
  /** Cumulative points scored in this session. */
  score: number;
  /** 1–8 leaderboard rank; calculated by PoLeaderboard util. */
  rank: number;
  /** true only for lane 1 in v1.0 (FR-014). */
  isPlayerControlled: boolean;
  /** true when positionInches >= 60 (FR-004); persists until next Reset. */
  goldGlowActive: boolean;
}

// ---------------------------------------------------------------------------
// PoBall + PoBallPhase
// ---------------------------------------------------------------------------

/** Four lifecycle phases for each ball entity (FR-007, FR-010). */
export type PoBallPhase = 'InTrough' | 'InFlight' | 'Scoring' | 'Returning';

/** One of up to three active balls in the three-ball economy (FR-007). */
export interface PoBall {
  /** 0, 1, or 2. */
  id: number;
  /** Lane id 1–8 this ball belongs to. */
  laneId: number;
  phase: PoBallPhase;
  /** Playfield X coordinate in world units. */
  positionX: number;
  /** Playfield Y coordinate in world units. */
  positionY: number;
  /** current velocity component. */
  velocityX: number;
  /** current velocity component. */
  velocityY: number;
  /**
   * Impulse magnitude at swipe-release in mph; null before first roll.
   * Set once per roll in setReleaseSpeed(); also appended to
   * usePoBallStore.sessionReleaseSpeedsMph accumulator (H2 fix, FR-005).
   */
  releaseSpeedMph: number | null;
  /**
   * Countdown to chute return; exactly 3.0 when phase transitions to Scoring;
   * ticks down at 1 Hz; null when not Scoring (FR-010).
   */
  returnTimerSeconds: number | null;
}

// ---------------------------------------------------------------------------
// PoScoringHole + PoHoleRow
// ---------------------------------------------------------------------------

/** Four rows in the scoring-hole pyramid (4-3-2-1). */
export type PoHoleRow = 'Apex' | 'Row3' | 'Row2' | 'Base';

/** One of five target holes in the pyramid arrangement (FR-015). */
export interface PoScoringHole {
  /** 1–10. */
  id: number;
  row: PoHoleRow;
  /** Apex=5pt, Row2=3pt, Row3=2pt, Base=1pt. */
  pointValue: 1 | 2 | 3 | 5;
  /** true while a ball is circling the rim (FR-016). */
  rimCollisionActive: boolean;
  /** true for one tick when ball sensor fires (FR-010). */
  sensorTriggered: boolean;
}

// ---------------------------------------------------------------------------
// PoInchMarker
// ---------------------------------------------------------------------------

/** One of sixty ridges along the playfield (FR-017). */
export interface PoInchMarker {
  /** 1–60; position equals id inches from trough end. */
  id: number;
  /** true for one tick when a ball rolls over this marker (FR-024). */
  audioTriggered: boolean;
}

// ---------------------------------------------------------------------------
// PoDiegeticButton + PoDiegeticAction
// ---------------------------------------------------------------------------

/** Two in-world control buttons (FR-026, FR-027). */
export type PoDiegeticAction = 'RESET' | 'DIAG';

/** A 3D in-world control button. */
export interface PoDiegeticButton {
  label: PoDiegeticAction;
  /** 0.0 (up) → 1.0 (fully depressed); drives mesh Y offset (FR-027). */
  depressProgress: number;
  /** true during the depress animation frame; action fires at depressProgress === 1.0. */
  isPressed: boolean;
}

// ---------------------------------------------------------------------------
// PoHorse
// ---------------------------------------------------------------------------

/**
 * 3D horse primitive on the Horse Wall; driven by PoLane.positionInches
 * via a react-spring interpolator (C1 fix: spring lives in PoHorse.tsx, not store).
 */
export interface PoHorse {
  /** 1–8; mirrors PoLane.id. */
  laneId: number;
  /** mirrors PoLane.color. */
  color: PoLaneColor;
  /** Spring target; updated when PoLane.positionInches changes. */
  targetPositionInches: number;
  /** mirrors PoLane.goldGlowActive; drives Selective Bloom layer. */
  goldGlowActive: boolean;
}

// ---------------------------------------------------------------------------
// PoParticlePoof
// ---------------------------------------------------------------------------

/**
 * Single transient particle-burst event (FR-019). Not persisted; created at
 * score event and removed when all particles have faded.
 */
export interface PoParticlePoof {
  /** Unique per scoring event (timestamp + holeId). */
  id: string;
  /** World X of the scoring hole center. */
  originX: number;
  /** World Y of the scoring hole center; particles rise from here (FR-019). */
  originY: number;
  /** performance.now() timestamp at creation. */
  spawnedAt: number;
  /** e.g. 1200 ms; particles fade to opacity 0 before this elapses (FR-005 SC-005). */
  lifetimeMs: number;
}

// ---------------------------------------------------------------------------
// PoDiagSnapshot
// ---------------------------------------------------------------------------

/**
 * Point-in-time telemetry record for the /diag route (FR-028–FR-030).
 * Po-prefixed keys per FR-033. PII fields masked before render via PoMaskString.
 * Shape must conform to contracts/diag-snapshot.schema.json (additionalProperties: false).
 */
export interface PoDiagSnapshot {
  poCapturedAt: string;
  /** Frames per second at capture time. */
  poFps: number;
  /** Active Three.js geometries in the scene. */
  poGeometryCount: number;
  poHorsePositions: Array<{
    laneId: number;
    positionInches: number;
  }>;
  /**
   * MASKED before render: "P***2" format (FR-030).
   * Never pass raw value to JSX — apply PoMaskString first.
   */
  poSessionId: string;
  /**
   * MASKED before render; null if no authenticated user in v1.0.
   * Never pass raw value to JSX — apply PoMaskString first.
   */
  poUserId: string | null;
  /** Current race FSM phase at capture time (schema: poRacePhase). */
  poRacePhase: PoRacePhase;
  /** Stopwatch value in seconds at capture time; 0 when not Racing. */
  poElapsedSeconds: number;
}

// ---------------------------------------------------------------------------
// PoSummaryStats
// ---------------------------------------------------------------------------

/**
 * Calculated once when PoRaceState.phase transitions to 'Finished' (FR-005).
 * Stored in usePoRaceStore and rendered by PoSummaryCard.
 */
export interface PoSummaryStats {
  /** = PoRaceState.elapsedSeconds at finish time. */
  totalSprintTimeSeconds: number;
  /** (ballsScored / ballsThrown) * 100, rounded to 1 decimal place. */
  accuracyPercent: number;
  /** Mean of all sessionReleaseSpeedsMph values, rounded to 1dp (H2 fix). */
  avgRollSpeedMph: number;
}
