import { PlayerAvatar } from './PlayerAvatar';
import { EnemyShapes } from './EnemyShapes';
import { UIManager } from './UIManager';
import { eventBus } from './EventBus';
import * as THREE from 'three';

export class GameLogic {
    private state: 'PLAYING' | 'WIN' | 'LOSE' | 'PAUSED' = 'PLAYING';
    private ui: UIManager;

    private score = 0;
    private startTime = Date.now();
    private pauseStartTime = 0;
    private totalPausedTime = 0;
    private enemiesDestroyed = 0;

    private avatar: PlayerAvatar;
    private enemies: EnemyShapes;
    private lastEnemyCount = 0;

    // Game timing
    private GAME_DURATION = 100; // 100 seconds for score mode

    // Collision tuning - ADD BUFFER FOR RELIABILITY
    private baseCollisionRadius = 3.0; // Actual enemy visual size
    private collisionBuffer = 1.5; // Add safety margin for detection
    private difficulty: 'easy' | 'normal' | 'hard' = 'normal';

    constructor(avatar: PlayerAvatar, enemies: EnemyShapes, ui: UIManager) {
        this.avatar = avatar;
        this.enemies = enemies;
        this.ui = ui;
    }

    public setDifficulty(difficulty: string) {
        this.difficulty = difficulty as 'easy' | 'normal' | 'hard';
        switch (this.difficulty) {
            case 'easy':
                this.enemies.speed = 6.0;
                this.baseCollisionRadius = 3.5;
                break;
            case 'normal':
                this.enemies.speed = 10.0;
                this.baseCollisionRadius = 3.0;
                break;
            case 'hard':
                this.enemies.speed = 14.0;
                this.baseCollisionRadius = 2.5;
                break;
        }
    }

    public update() {
        const now = Date.now();

        if (this.state === 'PAUSED') {
            return;
        }

        if (this.state !== 'PLAYING') return;

        const px = this.avatar.body.position.x;
        const py = this.avatar.body.position.y;
        const pz = this.avatar.body.position.z;
        const playerPos = new THREE.Vector3(px, py, pz);

        for (const shape of this.enemies.shapes) {
            const sx = shape.body.position.x;
            const sy = shape.body.position.y;
            const sz = shape.body.position.z;
            const enemyPos = new THREE.Vector3(sx, sy, sz);

            const healthRatio = Math.max(0.1, shape.health / shape.maxHealth);
            const actualRadius = (this.baseCollisionRadius * healthRatio) + this.collisionBuffer;
            const distSq = playerPos.distanceToSquared(enemyPos);

            if (distSq < actualRadius * actualRadius) {
                this.lose("CRUSHED BY ENEMY!");
                return;
            }
        }

        // Track destroyed enemies
        const currentEnemyCount = this.enemies.shapes.length;
        if (currentEnemyCount < this.lastEnemyCount) {
            this.enemiesDestroyed += this.lastEnemyCount - currentEnemyCount;
            this.ui.setEnemiesDestroyed(this.enemiesDestroyed);
        }
        this.lastEnemyCount = currentEnemyCount;

        // Elapsed time
        const elapsedSeconds = Math.floor((now - this.startTime - this.totalPausedTime) / 1000);

        // Update UI with timer
        this.ui.updateTimer(elapsedSeconds, this.GAME_DURATION);

        const remaining = this.GAME_DURATION - elapsedSeconds;

        if (remaining <= 0) {
            this.win(`SURVIVAL COMPLETE! Score: ${this.calculateFinalScore()}`);
            return;
        }

        if (remaining <= 15) {
            this.ui.setMessage(`⏰ ${remaining}s remaining - SURVIVE!`, 'warning');
            if (remaining <= 3) {
                this.enemies.speed = this.getBaseDifficultySpeed() * 1.5;
            } else if (remaining <= 8) {
                this.enemies.speed = this.getBaseDifficultySpeed() * 1.2;
            }
        } else {
            this.ui.setMessage('');
        }
    }

    private getBaseDifficultySpeed(): number {
        switch (this.difficulty) {
            case 'easy': return 6.0;
            case 'normal': return 10.0;
            case 'hard': return 14.0;
        }
    }

    public togglePause(): void {
        if (this.state === 'PLAYING') {
            this.pauseStartTime = Date.now();
            this.state = 'PAUSED';
            this.ui.showPauseMenu();
        } else if (this.state === 'PAUSED') {
            const pausedDuration = (Date.now() - this.pauseStartTime) / 1000;
            this.totalPausedTime += pausedDuration;
            this.state = 'PLAYING';
            this.ui.hidePauseMenu();
        }
    }

    public restart(): void {
        this.state = 'PLAYING';
        this.score = 0;
        this.enemiesDestroyed = 0;
        this.lastEnemyCount = 0;
        this.startTime = Date.now();
        this.pauseStartTime = 0;
        this.totalPausedTime = 0;
        this.enemies.speed = this.getBaseDifficultySpeed();
        this.ui.setEnemiesDestroyed(0);
        this.ui.updateTimer(0, this.GAME_DURATION);
        this.ui.setMessage('');
    }

    private win(msg: string) {
        this.state = 'WIN';
        this.ui.showWin(msg);
        eventBus.emit('game-won', { score: this.score, message: msg });
    }

    private lose(msg: string) {
        this.state = 'LOSE';
        const finalScore = this.calculateFinalScore();
        this.ui.showGameOver(`${msg} | Final Score: ${finalScore}`);
        eventBus.emit('game-lost', { score: finalScore, message: msg });
    }

    private calculateFinalScore(): number {
        return this.score;
    }

    public isPaused(): boolean {
        return this.state === 'PAUSED';
    }

    public isGameOver(): boolean {
        return this.state === 'WIN' || this.state === 'LOSE';
    }

    public getHighestScore(): number {
        return this.score;
    }
}
