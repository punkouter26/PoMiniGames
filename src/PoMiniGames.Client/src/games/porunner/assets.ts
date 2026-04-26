import { state } from './state';

// ── Character sprite sheets ────────────────────────────────────────────────────
/** Player 1: man dressed in banana suit (48×48 sprites, 4-direction walk). */
export const assets = {
    sky:    new Image(),
    ground: new Image(),
    idle: { south: new Image(), west: new Image(), east: new Image(), north: new Image() },
    walk: { south: [] as HTMLImageElement[], west: [] as HTMLImageElement[], east: [] as HTMLImageElement[], north: [] as HTMLImageElement[] },
};

/** Player 2: man in t-pose (160×160 sprites, 8-frame east-only run). */
export const assets2 = {
    idle: { south: new Image(), west: new Image(), east: new Image(), north: new Image() },
    walk: { south: [] as HTMLImageElement[], west: [] as HTMLImageElement[], east: [] as HTMLImageElement[], north: [] as HTMLImageElement[] },
};

const loadImage = (img: HTMLImageElement, src: string): Promise<void> => new Promise(resolve => {
    img.src = src;
    img.onload = () => resolve();
    img.onerror = () => { console.warn('[Assets] Failed to load:', src); resolve(); };
});

/**
 * Loads all sprite sheets and background tiles in parallel.
 * Sets state.assetsLoaded = true when complete.
 */
export async function loadAssets(): Promise<void> {
    const promises: Promise<void>[] = [];
    // Vite serves public/ at the root path
    promises.push(loadImage(assets.sky, '/sky.png'));
    promises.push(loadImage(assets.ground, '/ground.png'));

    const dirs = ['south', 'west', 'east', 'north'] as const;

    // Banana suit: idle rotations for all directions; walk frames are east-only
    // (the race is a side-scroller — players always face east during gameplay)
    for (const dir of dirs) {
        promises.push(loadImage(assets.idle[dir], `/man_dressed_in_banana_suit/rotations/${dir}.png`));
    }
    for (let i = 0; i < 6; i++) {
        const img = new Image();
        promises.push(loadImage(img, `/man_dressed_in_banana_suit/animations/walk/east/frame_00${i}.png`));
        assets.walk.east.push(img);
    }

    // T-pose: idle rotations for all 4 directions
    for (const dir of dirs) {
        promises.push(loadImage(assets2.idle[dir], `/man_in_t_pose/rotations/${dir}.png`));
    }

    // T-pose: run animation only exists for east; reuse frames for all directions
    const tPoseRunFrames: HTMLImageElement[] = [];
    for (let i = 0; i < 8; i++) {
        const img = new Image();
        promises.push(loadImage(img, `/man_in_t_pose/animations/running-8-frames/east/frame_00${i}.png`));
        tPoseRunFrames.push(img);
    }
    for (const dir of dirs) {
        assets2.walk[dir] = tPoseRunFrames;
    }

    await Promise.all(promises);

    // ── T-pose fallback ───────────────────────────────────────────────────────
    // If t-pose sprites failed to load (assets missing), alias assets2 to the
    // banana-suit sprites so the "blue" bot renders visibly instead of invisible.
    const tPoseMissing = tPoseRunFrames.every(img => img.width === 0);
    if (tPoseMissing) {
        console.warn('[Assets] T-pose sprites not found — falling back to banana-suit for all bots.');
        for (const dir of dirs) {
            assets2.idle[dir] = assets.idle[dir];
            assets2.walk[dir] = assets.walk.east; // east-only walk frames serve as fallback
        }
    }

    state.assetsLoaded = true;
}