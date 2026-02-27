
import { Signal, createSignal } from './Signals';

export interface Particle {
    id: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
    color: string;
    size: number;
}

export class ParticleSystem {
    public particles: Signal<Particle[]>;
    private nextId: number = 0;

    constructor() {
        this.particles = createSignal<Particle[]>([]);
    }

    public emit(x: number, y: number, count: number, color: string) {
        const newParticles: Particle[] = [];
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 400 + 100;
            newParticles.push({
                id: this.nextId++,
                x,
                y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1.0,
                maxLife: 1.0,
                color,
                size: Math.random() * 10 + 5
            });
        }

        // Append to existing (batch update?)
        // In a real game loop we'd just push to a mutable array, but with Signals we need to trigger update
        this.particles.value = [...this.particles.value, ...newParticles];
    }

    public update(dt: number) {
        const currentParticles = this.particles.value;
        if (currentParticles.length === 0) return;

        const activeParticles = currentParticles
            .map(p => {
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.vy += 1000 * dt; // Gravity
                p.life -= dt;
                return p;
            })
            .filter(p => p.life > 0);

        if (activeParticles.length !== currentParticles.length) {
            this.particles.value = activeParticles;
        }
    }
}

export const particleSystem = new ParticleSystem();
