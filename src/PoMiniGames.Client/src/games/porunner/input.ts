import * as signalR from '@microsoft/signalr';
import { state } from './state';
import { COMBO, COMBO_P2, JUMP_PX } from './constants';
import { playSound, getAudioCtx } from './audioEngine';
import { saveInitials } from './profile';
import { connection, start } from './signalr';
import { spawnConfetti } from './renderer';
import { startDemo, stopDemo } from './demo';


let _inputInitialized = false;

export function initInput(): void {
    if (_inputInitialized) return;
    _inputInitialized = true;

    // ── Keyboard movement ────────────────────────────────────────────────────
    window.addEventListener('keydown', (e) => {
        // Exit demo mode on any key press
        if (state.demoMode) {
            if (state.gameStatus === 'playing' || state.gameStatus === 'countdown') {
                stopDemo();
            }
            return;
        }

        // Enter key: start solo/2P race from lobby
        if (e.key === 'Enter' && (state.mode === '1p' || state.mode === '2p')) {
            if (state.gameStatus === 'waiting' || state.gameStatus === 'readycheck') {
                startLocalRace();
            }
            return;
        }

        if (getAudioCtx().state === 'suspended') getAudioCtx().resume();
        if (state.gameStatus !== 'playing') return;
        if (e.repeat) return;

        const k = e.key.toLowerCase();

        // ── P2 keys (local 2P mode) ─────────────────────────────────────────
        if (state.mode === '2p') {
            const p2Combo = COMBO_P2 as readonly string[];
            if (k === p2Combo[state.comboIndex2]) {
                state.comboIndex2++;
                if (state.comboIndex2 >= p2Combo.length) {
                    state.comboIndex2 = 0;
                    // Move P2
                    const p2 = state.serverPlayers['local_p2'];
                    if (p2) {
                        p2.x += JUMP_PX;
                        p2.action = 'walk';
                        p2.currentFrame = 0;

                        // Animate P2
                        const isP2TPose = p2.colorTint?.toLowerCase() === 'blue';
                        if (!isP2TPose) {
                            state.localSprite2.action = 'walk';
                            state.localSprite2.frame = 0;
                            state.localSprite2.frameTimer = 0;
                        }

                        // P2 finish check
                        if (p2.x >= state.finishLineX) {
                            p2.x = state.finishLineX;
                            if (!state.localCrossedFinish2) {
                                state.localCrossedFinish2 = true;
                                state.localFinishTimeMs2 = Date.now() - state.raceStartTimeMs;
                                // If no winner yet, P2 wins
                                handleLocalFinish('local_p2');
                            }
                        }
                    }
                }
                return;
            } else if (/^[a-z]$/.test(k) && k !== COMBO[state.comboIndex]) {
                // Reset P2 combo on wrong key (but not if it starts P1 combo)
                const p2ComboArr = COMBO_P2 as readonly string[];
                if (!p2ComboArr.includes(k)) {
                    state.comboIndex2 = 0;
                }
            }
        }

        // ── P1 combo ─────────────────────────────────────────────────────────
        const combo = COMBO as readonly string[];
        // Wrong key — flash red, fart + buzz, reset combo progress
        if (k !== combo[state.comboIndex]) {
            if (/^[a-z]$/.test(k)) {
                state.comboIndex = 0;
                playSound('fart');
                playSound('wrong');
                const container = document.getElementById('game-container');
                if (container) {
                    container.classList.remove('flash-red');
                    void container.offsetWidth;
                    container.classList.add('flash-red');
                }
            }
            return;
        }

        state.comboIndex++;

        // Not yet a full combo — just update the highlight indicator
        if (state.comboIndex < combo.length) return;

        // Full combo completed — reset, advance player, animate
        state.comboIndex = 0;

        if (!state.hintDismissed) {
            state.hintDismissed = true;
            const controlsHint = document.getElementById('controls-hint');
            if (controlsHint) controlsHint.classList.add('hidden');
        }

        const myPlayer = state.serverPlayers[state.connectionId ?? ''];
        if (!myPlayer) return;

        // Banana suit animation
        const isLocalTPose = myPlayer.colorTint?.toLowerCase() === 'blue';
        if (isLocalTPose) {
            state.tPoseFrame++;
        } else {
            state.localSprite.action = 'walk';
            state.localSprite.frame = 0;
            state.localSprite.frameTimer = 0;
        }

        myPlayer.x += JUMP_PX;

        // SignalR multiplayer: send update to server
        if (state.mode === 'multi' && connection.state === signalR.HubConnectionState.Connected) {
            connection.invoke('PlayerUpdate', {
                x: myPlayer.x,
                y: myPlayer.y,
                direction: myPlayer.direction,
                action: 'Walk',
                currentFrame: 0,
            }).catch(err => console.error(err));
        }

        // Local finish line check
        if (myPlayer.x >= state.finishLineX) {
            myPlayer.x = state.finishLineX;
            if (!state.localCrossedFinish) {
                state.localCrossedFinish = true;
                state.localFinishTimeMs = Date.now() - state.raceStartTimeMs;
                playSound('crowd');
                spawnConfetti();
            }
            // SignalR: notify server
            if (state.mode === 'multi' && connection.state === signalR.HubConnectionState.Connected) {
                connection.invoke('PlayerFinished');
            }
            // Local modes: handle game over
            if (state.mode === '1p' || state.mode === '2p') {
                handleLocalFinish(state.connectionId ?? '');
            }
        }
    });

    // ── Lobby buttons ────────────────────────────────────────────────────────
    const btnRestart = document.getElementById('btn-restart');
    const btnReconnect = document.getElementById('btn-reconnect');

    btnReconnect?.addEventListener('click', () => {
        state.connectionError = '';
        start();
    });

    // Multiplayer: READY / RACE SOLO button
    const btnReady = document.getElementById('btn-ready');
    btnReady?.addEventListener('click', () => {
        if (getAudioCtx().state === 'suspended') getAudioCtx().resume();
        if (state.mode !== 'multi') return;
        if (state.gameStatus !== 'readycheck' && state.gameStatus !== 'waiting') return;
        const opponentJoined = Object.keys(state.serverPlayers).length >= 2;
        if (opponentJoined) {
            connection.invoke('PlayerReady').catch(err => console.error('[Ready] PlayerReady failed:', err));
        } else {
            if (connection.state !== signalR.HubConnectionState.Connected) {
                console.warn('[Solo] Not connected — starting demo mode as offline fallback');
                startDemo();
                return;
            }
            connection.invoke('SoloReady').catch(err => console.error('[Solo] SoloReady failed:', err));
        }
    });

    btnRestart?.addEventListener('click', () => {
        if (state.gameStatus === 'gameover') {
            if (state.demoMode) {
                stopDemo();
            } else if (state.mode === 'multi') {
                connection.invoke('RequestRestart');
            } else {
                // 1P or 2P: reset to lobby
                resetLocalRace();
            }
        }
    });

    // ── Leaderboard toggle ───────────────────────────────────────────────────
    const leaderboardBodyWrap = document.getElementById('leaderboard-body-wrap');
    const btnToggleLeaderboard = document.getElementById('btn-toggle-leaderboard');

    if (btnToggleLeaderboard && leaderboardBodyWrap) {
        btnToggleLeaderboard.addEventListener('click', () => {
            leaderboardBodyWrap.classList.toggle('hidden');
            state.leaderboardExpanded = !leaderboardBodyWrap.classList.contains('hidden');
            btnToggleLeaderboard.textContent = state.leaderboardExpanded
                ? '🏅 Hide Top 10 ▾'
                : '🏅 View Top 10 ▸';
        });
    }

    // ── Initials entry form ──────────────────────────────────────────────────
    const initialsForm = document.getElementById('initials-form');
    const initialBoxes: (HTMLInputElement | null)[] = [0, 1, 2].map(i => document.getElementById(`initial-${i}`) as HTMLInputElement | null);
    const btnSubmitInitials = document.getElementById('btn-submit-initials');

    initialBoxes.forEach((box, idx) => {
        if (!box) return;
        box.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Backspace') {
                if (box.value === '' && idx > 0) {
                    const prevBox = initialBoxes[idx - 1];
                    if (prevBox) { prevBox.focus(); prevBox.value = ''; }
                } else {
                    box.value = '';
                }
                e.preventDefault();
                return;
            }
            if (e.key.length === 1 && !/^[a-zA-Z]$/.test(e.key)) {
                e.preventDefault();
            }
        });
        box.addEventListener('input', () => {
            const letter = box.value.replace(/[^a-zA-Z]/g, '').slice(-1).toUpperCase();
            box.value = letter;
            if (letter && idx < 2) initialBoxes[idx + 1]?.focus();
        });
    });

    btnSubmitInitials?.addEventListener('click', () => {
        const initials = initialBoxes.map(b => (b?.value || '').toUpperCase()).join('');
        if (initials.length !== 3) {
            const emptyIdx = initialBoxes.findIndex(b => !b?.value);
            if (emptyIdx !== -1) initialBoxes[emptyIdx]?.focus();
            return;
        }
        if (state.mode === 'multi') {
            connection.invoke('SubmitHighScore', initials).catch(err => console.error('[HighScore] Submit failed:', err));
        }
        saveInitials(initials);
        if (initialsForm) initialsForm.classList.add('hidden');
        state.qualifiesForHighScore = false;
    });
}

// ── Local race helpers ────────────────────────────────────────────────────────

function startLocalRace(): void {
    const now = Date.now();
    state.countdownStartTimeMs = now;
    state.raceStartTimeMs = now + 3000;
    state.gameStatus = 'countdown';
    if (typeof (window as any).__gameStatus !== 'undefined') (window as any).__gameStatus = 'countdown';
    state.finishedPlayerId = '';
    state.lastRaceTimeMs = 0;
    state.raceTimedOut = false;
    state.localCrossedFinish = false;
    state.localFinishTimeMs = 0;
    state.localCrossedFinish2 = false;
    state.localFinishTimeMs2 = 0;
    state.comboIndex = 0;
    state.comboIndex2 = 0;
    state.hintDismissed = false;
    state.confettiParticles = [];
    state.gameOverAnim = null;
    state.countdownGunFired = false;
    state.lastBeepSec = -1;
    state.cameraX = 0;
    state.leaderboardExpanded = false;

    // Reset player positions
    const p1 = state.serverPlayers['local_p1'];
    if (p1) p1.x = 150;
    const p2 = state.serverPlayers['local_p2'];
    if (p2) p2.x = 150;

    // In 1P mode, set a clock-only target
    state.qualifiesForHighScore = state.mode === '1p';
}

function resetLocalRace(): void {
    state.gameStatus = 'waiting';
    if (typeof (window as any).__gameStatus !== 'undefined') (window as any).__gameStatus = 'waiting';
    state.finishedPlayerId = '';
    state.lastRaceTimeMs = 0;
    state.raceTimedOut = false;
    state.localCrossedFinish = false;
    state.localFinishTimeMs = 0;
    state.localCrossedFinish2 = false;
    state.localFinishTimeMs2 = 0;
    state.comboIndex = 0;
    state.comboIndex2 = 0;
    state.confettiParticles = [];
    state.gameOverAnim = null;
    state.countdownGunFired = false;
    state.lastBeepSec = -1;
    state.cameraX = 0;
    state.hintDismissed = true;
    state.leaderboardExpanded = false;

    const p1 = state.serverPlayers['local_p1'];
    if (p1) p1.x = 150;
    const p2 = state.serverPlayers['local_p2'];
    if (p2) p2.x = 150;
}

function handleLocalFinish(playerId: string): void {
    if (state.gameStatus === 'gameover') return;

    state.finishedPlayerId = playerId;
    state.lastRaceTimeMs = state.mode === '2p'
        ? Math.min(state.localFinishTimeMs, state.localFinishTimeMs2 || Infinity)
        : state.localFinishTimeMs;
    state.raceTimedOut = false;
    state.gameStatus = 'gameover';
    if (typeof (window as any).__gameStatus !== 'undefined') (window as any).__gameStatus = 'gameover';
    state.qualifiesForHighScore = state.mode === '1p';

    playSound('crowd');
    spawnConfetti();

    const winnerPlayer = state.serverPlayers[playerId];
    const loserEntry = state.mode === '2p'
        ? Object.values(state.serverPlayers).find(p => p.id !== playerId)
        : undefined;
    state.gameOverAnim = {
        spriteX: -300,
        frame: 0,
        frameTimer: 0,
        winnerIsTPose: winnerPlayer?.colorTint === 'blue',
        loserIsTPose: loserEntry?.colorTint === 'blue',
        loserExists: !!loserEntry,
        done: false,
    };
}