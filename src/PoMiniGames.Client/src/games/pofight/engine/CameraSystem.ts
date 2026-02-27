
import { Signal, createSignal } from './Signals';
import { GAME_WIDTH, GAME_HEIGHT, FIGHTER_WIDTH } from './Constants';
import { Fighter } from './Fighter';

export class CameraSystem {
    public viewBox: Signal<string>;
    public x: number = 0;
    public y: number = 0;
    public zoom: number = 1;

    private minZoom: number = 0.7; // Zooms in
    private maxZoom: number = 1.2; // Zooms out

    constructor() {
        this.viewBox = createSignal<string>(`0 0 ${GAME_WIDTH} ${GAME_HEIGHT}`);
    }

    public update(dt: number, fighters: Fighter[]) {
        if (fighters.length < 2) return;

        const p1 = fighters[0]!;
        const p2 = fighters[1]!;

        // 1. Calculate midpoint
        const midX = (p1.x.value + p2.x.value + FIGHTER_WIDTH) / 2;
        const midY = (p1.y.value + p2.y.value + 200) / 2; // Bias towards ground

        // 2. Calculate Distance for Zoom
        const dist = Math.abs(p1.x.value - p2.x.value);

        // Map distance to zoom level
        // Close (100px) -> Zoom 0.6
        // Far (1500px) -> Zoom 1.2
        const targetZoom = Math.min(this.maxZoom, Math.max(this.minZoom, dist / 800));

        // Smooth Zoom
        this.zoom += (targetZoom - this.zoom) * 5 * dt;

        // 3. Calculate Viewport
        const viewWidth = GAME_WIDTH * this.zoom;
        const viewHeight = GAME_HEIGHT * this.zoom;

        // Target Center
        const targetX = midX - viewWidth / 2;
        const targetY = midY - viewHeight / 2 - 100; // Look up a bit

        // Clamp to world bounds (Assume world is 1920x1080 for now, but usually larger. 
        // If world is same size as screen, we can't pan much. 
        // Let's assume unlimited panning or clamp logic if world > screen.
        // For now, allow slight overscroll or assume background handles it.
        // Actually, if we zoom *in* (zoom < 1), we see less, so we can pan inside the 1920x1080 image?
        // Wait, zoom < 1 means viewWidth < GAME_WIDTH. 
        // So we can move x between 0 and GAME_WIDTH - viewWidth.

        // Smooth Pan
        this.x += (targetX - this.x) * 5 * dt;
        this.y += (targetY - this.y) * 5 * dt;

        // Clamp to stay within bounds if we want strict bounds
        // this.x = Math.max(-500, Math.min(GAME_WIDTH - viewWidth + 500, this.x));

        this.viewBox.value = `${this.x} ${this.y} ${viewWidth} ${viewHeight}`;
    }
}

export const cameraSystem = new CameraSystem();
