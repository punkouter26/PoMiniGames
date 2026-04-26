import { state } from './state';
import { getProfile } from './profile';
import { PLAYER_COLOR_MAP } from './constants';

// ── Cached DOM references ────────────────────────────────────────────────────
let _initialized = false;

export let uiError: HTMLElement | null = null;
export let uiLobby: HTMLElement | null = null;
export let uiCountdown: HTMLElement | null = null;
export let uiPlaying: HTMLElement | null = null;
export let uiGameOver: HTMLElement | null = null;

/** Call once after the DOM mounts to cache element refs. */
export function initUI(): void {
    if (_initialized) return;
    _initialized = true;

    uiError = document.getElementById('ui-error');
    uiLobby = document.getElementById('ui-lobby');
    uiCountdown = document.getElementById('ui-countdown');
    uiPlaying = document.getElementById('ui-playing');
    uiGameOver = document.getElementById('ui-gameover');
}

/** Hide every screen overlay. Called at the top of each render frame. */
export function hideAllScreens(): void {
    uiError?.classList.add('hidden');
    uiLobby?.classList.add('hidden');
    uiCountdown?.classList.add('hidden');
    uiPlaying?.classList.add('hidden');
    uiGameOver?.classList.add('hidden');
}

/** Render the persistent local-player stats card on the game-over screen. */
export function renderStatsCard(): void {
    const playerStatsEl = document.getElementById('player-stats');
    if (!playerStatsEl) return;
    const profile = getProfile();
    const hasData = profile.wins > 0 || profile.losses > 0;
    if (!hasData) {
        playerStatsEl.classList.add('hidden');
        return;
    }
    playerStatsEl.classList.remove('hidden');
    const statsPBEl = document.getElementById('stats-pb');
    const statsWinsEl = document.getElementById('stats-wins');
    const statsLossesEl = document.getElementById('stats-losses');
    const statsStreakEl = document.getElementById('stats-streak');
    const statsStreakFireEl = document.getElementById('stats-streak-fire');
    if (statsPBEl) statsPBEl.textContent = profile.personalBestMs != null ? `${(profile.personalBestMs / 1000).toFixed(3)}s` : '—';
    if (statsWinsEl) statsWinsEl.textContent = String(profile.wins);
    if (statsLossesEl) statsLossesEl.textContent = String(profile.losses);
    if (statsStreakEl) statsStreakEl.textContent = String(profile.winStreak);
    if (statsStreakFireEl) statsStreakFireEl.classList.toggle('hidden', profile.winStreak < 2);
}

/** Re-render the leaderboard table from state.topScores. */
export function renderLeaderboard(): void {
    const leaderboardBody = document.getElementById('leaderboard-body');
    const lobbyLeaderboardBody = document.getElementById('lobby-leaderboard-body');
    const leaderboardBodyWrap = document.getElementById('leaderboard-body-wrap');
    const btnToggleLeaderboard = document.getElementById('btn-toggle-leaderboard');

    const emptyHtml = '<tr><td colspan="3" style="opacity:0.5;padding:0.5rem 0;">No scores yet</td></tr>';
    if (!state.topScores.length) {
        if (leaderboardBody) leaderboardBody.innerHTML = emptyHtml;
        if (lobbyLeaderboardBody) lobbyLeaderboardBody.innerHTML = emptyHtml;
        return;
    }

    const toRow = (s: { rank: number; timeMs: number; initials: string }) => {
        const medal = s.rank === 1 ? '🥇' : s.rank === 2 ? '🥈' : s.rank === 3 ? '🥉' : `#${s.rank}`;
        const time = (s.timeMs / 1000).toFixed(3) + 's';
        const isNew = state.connectionId
            && state.finishedPlayerId === state.connectionId
            && state.lastRaceTimeMs > 0
            && s.timeMs === state.lastRaceTimeMs;
        const rankClass = s.rank === 1 ? 'leaderboard-gold' : s.rank === 2 ? 'leaderboard-silver' : s.rank === 3 ? 'leaderboard-bronze' : '';
        const placeholderClass = s.initials === '---' ? 'leaderboard-placeholder' : '';
        return `<tr class="${[rankClass, isNew ? 'leaderboard-new' : '', placeholderClass].filter(Boolean).join(' ')}">
            <td class="leaderboard-rank">${medal}</td>
            <td class="leaderboard-initials">${s.initials || '---'}</td>
            <td class="leaderboard-time">${time}</td>
        </tr>`;
    };

    if (leaderboardBody) leaderboardBody.innerHTML = state.topScores.map(toRow).join('');
    if (lobbyLeaderboardBody) lobbyLeaderboardBody.innerHTML = state.topScores.slice(0, 5).map(toRow).join('');

    const hasNewEntry = state.topScores.some(s =>
        state.connectionId
        && state.finishedPlayerId === state.connectionId
        && state.lastRaceTimeMs > 0
        && s.timeMs === state.lastRaceTimeMs
    );
    if (hasNewEntry && !state.leaderboardExpanded && leaderboardBodyWrap && btnToggleLeaderboard) {
        state.leaderboardExpanded = true;
        leaderboardBodyWrap.classList.remove('hidden');
        btnToggleLeaderboard.textContent = '🏅 Hide Top 10 ▾';
    }
}

/** Update the lobby slot indicators from state.serverPlayers. */
export function updateLobbySlots(): void {
    const container = document.getElementById('lobby-slots');
    if (!container) return;
    const MAX_SLOTS = 8;
    const players = Object.values(state.serverPlayers);
    container.innerHTML = '';
    for (let i = 0; i < MAX_SLOTS; i++) {
        const player = players[i];
        const slot = document.createElement('div');
        slot.className = `lobby-slot${player ? ' filled' : ''}`;
        if (player) {
            const colorKey = player.colorTint?.toLowerCase();
            const cssColor = PLAYER_COLOR_MAP[colorKey] || '#ffffff';
            const readyClass = player.isReady ? ' ready' : '';
            slot.innerHTML = `<span class="slot-icon${readyClass}" style="background:${cssColor};width:24px;height:24px;border-radius:50%;display:inline-block;border:2px solid rgba(255,255,255,0.6);"></span>`;
        } else {
            slot.innerHTML = '<span class="slot-empty">?</span>';
        }
        container.appendChild(slot);
    }
}

/** Show the local player's colour badge. */
export function updatePlayerBadge(): void {
    const badgeEl = document.getElementById('player-badge');
    const iconEl = document.getElementById('player-badge-icon');
    const labelEl = document.getElementById('player-badge-label');
    if (!badgeEl || !iconEl || !labelEl) return;
    const myPlayer = state.serverPlayers[state.connectionId ?? ''];
    const colorRaw = myPlayer?.colorTint;
    if (!colorRaw || colorRaw.toLowerCase() === 'none') {
        badgeEl.classList.add('hidden');
        return;
    }
    badgeEl.classList.remove('hidden');
    const colorKey = colorRaw.toLowerCase();
    const cssColor = PLAYER_COLOR_MAP[colorKey] || '#ffffff';
    iconEl.innerHTML = `<span style="display:inline-block;width:18px;height:18px;border-radius:50%;background:${cssColor};border:2px solid rgba(255,255,255,0.7);vertical-align:middle;"></span>`;
    labelEl.textContent = `YOU ARE: ${colorRaw.toUpperCase()}`;
}

/** Show a mobile-only warning banner when a touch-primary device is detected. */
export function detectMobile(): void {
    const mobileWarning = document.getElementById('mobile-warning');
    if (!mobileWarning) return;
    const isTouchPrimary = navigator.maxTouchPoints > 1 && window.matchMedia('(hover: none)').matches;
    mobileWarning.classList.toggle('hidden', !isTouchPrimary);
}