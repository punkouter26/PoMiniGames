import { Fighter } from './Fighter';
import { FIGHTER_WIDTH } from './Constants';

export function checkCollision(f1: Fighter, f2: Fighter): boolean {
    // Simple AABB for 1D fighter (since Y is fixed/not jumping yet?)
    // Actually, specs say "Urban environment... geometry of fight".
    // If no Z-axis movement, and no jumping, we only check X distance?
    // But spec mentions "High/Low", so hitbox might vary vertically.
    // For now, let's assume body collision (pushing) is X-axis, and Hitbox collision is rect.

    const x1 = f1.x.value;
    const x2 = f2.x.value;

    // Body collision
    const dist = Math.abs(x1 - x2);
    const minDist = FIGHTER_WIDTH; // Simplified

    return dist < minDist;
}

export function resolvePushCollision(f1: Fighter, f2: Fighter) {
    // Prevent overlap
    const dist = f2.x.value - f1.x.value;
    const minSep = FIGHTER_WIDTH * 0.8; // some overlap allowed?

    if (Math.abs(dist) < minSep) {
        const push = (minSep - Math.abs(dist)) / 2;
        if (dist > 0) {
            f1.x.value -= push;
            f2.x.value += push;
        } else {
            f1.x.value += push;
            f2.x.value -= push;
        }
    }
}
