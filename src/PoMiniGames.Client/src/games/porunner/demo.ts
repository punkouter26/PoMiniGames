/**
 * Demo Mode — 8 CPU-controlled bots race autonomously.
 * Entirely client-side; no server calls are made.
 * Activated automatically when state.mode === 'demo'.
 */
import { state } from './state';
import { START_LINE_X, MAX_RACE_DURATION_MS } from './constants';
import { TPOSE_WALK_FRAMES } from './constants';
import { BANANA_WALK_FRAMES } from './constants';
import { playSound, setRandomTheme } from './audioEngine';
import { spawnConfetti } from './renderer';
import type { DemoBot } from './types';

const DEMO_COLORS = ['yellow', 'blue', 'red', 'green', 'purple', 'orange', 'pink', 'teal'];
const DEMO_SPEED_MIN = 60;
const DEMO_SPEED_MAX = 130;
const BOT_COUNT = 8;
const BURST_INTERVAL = 1.5;
const BURST_VARIANCE = 0.35;
const AUTO_RESTART_DELAY_MS = 4000;

let _bots: DemoBot[] = [];
let _autoRestartAt = 0;
let _savedConnectionId: string | null = null;

export function startDemo(): void {
    state.demoMode = true;

    if (!_savedConnectionId) {
        _savedConnectionId = state.connectionId;
    }

    state.connectionId = 'demo_0';

    _bots = [];
    _autoRestartAt = 0;
    state.serverPlayers = {};
    for (let i = 0; i < BOT_COUNT; i++) {
        const id = `demo_${i}`;
        const baseSpeed = DEMO_SPEED_MIN + Math.random() * (DEMO_SPEED_MAX - DEMO_SPEED_MIN);
        const startX = START_LINE_X - Math.random() * 30;
        _bots.push({
            id,
            baseSpeed,
            currentSpeed: baseSpeed,
            burstTimer: Math.random() * BURST_INTERVAL,
            frameTimer: 0,
            walkFrame: 0,
            finished: false,
        });
        state.serverPlayers[id] = {
            id,
            x: startX,
            y: i,
            direction: 'east',
            action: 'walk',
            currentFrame: 0,
            colorTint: DEMO_COLORS[i] ?? 'yellow',
            isReady: true,
        };
    }

    const now = Date.now();
    state.countdownStartTimeMs = now;
    state.raceStartTimeMs = now + 3000;
    state.gameStatus = 'countdown';

    state.finishedPlayerId = '';
    state.lastRaceTimeMs = 0;
    state.raceTimedOut = false;
    state.qualifiesForHighScore = false;
    state.localCrossedFinish = false;
    state.localFinishTimeMs = 0;
    state.confettiParticles = [];
    state.gameOverAnim = null;
    state.comboIndex = 0;
    state.countdownGunFired = false;
    state.lastBeepSec = -1;
    state.cameraX = 0;
    state.hintDismissed = true;
    state.leaderboardExpanded = false;

    setRandomTheme();
}

export function updateDemo(dt: number): void {
    if (!state.demoMode) return;

    const now = Date.now();

    if (state.gameStatus === 'gameover' && _autoRestartAt > 0 && now >= _autoRestartAt) {
        const animDone = !state.gameOverAnim || state.gameOverAnim.done;
        if (animDone) {
            startDemo();
            return;
        }
    }

    if (state.gameStatus === 'countdown' && now >= state.raceStartTimeMs) {
        state.gameStatus = 'playing';
    }

    if (state.gameStatus !== 'playing') return;

    const raceElapsedMs = now - state.raceStartTimeMs;

    for (const bot of _bots) {
        if (bot.finished) continue;

        const player = state.serverPlayers[bot.id];
        if (!player) continue;

        bot.burstTimer -= dt;
        if (bot.burstTimer <= 0) {
            bot.burstTimer = BURST_INTERVAL * (0.5 + Math.random());
            const variance = 1 + (Math.random() * 2 - 1) * BURST_VARIANCE;
            bot.currentSpeed = bot.baseSpeed * variance;
        }

        player.x += bot.currentSpeed * dt;

        bot.frameTimer += dt;
        const isTPose = player.colorTint === 'blue';
        const maxFrames = isTPose ? TPOSE_WALK_FRAMES : BANANA_WALK_FRAMES;
        if (bot.frameTimer >= 1 / 12) {
            bot.frameTimer -= 1 / 12;
            bot.walkFrame = (bot.walkFrame + 1) % maxFrames;
        }
        player.currentFrame = bot.walkFrame;

        if (player.x >= state.finishLineX) {
            player.x = state.finishLineX;
            player.action = 'idle';
            bot.finished = true;

            if (!state.finishedPlayerId) {
                state.finishedPlayerId = bot.id;
                state.lastRaceTimeMs = raceElapsedMs;
                state.raceTimedOut = false;
                state.gameStatus = 'gameover';
                state.qualifiesForHighScore = false;

                playSound('crowd');
                spawnConfetti();

                const winnerPlayer = state.serverPlayers[bot.id];
                const loserEntry = Object.values(state.serverPlayers).find(p => p.id !== bot.id);
                state.gameOverAnim = {
                    spriteX: -300,
                    frame: 0,
                    frameTimer: 0,
                    winnerIsTPose: winnerPlayer?.colorTint === 'blue',
                    loserIsTPose: loserEntry?.colorTint === 'blue',
                    loserExists: !!loserEntry,
                    done: false,
                };
                _autoRestartAt = Date.now() + AUTO_RESTART_DELAY_MS;
                return;
            }
        }
    }

    if (!state.finishedPlayerId && raceElapsedMs >= MAX_RACE_DURATION_MS) {
        const leader = _bots.reduce((best, b) => {
            const px = state.serverPlayers[b.id]?.x ?? 0;
            return px > (state.serverPlayers[best.id]?.x ?? 0) ? b : best;
        }, _bots[0]!);

        state.finishedPlayerId = leader?.id ?? '';
        state.lastRaceTimeMs = MAX_RACE_DURATION_MS;
        state.raceTimedOut = true;
        state.gameStatus = 'gameover';
        state.qualifiesForHighScore = false;

        playSound('crowd');
        spawnConfetti();

        const winnerPlayer = leader ? state.serverPlayers[leader.id] : null;
        const loserEntry = Object.values(state.serverPlayers).find(p => p.id !== leader?.id);
        state.gameOverAnim = {
            spriteX: -300,
            frame: 0,
            frameTimer: 0,
            winnerIsTPose: winnerPlayer?.colorTint === 'blue',
            loserIsTPose: loserEntry?.colorTint === 'blue',
            loserExists: !!loserEntry,
            done: false,
        };
        _autoRestartAt = Date.now() + AUTO_RESTART_DELAY_MS;
    }
}

export function stopDemo(): void {
    state.demoMode = false;
    state.connectionId = _savedConnectionId;
    _savedConnectionId = null;
    state.serverPlayers = {};
    state.gameStatus = 'waiting';
    state.finishedPlayerId = '';
    state.lastRaceTimeMs = 0;
    state.qualifiesForHighScore = false;
    state.localCrossedFinish = false;
    state.localFinishTimeMs = 0;
    state.confettiParticles = [];
    state.gameOverAnim = null;
    state.countdownGunFired = false;
    state.lastBeepSec = -1;
    state.cameraX = 0;
    state.hintDismissed = false;
    _bots = [];
    _autoRestartAt = 0;
}