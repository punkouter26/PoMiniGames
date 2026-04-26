import * as signalR from '@microsoft/signalr';
import { state } from './state';
import { INITIALS_FORM_DELAY_MS } from './constants';
import { playSound, setRandomTheme } from './audioEngine';
import { recordRaceResult } from './profile';
import { renderStatsCard, renderLeaderboard } from './ui';
import type { GameState } from './state';
import type { HighScoreEntry, ServerPlayer } from './types';

// Static offline leaderboard — shown when the server is unavailable so the UI
// remains functional without a running backend.
const MOCK_SCORES: HighScoreEntry[] = [
    { rank: 1,  timeMs: 4231,  initials: 'ACE' },
    { rank: 2,  timeMs: 4892,  initials: 'PRO' },
    { rank: 3,  timeMs: 5140,  initials: 'BNZ' },
    { rank: 4,  timeMs: 5673,  initials: 'SWF' },
    { rank: 5,  timeMs: 6021,  initials: 'MPX' },
    { rank: 6,  timeMs: 6489,  initials: 'RUN' },
    { rank: 7,  timeMs: 6994,  initials: 'ZAP' },
    { rank: 8,  timeMs: 7512,  initials: 'FLY' },
    { rank: 9,  timeMs: 8243,  initials: 'QRT' },
    { rank: 10, timeMs: 10000, initials: '---' },
];

// VITE_HUB_URL is set in .env.production for deployed builds;
// falls back to the Vite dev-server proxy path (/gamehub) in local development.
const hubUrl = (import.meta as any).env?.VITE_HUB_URL || '/porunner/gamehub';

export const connection = new signalR.HubConnectionBuilder()
    .withUrl(hubUrl)
    .withAutomaticReconnect()
    .configureLogging(signalR.LogLevel.Information)
    .build();

connection.onreconnecting(() => {
    state.connectionError = 'Reconnecting to server…';
});
connection.onreconnected(() => {
    state.connectionError = '';
    state.connectionId = connection.connectionId;
});
connection.onclose(() => {
    state.connectionError = 'Connection lost. Click RECONNECT to try again.';
});

interface GameStateData {
    players: Record<string, ServerPlayer>;
    status: string;
    countdownStartTimeMs?: number;
    raceStartTimeMs?: number;
    finishedPlayerId?: string;
}

connection.on('gameState', (data: GameStateData) => {
    // Ignore server pushes while a local demo race is running
    if (state.demoMode) return;

    console.log(`[gameState] received status=${data.status}, players=${JSON.stringify(Object.keys(data.players || {}))}`);

    if (data.status === 'playing' && state.gameStatus !== 'playing') {
        state.comboIndex = 0;
        state.localSprite.action = 'idle';
        state.localSprite.frame = 0;
        state.localSprite.frameTimer = 0;
        state.qualifiesForHighScore = false;
        state.initialsFormAvailableAtMs = 0;
        state.confettiParticles = [];
        state.localCrossedFinish = false;
        state.localFinishTimeMs = 0;
        state.gameOverAnim = null;
        state.hintDismissed = false;
        state.leaderboardExpanded = false;
        state.raceTimedOut = false;
        setRandomTheme();
    }
    if (data.status === 'readycheck' || data.status === 'waiting') {
        state.localSprite.action = 'idle';
        state.qualifiesForHighScore = false;
        state.localSprite.frame = 0;
        state.localSprite.frameTimer = 0;
        state.initialsFormAvailableAtMs = 0;
        state.leaderboardExpanded = false;
        state.raceTimedOut = false;
    }
    state.serverPlayers = data.players;
    state.gameStatus = data.status as GameState['gameStatus'];
    state.countdownStartTimeMs = data.countdownStartTimeMs || 0;
    state.raceStartTimeMs = data.raceStartTimeMs || 0;
    state.finishedPlayerId = data.finishedPlayerId || '';
});

interface GameOverData {
    winnerId: string;
    players: Record<string, ServerPlayer>;
    timeMs: number;
    timedOut?: boolean;
    qualifiesForHighScore?: boolean;
}

connection.on('gameOver', (data: GameOverData) => {
    state.gameStatus = 'gameover';
    state.finishedPlayerId = data.winnerId;
    state.serverPlayers = data.players;
    state.lastRaceTimeMs = data.timeMs;
    state.raceTimedOut = !!data.timedOut;
    state.qualifiesForHighScore = !!data.qualifiesForHighScore && data.winnerId === connection.connectionId;
    state.initialsFormShown = false;
    state.initialsFormAvailableAtMs = Date.now() + INITIALS_FORM_DELAY_MS;

    const _iWon = data.winnerId === connection.connectionId;
    const _myTime = _iWon ? data.timeMs : (state.localCrossedFinish ? state.localFinishTimeMs : null);
    recordRaceResult(_iWon, _myTime);
    renderStatsCard();

    if (!state.localCrossedFinish) {
        playSound('crowd');
    }

    const _winnerPlayer = data.players[data.winnerId];
    const _loserEntry = Object.values(data.players).find(p => p.id !== data.winnerId);
    state.gameOverAnim = {
        spriteX: -300,
        frame: 0,
        frameTimer: 0,
        winnerIsTPose: _winnerPlayer?.colorTint?.toLowerCase() === 'blue',
        loserIsTPose: _loserEntry?.colorTint?.toLowerCase() === 'blue',
        loserExists: !!_loserEntry,
        done: false,
    };
});

connection.on('highScores', (scores: HighScoreEntry[]) => {
    state.topScores = (scores && scores.length > 0) ? scores : MOCK_SCORES;
    renderLeaderboard();
});

connection.on('error', (msg: string) => {
    state.connectionError = msg;
});

/** Open the SignalR connection and update state on success/failure. */
export async function start(): Promise<void> {
    // Only connect in multiplayer mode
    if (state.mode !== 'multi') return;

    try {
        await connection.start();
        console.log('SignalR Connected.');
        state.connectionError = '';
        state.connectionId = connection.connectionId;
    } catch (err) {
        state.connectionError = 'Failed to connect to server. Ensure Backend is running.';
        if (!state.topScores.length) {
            state.topScores = MOCK_SCORES;
            renderLeaderboard();
        }
        console.error(err);
    }
}