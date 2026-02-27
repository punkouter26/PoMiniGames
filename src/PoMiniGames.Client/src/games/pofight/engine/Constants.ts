export const GAME_WIDTH = 1920;
export const GAME_HEIGHT = 1080;
export const GROUND_Y = 900;

export const FIGHTER_WIDTH = 100;
export const FIGHTER_HEIGHT = 200;
export const MOVE_SPEED = 400; // pixels per second

export const MAX_CHARGE_TIME = 1.0;   // seconds to reach full power
export const WIND_UP_TIME = 0.5;      // seconds for visual wind-up to complete
export const OVERHEAT_TIME = 2.0;

// Jump physics
export const JUMP_VELOCITY = -600;     // initial upward velocity (negative = up in screen coords)
export const GRAVITY = 1800;           // pixels per second squared

export const ATTACK_FRAME_DATA = {
    JAB: { damage: 5, duration: 0.2, recovery: 0.1 },
    HEAVY_PUNCH: { damage: 20, duration: 0.4, recovery: 0.3 }, // At max charge
    KICK_FLICK: { damage: 7, duration: 0.25, recovery: 0.15 },
    HEAVY_KICK: { damage: 25, duration: 0.5, recovery: 0.4 },
};

export const STAMINA_RECOVERY_RATE = 10;
