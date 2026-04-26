/**
 * Persistent player profile stored in localStorage.
 * Tracks initials, personal best, win/loss record, and current/best win streak.
 * Degrades gracefully when localStorage is unavailable (private browsing, quota).
 */
import type { PlayerProfile } from './types';

const PROFILE_KEY = 'porunner_profile';

const DEFAULT_PROFILE: PlayerProfile = {
    initials: '',
    personalBestMs: null,
    wins: 0,
    losses: 0,
    winStreak: 0,
    currentStreak: 0,
};

export function getProfile(): PlayerProfile {
    try {
        const raw = localStorage.getItem(PROFILE_KEY);
        return raw ? { ...DEFAULT_PROFILE, ...JSON.parse(raw) } : { ...DEFAULT_PROFILE };
    } catch {
        return { ...DEFAULT_PROFILE };
    }
}

function _save(profile: PlayerProfile): void {
    try {
        localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch {
        // Silently fail — e.g. private browsing or storage quota exceeded
    }
}

/**
 * Persist the player's 3-letter initials.
 * @param initials Already validated A-Z, exactly 3 chars.
 */
export function saveInitials(initials: string): void {
    const profile = getProfile();
    profile.initials = initials.toUpperCase().slice(0, 3);
    _save(profile);
}

/**
 * Record the outcome of a completed race and update all stats.
 * @param won Whether the local player won.
 * @param timeMs Finish time in ms; only meaningful for winners.
 */
export function recordRaceResult(won: boolean, timeMs: number | null): void {
    const profile = getProfile();
    if (won) {
        profile.wins++;
        profile.currentStreak++;
        if (profile.currentStreak > profile.winStreak) {
            profile.winStreak = profile.currentStreak;
        }
        if (timeMs != null && (profile.personalBestMs == null || timeMs < profile.personalBestMs)) {
            profile.personalBestMs = timeMs;
        }
    } else {
        profile.losses++;
        profile.currentStreak = 0;
        // Update personal best on a loss too — the player finished the race.
        if (timeMs != null && (profile.personalBestMs == null || timeMs < profile.personalBestMs)) {
            profile.personalBestMs = timeMs;
        }
    }
    _save(profile);
}