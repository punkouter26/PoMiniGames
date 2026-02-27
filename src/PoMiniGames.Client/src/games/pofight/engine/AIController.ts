import { Fighter } from './Fighter';

type AIState = 'IDLE' | 'APPROACH' | 'RETREAT' | 'CHARGE' | 'BLOCK' | 'WAIT';

export class AIController {
    private me: Fighter;
    private opponent: Fighter;

    private mistakeRate: number;
    private aggression: number;
    private reactionTime: number;

    private currentState: AIState = 'IDLE';
    private stateTimer: number = 0;
    private targetStateTime: number = 0;

    // Output State
    private currentInput = { x: 0, y: 0, punchHeld: false, kickHeld: false };
    private holdTimer = 0;

    constructor(me: Fighter, opponent: Fighter, level: number) {
        this.me = me;
        this.opponent = opponent;

        this.mistakeRate = Math.max(0, 0.4 - (level * 0.08));
        this.aggression = 0.2 + (level * 0.15);
        this.reactionTime = Math.max(0.1, 0.5 - (level * 0.08));
    }

    public update(dt: number) {
        // State Machine Update
        this.stateTimer += dt;

        // Transitions
        if (this.stateTimer >= this.targetStateTime) {
            this.decideNextState();
        }

        // Behavior per state
        this.executeState(dt);
    }

    private decideNextState() {
        this.stateTimer = 0;
        const dist = Math.abs(this.me.x.value - this.opponent.x.value);
        const random = Math.random();

        // 1. Check Danger (React to attack or blocked hit)
        if (this.opponent.state.value === 'ATTACKING' || this.opponent.chargeLevel.value > 0.3) {
            if (random > this.mistakeRate) {
                this.currentState = 'BLOCK';
                this.targetStateTime = 0.5 + Math.random() * 0.5 + this.reactionTime;
                return;
            }
        }

        // 2. Offensive Choice
        if (dist < 250) {
            // In range
            if (random < this.aggression) {
                this.currentState = 'CHARGE';
                // Hold logic handled in execute
                this.targetStateTime = 0.2 + Math.random() * 0.6;
                this.holdTimer = 0; // Reset hold timer
            } else if (random < this.aggression + 0.3) {
                this.currentState = 'RETREAT'; // Bait
                this.targetStateTime = 0.3;
            } else {
                this.currentState = 'IDLE';
                this.targetStateTime = 0.2;
            }
        } else {
            // Out of range
            if (random < 0.7) {
                this.currentState = 'APPROACH';
                this.targetStateTime = 1.0;
            } else {
                this.currentState = 'WAIT';
                this.targetStateTime = 0.5;
            }
        }
    }

    private executeState(dt: number) {
        this.currentInput = { x: 0, y: 0, punchHeld: false, kickHeld: false };

        const directionToOpponent = this.opponent.x.value > this.me.x.value ? 1 : -1;

        switch (this.currentState) {
            case 'APPROACH':
                this.currentInput.x = directionToOpponent;
                break;
            case 'RETREAT':
                this.currentInput.x = -directionToOpponent;
                break;
            case 'BLOCK':
                this.currentInput.y = -1; // DOWN = block
                break;
            case 'CHARGE':
                this.currentInput.punchHeld = true;
                this.holdTimer += dt;
                break;
            case 'WAIT':
            case 'IDLE':
                break;
        }
    }

    public getInput() {
        return this.currentInput;
    }
}
