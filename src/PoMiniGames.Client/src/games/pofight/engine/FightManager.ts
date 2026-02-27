import { Fighter } from './Fighter';
import { checkCollision, resolvePushCollision } from './Collision';
import { GameLoop } from './GameLoop';
import { AIController } from './AIController';
import { inputManager } from './InputManager';
import { useGameStore } from '../store/gameState';
import { ATTACK_FRAME_DATA, FIGHTER_WIDTH } from './Constants';
import { soundManager } from './SoundManager';
import { particleSystem } from './ParticleSystem';
import { cameraSystem } from './CameraSystem';

import { WebGPURenderer } from './renderer/WebGPURenderer';

export class FightManager {
    public player: Fighter;
    public cpu: Fighter;
    public ai: AIController;
    public playerAI?: AIController; // For CPU vs CPU
    private gameLoop: GameLoop;
    private mode: 'PvCPU' | 'CPUvCPU';
    private renderer: WebGPURenderer | null = null;
    private onGameEnd?: (result: 'win' | 'loss') => void;
    private gameEnded = false;

    constructor(gameLoop: GameLoop, mode: 'PvCPU' | 'CPUvCPU', onGameEnd?: (result: 'win' | 'loss') => void) {
        this.gameLoop = gameLoop;
        this.mode = mode;
        this.onGameEnd = onGameEnd;

        const store = useGameStore.getState();
        const level = store.currentLevel;

        this.player = new Fighter('player', 400);
        this.cpu = new Fighter('cpu', 1200);
        // facing setup
        this.player.facingRight = true;
        this.cpu.facingRight = false;

        this.ai = new AIController(this.cpu, this.player, level);

        if (this.mode === 'CPUvCPU') {
            this.playerAI = new AIController(this.player, this.cpu, 5); // Max level AI for player
        }

        // Bind update
        gameLoop.setUpdateCallback(this.update.bind(this));
    }

    public setRenderer(renderer: WebGPURenderer) {
        this.renderer = renderer;
    }

    update(dt: number) {
        // 1. Get Inputs
        let playerInput;

        if (this.mode === 'CPUvCPU' && this.playerAI) {
            this.playerAI.update(dt);
            playerInput = this.playerAI.getInput();
        } else {
            // Human Input
            playerInput = {
                x: inputManager.getAxis().x,
                y: inputManager.getAxis().y,
                punchHeld: inputManager.isPressed('PUNCH'),
                kickHeld: inputManager.isPressed('KICK')
            };
        }

        // AI Input
        this.ai.update(dt);
        const cpuInput = this.ai.getInput();

        // 2. Update Fighters
        this.player.update(dt, playerInput);
        this.cpu.update(dt, cpuInput);

        // 3. Physics / Collision
        if (checkCollision(this.player, this.cpu)) {
            resolvePushCollision(this.player, this.cpu);
        }

        // 4. Hit Detection (Not fully implemented yet, need Hitbox logic)
        this.checkHits();

        // 5. Win Condition
        if (!this.gameEnded) {
            if (this.cpu.health.value <= 0) {
                this.handleWin();
            } else if (this.player.health.value <= 0) {
                this.handleLoss();
            }
        }

        // 6. Particles
        // 6. Particles
        particleSystem.update(dt);

        // 7. Camera
        cameraSystem.update(dt, [this.player, this.cpu]);
    }

    checkHits() {
        this.checkHitForAttacker(this.player, this.cpu);
        this.checkHitForAttacker(this.cpu, this.player);
    }

    private checkHitForAttacker(attacker: Fighter, defender: Fighter) {
        // Only check hits if attacker is in ATTACKING state
        if (attacker.state.value !== 'ATTACKING') return;

        // Check if in range
        const distance = Math.abs(attacker.x.value - defender.x.value);
        const attackRange = FIGHTER_WIDTH * 1.5; // Extended reach during attack

        if (distance > attackRange) return;

        // Check if defender is blocking
        const isBlocked = defender.state.value === 'BLOCKING';

        if (isBlocked) {
            // Block reduces damage to chip only
            const chipDamage = 2;
            soundManager.playBlock();
            particleSystem.emit((attacker.x.value + defender.x.value) / 2, defender.y.value - 100, 5, '#60a5fa');
            defender.health.value = Math.max(0, defender.health.value - chipDamage);
            console.log(`${defender.id} BLOCKED! Chip: ${chipDamage}`);
            return;
        }

        // Calculate damage based on attack type and charge
        const attackType = attacker.attackType.value;
        const chargeLevel = attacker.chargeLevel.peek();

        let baseDamage = 0;
        if (attackType === 'PUNCH') {
            baseDamage = chargeLevel >= 0.9 ? ATTACK_FRAME_DATA.HEAVY_PUNCH.damage : ATTACK_FRAME_DATA.JAB.damage;
        } else if (attackType === 'KICK') {
            baseDamage = chargeLevel >= 0.9 ? ATTACK_FRAME_DATA.HEAVY_KICK.damage : ATTACK_FRAME_DATA.KICK_FLICK.damage;
        }

        // Apply damage
        defender.health.value = Math.max(0, defender.health.value - baseDamage);
        defender.state.value = 'STUNNED';

        const isHeavy = baseDamage > 15;
        soundManager.playHit(isHeavy);

        // Visual FX
        if (this.renderer) {
            const midX = (attacker.x.value + defender.x.value) / 2;
            const midY = defender.y.value - 100;
            this.renderer.triggerShockwave(midX, midY, isHeavy ? 0.3 : 0.1);

            if (isHeavy) {
                this.renderer.setGlitch(0.5);
                setTimeout(() => this.renderer?.setGlitch(0), 100);
            }
        }

        console.log(`${attacker.id} HIT ${defender.id} for ${baseDamage} damage! (${attackType})`);

        // Reset attacker to prevent multi-hit
        attacker.state.value = 'IDLE';
        attacker.attackType.value = 'NONE';
        attacker.chargeLevel.value = 0;

        // Stun recovery
        setTimeout(() => {
            if (defender.state.value === 'STUNNED') {
                defender.state.value = 'IDLE';
            }
        }, 300);
    }

    handleWin() {
        this.gameEnded = true;
        this.gameLoop.stop();
        const store = useGameStore.getState();
        const nextLevel = store.currentLevel + 1;
        store.unlockLevel(nextLevel);
        store.setHighScore(store.currentLevel, this.player.health.value * 100);
        console.log('YOU WIN');
        setTimeout(() => {
            this.onGameEnd?.('win');
        }, 1500);
    }

    handleLoss() {
        this.gameEnded = true;
        this.gameLoop.stop();
        console.log('GAME OVER');
        setTimeout(() => {
            this.onGameEnd?.('loss');
        }, 1500);
    }
}
