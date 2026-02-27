import { Signal, createSignal } from './Signals';
import { MAX_CHARGE_TIME, OVERHEAT_TIME, MOVE_SPEED, GROUND_Y, ATTACK_FRAME_DATA, JUMP_VELOCITY, GRAVITY, WIND_UP_TIME } from './Constants';
import { soundManager } from './SoundManager';

export type FighterState =
    | 'IDLE'
    | 'MOVING'
    | 'JUMPING'
    | 'CHARGING'
    | 'ATTACKING'
    | 'BLOCKING'
    | 'STUNNED'
    | 'OVERHEATED';

export class Fighter {
    public id: string;
    public x: Signal<number>;
    public y: Signal<number>;
    public state: Signal<FighterState>;
    public health: Signal<number>;
    public chargeLevel: Signal<number>;
    public attackType: Signal<'PUNCH' | 'KICK' | 'NONE'>;
    public facingRight: boolean = true;

    private chargeStartTime: number = 0;
    private velocityY: number = 0;

    constructor(id: string, startX: number, facingRight: boolean = true) {
        this.id = id;
        this.x = createSignal<number>(startX);
        this.y = createSignal<number>(GROUND_Y);
        this.state = createSignal<FighterState>('IDLE');
        this.health = createSignal<number>(100);
        this.chargeLevel = createSignal<number>(0);
        this.attackType = createSignal<'PUNCH' | 'KICK' | 'NONE'>('NONE');
        this.facingRight = facingRight;
    }

    /** Whether the fighter is currently on the ground. */
    public get isGrounded(): boolean {
        return this.y.value >= GROUND_Y;
    }

    public update(dt: number, input: { x: number, y: number, punchHeld: boolean, kickHeld: boolean }) {
        const currentState = this.state.value;

        // ── Blocking (DOWN key) ─────────────────────────────────────
        if (['IDLE', 'MOVING', 'BLOCKING'].includes(currentState) && this.isGrounded) {
            if (input.y < -0.5) {
                this.state.value = 'BLOCKING';
            } else if (currentState === 'BLOCKING') {
                this.state.value = 'IDLE';
            }
        }

        const isBlocking = this.state.value === 'BLOCKING';

        // ── Jump Initiation (UP key, before physics so velocity applies this frame) ──
        if (input.y > 0.5 && this.isGrounded && !isBlocking
            && !['CHARGING', 'ATTACKING', 'STUNNED', 'OVERHEATED'].includes(currentState)) {
            this.state.value = 'JUMPING';
            this.velocityY = JUMP_VELOCITY;
            if (input.x !== 0) {
                this.facingRight = input.x > 0;
            }
        }

        // ── Jump Physics (always applied) ───────────────────────────
        if (!this.isGrounded || this.state.value === 'JUMPING') {
            this.velocityY += GRAVITY * dt;
            this.y.value += this.velocityY * dt;

            // Landed
            if (this.y.value >= GROUND_Y) {
                this.y.value = GROUND_Y;
                this.velocityY = 0;
                if (this.state.value === 'JUMPING') {
                    this.state.value = 'IDLE';
                }
            }
        }

        // ── Horizontal Movement (ground or air) ─────────────────────
        if (['IDLE', 'MOVING', 'JUMPING'].includes(this.state.value) && !isBlocking) {
            if (input.x !== 0) {
                if (this.isGrounded && this.state.value !== 'JUMPING') {
                    this.state.value = 'MOVING';
                }
                this.x.value += input.x * MOVE_SPEED * dt;
                this.facingRight = input.x > 0;
            } else if (currentState === 'MOVING' && this.isGrounded) {
                this.state.value = 'IDLE';
            }
        }

        // ── Charge Logic ────────────────────────────────────────────
        if (input.punchHeld || input.kickHeld) {
            // Start charging if possible (allowed in air too)
            if (!['CHARGING', 'OVERHEATED', 'ATTACKING'].includes(this.state.value) && !isBlocking
                && this.state.value !== 'STUNNED') {
                this.state.value = 'CHARGING';
                this.chargeStartTime = performance.now() / 1000;
                this.chargeLevel.value = 0;
                this.attackType.value = input.punchHeld ? 'PUNCH' : 'KICK';
            }

            // Continue charging
            if (this.state.value === 'CHARGING') {
                const duration = (performance.now() / 1000) - this.chargeStartTime;
                this.chargeLevel.value = Math.min(duration / MAX_CHARGE_TIME, 1.0);

                // Overheat check
                if (duration > OVERHEAT_TIME) {
                    this.state.value = 'OVERHEATED';
                    this.chargeLevel.value = 0;
                    setTimeout(() => { if (this.state.value === 'OVERHEATED') this.state.value = 'IDLE'; }, 1000);
                }
            }
        } else {
            // Release logic
            if (this.state.value === 'CHARGING') {
                this.executeAttack();
                // chargeLevel preserved during ATTACKING so FightManager can read it for damage
            }
        }
    }

    /**
     * Returns the wind-up progress (0→1) clamped to WIND_UP_TIME.
     * Visual animations use this; it reaches 1.0 at 0.5s even though
     * charge/power continues building to 1.0s.
     */
    public get windUpProgress(): number {
        const charge = this.chargeLevel.peek();
        return Math.min(charge / (WIND_UP_TIME / MAX_CHARGE_TIME), 1.0);
    }

    private executeAttack() {
        this.state.value = 'ATTACKING';
        const charge = this.chargeLevel.peek();
        const isHeavy = charge >= 0.9;
        const type = this.attackType.value;

        // Select frame data based on attack type and charge level
        const frameData = type === 'PUNCH'
            ? (isHeavy ? ATTACK_FRAME_DATA.HEAVY_PUNCH : ATTACK_FRAME_DATA.JAB)
            : (isHeavy ? ATTACK_FRAME_DATA.HEAVY_KICK : ATTACK_FRAME_DATA.KICK_FLICK);

        soundManager.playPunch(isHeavy ? 'HEAVY' : 'JAB');

        console.log(`Attack released! Type: ${type}, Charge: ${charge.toFixed(2)}. Max? ${isHeavy}`);

        // Reset to idle after attack duration + recovery
        const totalMs = (frameData.duration + frameData.recovery) * 1000;
        setTimeout(() => {
            if (this.state.value === 'ATTACKING') {
                this.state.value = 'IDLE';
                this.chargeLevel.value = 0;
                this.attackType.value = 'NONE';
            }
        }, totalMs);
    }
}
