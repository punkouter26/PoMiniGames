import { state } from './state';
import { assets, assets2 } from './assets';
import {
    START_LINE_X,
    GROUND_HEIGHT_RATIO, PLAYER_BASE_Y_OFFSET,
    BANANA_SCALE, TPOSE_SCALE,
    BANANA_WALK_FRAMES, TPOSE_WALK_FRAMES,
    WALK_FPS,
    CAMERA_SNAP_THRESHOLD, CAMERA_LERP,
    CONFETTI_COUNT, CONFETTI_COLORS,
    GAMEOVER_WALK_SPEED, WINNER_X_RATIO, LOSER_X_RATIO,
    MIN_WORLD_WIDTH,
    COLOR_HUE_ROTATE,
} from './constants';
import { playSound } from './audioEngine';
import {
    hideAllScreens,
    updatePlayerBadge,
    updateLobbySlots,
} from './ui';
import type { ServerPlayer } from './types';

// ── Canvas setup ──────────────────────────────────────────────────────────────
export let canvas: HTMLCanvasElement | null = null;
export let ctx: CanvasRenderingContext2D | null = null;

export function initCanvas(canvasEl: HTMLCanvasElement): void {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    if (!canvas || !ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    window.addEventListener('resize', () => {
        if (!canvas) return;
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        state.worldWidth = Math.max(MIN_WORLD_WIDTH, window.innerWidth);
    });
}

// ── Cached DOM refs ──────────────────────────────────────────────────────────
function getLobbyWarningEl() { return document.getElementById('lobby-connection-warning'); }
function getReadyStatusEl() { return document.getElementById('ready-status-text'); }
function getBtnReady() { return document.getElementById('btn-ready'); }
function getCountdownText() { return document.getElementById('countdown-text'); }
function getHudTimer() { return document.getElementById('hud-timer'); }
function getControlsHint() { return document.getElementById('controls-hint'); }
function getGameoverIcon() { return document.getElementById('gameover-icon'); }
function getWinnerText() { return document.getElementById('winner-text'); }
function getFinalTimeText() { return document.getElementById('final-time-text'); }
function getInitialsForm() { return document.getElementById('initials-form'); }
function getInitialBoxes(): (HTMLInputElement | null)[] {
    return [0, 1, 2].map(i => document.getElementById(`initial-${i}`) as HTMLInputElement | null);
}
function getComboKeys(): (HTMLElement | null)[] {
    return [
        document.getElementById('combo-T'),
        document.getElementById('combo-Y'),
        document.getElementById('combo-G'),
        document.getElementById('combo-H'),
    ];
}

// ── Confetti ──────────────────────────────────────────────────────────────────
export function spawnConfetti(): void {
    if (!canvas) return;
    for (let i = 0; i < CONFETTI_COUNT; i++) {
        state.confettiParticles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height * 0.4,
            vx: (Math.random() - 0.5) * 5,
            vy: Math.random() * 3 + 1,
            color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]!,
            w: Math.random() * 14 + 4,
            h: Math.random() * 7 + 3,
            rot: Math.random() * Math.PI * 2,
            rotSpeed: (Math.random() - 0.5) * 0.15,
            life: 1.0,
            decay: Math.random() * 0.004 + 0.002,
        });
    }
}

// ── Game update (physics + animation) ────────────────────────────────────────
export function update(dt: number): void {
    // Banana suit uses time-based walk animation; t-pose is step-driven (tPoseFrame)
    const myPlayer = state.serverPlayers[state.connectionId ?? ''];
    const isTPose = myPlayer?.colorTint?.toLowerCase() === 'blue';
    if (!isTPose && state.gameStatus === 'playing') {
        if (state.localSprite.action === 'walk') {
            state.localSprite.frameTimer += dt;
            if (state.localSprite.frameTimer > 1 / WALK_FPS) {
                state.localSprite.frame++;
                if (state.localSprite.frame >= BANANA_WALK_FRAMES) {
                    state.localSprite.frame = 0;
                    state.localSprite.action = 'idle';
                }
                state.localSprite.frameTimer = 0;
            }
        }
    } else if (!isTPose) {
        state.localSprite.action = 'idle';
        state.localSprite.frame = 0;
        state.localSprite.frameTimer = 0;
    }

    // P2 sprite animation in 2P mode
    if (state.mode === '2p') {
        const p2Player = Object.values(state.serverPlayers).find(p => p.id !== state.connectionId && p.id !== 'p2');
        const p2IsTPose = p2Player?.colorTint?.toLowerCase() === 'blue';
        if (!p2IsTPose && state.gameStatus === 'playing') {
            if (state.localSprite2.action === 'walk') {
                state.localSprite2.frameTimer += dt;
                if (state.localSprite2.frameTimer > 1 / WALK_FPS) {
                    state.localSprite2.frame++;
                    if (state.localSprite2.frame >= BANANA_WALK_FRAMES) {
                        state.localSprite2.frame = 0;
                        state.localSprite2.action = 'idle';
                    }
                    state.localSprite2.frameTimer = 0;
                }
            }
        }
    }

    // Confetti physics
    for (let i = state.confettiParticles.length - 1; i >= 0; i--) {
        const p = state.confettiParticles[i]!;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.rotSpeed;
        p.vy += 0.05;
        p.life -= p.decay;
        if (p.life <= 0) state.confettiParticles.splice(i, 1);
    }

    // Game-over victory-walk animation
    if (state.gameOverAnim && !state.gameOverAnim.done && canvas) {
        const targetX = canvas.width * WINNER_X_RATIO;
        state.gameOverAnim.spriteX += GAMEOVER_WALK_SPEED * dt;
        if (state.gameOverAnim.spriteX >= targetX) {
            state.gameOverAnim.spriteX = targetX;
            state.gameOverAnim.done = true;
        }
        state.gameOverAnim.frameTimer += dt;
        if (state.gameOverAnim.frameTimer > 1 / 12) {
            const maxFrames = state.gameOverAnim.winnerIsTPose ? TPOSE_WALK_FRAMES : BANANA_WALK_FRAMES;
            state.gameOverAnim.frame = (state.gameOverAnim.frame + 1) % maxFrames;
            state.gameOverAnim.frameTimer = 0;
        }
    }
}

// ── Tile patterns (created once, reused every frame) ─────────────────────────
let skyPattern: CanvasPattern | null = null;
let groundPattern: CanvasPattern | null = null;

// ── Main render function ──────────────────────────────────────────────────────
export function render(): void {
    if (!canvas || !ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!state.assetsLoaded) return;

    // ── Camera ────────────────────────────────────────────────────────────────
    const DEMO_START_HOLD_MS = 1500;
    const demoHoldActive = state.demoMode
        && state.gameStatus === 'playing'
        && (Date.now() - state.raceStartTimeMs) < DEMO_START_HOLD_MS;

    let cameraTarget: ServerPlayer | undefined = state.serverPlayers[state.connectionId ?? ''];
    if (state.demoMode && !demoHoldActive) {
        const allPlayers = Object.values(state.serverPlayers);
        if (allPlayers.length > 0) {
            cameraTarget = allPlayers.reduce(
                (best, p) => (p.x > (best?.x ?? -Infinity) ? p : best), allPlayers[0]);
        }
    }
    let targetCameraX = 0;
    if (!demoHoldActive && cameraTarget) {
        targetCameraX = Math.max(0, cameraTarget.x - canvas.width / 3);
    }
    const maxPanX = Math.max(0, state.finishLineX - canvas.width + 300);
    targetCameraX = Math.min(targetCameraX, maxPanX);

    if (Math.abs(targetCameraX - state.cameraX) > CAMERA_SNAP_THRESHOLD) {
        state.cameraX = targetCameraX;
    } else {
        state.cameraX += (targetCameraX - state.cameraX) * CAMERA_LERP;
    }

    ctx.save();
    ctx.translate(-state.cameraX, 0);

    // ── Background tiles ──────────────────────────────────────────────────────
    if (assets.sky.width > 0 && assets.ground.width > 0) {
        if (!skyPattern)    skyPattern    = ctx.createPattern(assets.sky, 'repeat');
        if (!groundPattern) groundPattern = ctx.createPattern(assets.ground, 'repeat');

        const groundH   = Math.floor(canvas.height * GROUND_HEIGHT_RATIO);
        const groundTop = canvas.height - groundH;

        ctx.save();
        if (skyPattern) {
            ctx.fillStyle = skyPattern;
            ctx.fillRect(state.cameraX * 0.5, 0, canvas.width + state.cameraX, groundTop);
        }
        ctx.translate(0, groundTop);
        if (groundPattern) {
            ctx.fillStyle = groundPattern;
            ctx.fillRect(state.cameraX, 0, canvas.width + state.cameraX, groundH);
        }
        ctx.restore();

        // Start / Finish line markers
        ctx.fillStyle = 'rgba(255, 0, 0, 0.7)';
        ctx.fillRect(START_LINE_X, groundTop, 10, groundH);
        ctx.fillStyle = 'rgba(0, 255, 0, 0.7)';
        ctx.fillRect(state.finishLineX, groundTop, 10, groundH);

        ctx.fillStyle = 'white';
        ctx.font = 'bold 24px Inter, sans-serif';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
        ctx.fillText('START',  START_LINE_X + 20, groundTop + groundH * 0.55);
        ctx.fillText('FINISH', state.finishLineX + 20, groundTop + groundH * 0.55);
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
    }

    // ── DOM UI updates (called each render frame) ─────────────────────────────
    hideAllScreens();

    if (state.gameStatus === 'waiting' || state.gameStatus === 'readycheck') {
        const lobbyEl = document.getElementById('ui-lobby');
        if (lobbyEl) lobbyEl.classList.remove('hidden');

        const warningEl = getLobbyWarningEl();
        if (warningEl) {
            if (state.connectionError) {
                warningEl.textContent = `⚠️ ${state.connectionError}`;
                warningEl.classList.remove('hidden');
            } else {
                warningEl.classList.add('hidden');
            }
        }

        // Mode-specific lobby text
        const lobbyStatusLine = document.getElementById('lobby-status-line');
        if (lobbyStatusLine) {
            if (state.mode === '1p') {
                lobbyStatusLine.textContent = 'Press Enter to race solo!';
                lobbyStatusLine.classList.remove('blink');
            } else if (state.mode === '2p') {
                lobbyStatusLine.textContent = 'P1 (T-Y-G-H) vs P2 (Q-W-E-R) — Press Enter!';
                lobbyStatusLine.classList.remove('blink');
            } else if (state.mode === 'multi') {
                const opponentJoined = Object.keys(state.serverPlayers).length >= 2;
                lobbyStatusLine.textContent = opponentJoined
                    ? 'Opponent found! Press READY.'
                    : 'Looking for an opponent…';
                lobbyStatusLine.classList.toggle('blink', !opponentJoined);
            }
        }

        const lobbySpinner = document.getElementById('lobby-spinner');
        if (lobbySpinner) {
            lobbySpinner.classList.toggle('hidden', state.mode !== 'multi' || Object.keys(state.serverPlayers).length >= 2);
        }

        const btnReady = getBtnReady();
        const readyStatus = getReadyStatusEl();
        if (state.mode === 'multi') {
            const p = state.serverPlayers[state.connectionId ?? ''];
            const opponentJoined = Object.keys(state.serverPlayers).length >= 2;
            if (p && p.isReady) {
                if (btnReady) btnReady.classList.add('hidden');
                if (readyStatus) readyStatus.classList.remove('hidden');
            } else {
                if (btnReady) {
                    btnReady.classList.remove('hidden');
                    btnReady.textContent = opponentJoined ? 'READY!' : 'RACE SOLO!';
                    btnReady.classList.toggle('pulse', opponentJoined);
                }
                if (readyStatus) readyStatus.classList.add('hidden');
            }
        } else {
            // 1P, 2P, demo: no READY/RACE SOLO buttons
            if (btnReady) btnReady.classList.add('hidden');
            if (readyStatus) readyStatus.classList.add('hidden');
        }

        updatePlayerBadge();
        updateLobbySlots();

    } else if (state.gameStatus === 'countdown') {
        const cdEl = document.getElementById('ui-countdown');
        if (cdEl) cdEl.classList.remove('hidden');
        const countdownText = getCountdownText();
        if (!countdownText) return;
        const timeLeftMs = state.raceStartTimeMs - Date.now();
        if (timeLeftMs > 0) {
            const secs = Math.ceil(timeLeftMs / 1000);
            countdownText.innerText = secs.toString();
            if (secs !== state.lastBeepSec) {
                state.lastBeepSec = secs;
                if (secs <= 3) {
                    playSound('beep');
                    countdownText.style.transform = 'scale(1.5)';
                    setTimeout(() => { countdownText.style.transform = 'scale(1)'; }, 100);
                }
            }
            ctx.fillStyle = 'rgba(0,0,0,0.4)';
            ctx.fillRect(state.cameraX, 0, canvas.width, canvas.height);
        } else {
            if (!state.countdownGunFired) {
                state.countdownGunFired = true;
                state.lastBeepSec = -1;
                playSound('gun');
            }
            countdownText.innerText = 'GO!';
        }

    } else if (state.gameStatus === 'gameover') {
        const goEl = document.getElementById('ui-gameover');
        if (goEl) goEl.classList.remove('hidden');
        const isLocalWin = state.demoMode ? true : state.finishedPlayerId === state.connectionId;
        goEl?.classList.toggle('win-state', isLocalWin);
        goEl?.classList.toggle('loss-state', !isLocalWin);

        const gameoverIcon = getGameoverIcon();
        if (gameoverIcon) gameoverIcon.textContent = state.demoMode ? '🏆' : (isLocalWin ? '🏆' : '😤');

        const winnerText = getWinnerText();
        if (state.raceTimedOut && gameoverIcon) {
            gameoverIcon.textContent = '⏰';
            if (winnerText) winnerText.innerText = "TIME'S UP!";
        } else if (winnerText) {
            let wName = 'PLAYER';
            const fp = state.serverPlayers[state.finishedPlayerId];
            if (fp) {
                wName = (fp.colorTint || 'PLAYER').toUpperCase();
            }
            winnerText.innerText = `${wName} WINS!`;
        }

        const finalTimeText = getFinalTimeText();
        if (finalTimeText) finalTimeText.innerText = `Final Time: ${(state.lastRaceTimeMs / 1000).toFixed(3)}s`;

        const initialsForm = getInitialsForm();
        if (initialsForm) {
            const initialsFormReady = state.qualifiesForHighScore && Date.now() >= state.initialsFormAvailableAtMs;
            if (initialsFormReady) {
                initialsForm.classList.remove('hidden');
                if (!state.initialsFormShown) {
                    state.initialsFormShown = true;
                    const boxes = getInitialBoxes();
                    boxes.forEach(b => { if (b) b.value = ''; });
                    boxes[0]?.focus();
                }
            } else {
                initialsForm.classList.add('hidden');
            }
        }

        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(state.cameraX, 0, canvas.width, canvas.height);

    } else if (state.gameStatus === 'playing') {
        const playingEl = document.getElementById('ui-playing');
        if (playingEl) playingEl.classList.remove('hidden');
        const elapsedMs = Math.max(0, Date.now() - state.raceStartTimeMs);
        const hudTimer = getHudTimer();
        if (hudTimer) hudTimer.innerText = `${(elapsedMs / 1000).toFixed(3)}s`;

        const controlsHint = getControlsHint();
        if (controlsHint) {
            const showHint = state.mode === 'demo'
                ? false
                : !state.hintDismissed;
            controlsHint.classList.toggle('hidden', !showHint);
            if (showHint && state.mode === '2p') {
                // Update hint for P2
                const pP = controlsHint.querySelector('p');
                if (pP) pP.innerHTML = 'P1: <span class="combo-key next">T</span> <span class="combo-key">Y</span> <span class="combo-key">G</span> <span class="combo-key">H</span> | P2: <span class="combo-key next">Q</span> <span class="combo-key">W</span> <span class="combo-key">E</span> <span class="combo-key">R</span>';
            }
        }

        const comboKs = getComboKeys();
        comboKs.forEach((el, i) => {
            if (!el) return;
            el.classList.toggle('next', i === state.comboIndex);
        });
    }

    if (state.gameStatus !== 'countdown') {
        state.countdownGunFired = false;
        state.lastBeepSec = -1;
    }

    // Re-alias ctx for TS narrowing (module-level let loses narrowing after function calls)
    const _ctx = ctx as CanvasRenderingContext2D;

    // ── Sprite rendering ──────────────────────────────────────────────────────
    const playersToDraw = Object.values(state.serverPlayers).sort((a, b) => a.y - b.y);
    const groundH = Math.floor(canvas.height * GROUND_HEIGHT_RATIO);
    const BASE_Y = canvas.height - groundH + PLAYER_BASE_Y_OFFSET;

    playersToDraw.forEach(p => {
        const isLocalPlayer = !state.demoMode && p.id === state.connectionId;
        const action = isLocalPlayer ? state.localSprite.action : (p.action || 'idle');
        const frame = isLocalPlayer ? state.localSprite.frame : (p.currentFrame || 0);
        const isTPose = p.colorTint.toLowerCase() === 'blue';
        const charAssets = isTPose ? assets2 : assets;
        const scale = isTPose ? TPOSE_SCALE : BANANA_SCALE;

        let img: HTMLImageElement | undefined;
        if (!isTPose) {
            img = action === 'walk' ? charAssets.walk.east[frame] : charAssets.idle.east;
        } else {
            const tFrame = isLocalPlayer
                ? (state.tPoseFrame % TPOSE_WALK_FRAMES)
                : (frame % TPOSE_WALK_FRAMES);
            img = charAssets.walk.east[tFrame];
        }

        if (img && img.width > 0) {
            const w = img.width * scale;
            const h = img.height * scale;
            const renderY = BASE_Y + p.y * 20;
            _ctx.save();
            if (!isTPose) {
                const deg = COLOR_HUE_ROTATE[p.colorTint?.toLowerCase()] ?? 0;
                if (deg !== 0) _ctx.filter = `hue-rotate(${deg}deg)`;
            }
            _ctx.drawImage(img, p.x - w / 2, renderY - h, w, h);
            _ctx.restore();
        }
    });

    ctx.restore(); // remove world-space transform

    // ── Demo mode banner ────────────────────────────────────────────────────
    if (state.demoMode && (state.gameStatus === 'playing' || state.gameStatus === 'countdown')) {
        _ctx.save();
        _ctx.fillStyle = 'rgba(0,0,0,0.55)';
        _ctx.fillRect(0, 0, canvas.width, 36);
        _ctx.fillStyle = '#fcd34d';
        _ctx.font = 'bold 15px Inter, sans-serif';
        _ctx.textAlign = 'center';
        _ctx.fillText('🎬  DEMO MODE  —  press any key to exit', canvas.width / 2, 23);
        _ctx.textAlign = 'left';
        _ctx.restore();
    }

    // ── Confetti ─────────────────────────────────────────────────────────────
    state.confettiParticles.forEach(p => {
        _ctx.save();
        _ctx.globalAlpha = p.life;
        _ctx.translate(p.x, p.y);
        _ctx.rotate(p.rot);
        _ctx.fillStyle = p.color;
        _ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        _ctx.restore();
    });

    // ── Victory animation ────────────────────────────────────────────────────
    if (state.gameStatus === 'gameover' && state.gameOverAnim && state.assetsLoaded) {
        const { spriteX, frame, winnerIsTPose, loserIsTPose, loserExists, done } = state.gameOverAnim;
        const animBase = canvas.height - groundH + PLAYER_BASE_Y_OFFSET;

        const wAssets = winnerIsTPose ? assets2 : assets;
        const wScale = winnerIsTPose ? TPOSE_SCALE : BANANA_SCALE;
        const wImg = done
            ? wAssets.idle.east
            : (winnerIsTPose
                ? wAssets.walk.east[frame % TPOSE_WALK_FRAMES]
                : wAssets.walk.east[frame % BANANA_WALK_FRAMES]);
        if (wImg && wImg.width > 0) {
            const w = wImg.width * wScale;
            const h = wImg.height * wScale;
            _ctx.save();
            _ctx.globalAlpha = 0.95;
            _ctx.drawImage(wImg, spriteX - w / 2, animBase - h, w, h);
            _ctx.restore();
        }

        if (loserExists) {
            const lAssets = loserIsTPose ? assets2 : assets;
            const lScale = loserIsTPose ? TPOSE_SCALE : BANANA_SCALE;
            const lImg = lAssets.idle.west;
            if (lImg && lImg.width > 0) {
                const w = lImg.width * lScale;
                const h = lImg.height * lScale;
                _ctx.save();
                _ctx.globalAlpha = 0.65;
                _ctx.drawImage(lImg, canvas.width * LOSER_X_RATIO - w / 2, animBase - h, w, h);
                _ctx.restore();
            }
        }
    }
}