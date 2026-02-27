export type InputKey = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'PUNCH' | 'KICK';

export const KEY_MAPPINGS: Record<string, InputKey> = {
    w: 'UP',
    a: 'LEFT',
    s: 'DOWN',
    d: 'RIGHT',
    r: 'PUNCH',
    f: 'KICK',
    // Arrow keys support
    arrowup: 'UP',
    arrowdown: 'DOWN',
    arrowleft: 'LEFT',
    arrowright: 'RIGHT',
};

type KeyState = {
    isPressed: boolean;
    pressedAt: number; // timestamp in seconds
};

export class InputManager {
    private keyStates: Record<InputKey, KeyState> = {
        UP: { isPressed: false, pressedAt: 0 },
        DOWN: { isPressed: false, pressedAt: 0 },
        LEFT: { isPressed: false, pressedAt: 0 },
        RIGHT: { isPressed: false, pressedAt: 0 },
        PUNCH: { isPressed: false, pressedAt: 0 },
        KICK: { isPressed: false, pressedAt: 0 },
    };

    constructor() {
        if (typeof window !== 'undefined') {
            window.addEventListener('keydown', this.handleKeyDown);
            window.addEventListener('keyup', this.handleKeyUp);
        }
    }

    public cleanup() {
        if (typeof window !== 'undefined') {
            window.removeEventListener('keydown', this.handleKeyDown);
            window.removeEventListener('keyup', this.handleKeyUp);
        }
    }

    private handleKeyDown = (e: KeyboardEvent) => {
        const key = e.key.toLowerCase();
        // console.log(`InputManager: Key Down ${key}`);
        const action = KEY_MAPPINGS[key];
        if (action && !this.keyStates[action].isPressed) {
            this.keyStates[action].isPressed = true;
            this.keyStates[action].pressedAt = performance.now() / 1000;
        }
    };

    private handleKeyUp = (e: KeyboardEvent) => {
        const key = e.key.toLowerCase();
        const action = KEY_MAPPINGS[key];
        if (action) {
            this.keyStates[action].isPressed = false;
            this.keyStates[action].pressedAt = 0;
        }
    };

    public isPressed(action: InputKey): boolean {
        return this.keyStates[action].isPressed;
    }

    public getHoldDuration(action: InputKey): number {
        if (!this.keyStates[action].isPressed) return 0;
        return (performance.now() / 1000) - this.keyStates[action].pressedAt;
    }

    public getAxis(): { x: number; y: number } {
        let x = 0;
        let y = 0;
        if (this.isPressed('RIGHT')) x += 1;
        if (this.isPressed('LEFT')) x -= 1;
        if (this.isPressed('UP')) y += 1; // In 2D generic, UP might be jump (positive Y?) or just UP.
        if (this.isPressed('DOWN')) y -= 1;

        // For a fighter, Y usually isn't strict axis, but UP is jump/block high, DOWN is crouch/block low.
        // We return raw direction [-1, 0, 1].
        return { x, y };
    }
}

export const inputManager = new InputManager();
