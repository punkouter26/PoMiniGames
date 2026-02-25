// @ts-nocheck
/**
 * Input Buffering System
 * Accumulates input events and processes them at fixed timesteps
 * Prevents input from being missed at high frame rates
 */

export interface InputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  shoot: boolean;
  jump: boolean;
}

export class InputBuffer {
  private currentState: InputState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    shoot: false,
    jump: false
  };

  private fixedTimestep: number = 1 / 60;  // Match physics timestep
  private accumulator: number = 0;

  private _onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e);
  private _onKeyUp = (e: KeyboardEvent) => this.handleKeyUp(e);

  constructor() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    switch (event.code) {
      case 'KeyW':
      case 'ArrowUp':
        this.currentState.forward = true;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.currentState.backward = true;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this.currentState.left = true;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.currentState.right = true;
        break;
      case 'Space':
        this.currentState.jump = true;
        break;
    }
  }

  private handleKeyUp(event: KeyboardEvent): void {
    switch (event.code) {
      case 'KeyW':
      case 'ArrowUp':
        this.currentState.forward = false;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.currentState.backward = false;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this.currentState.left = false;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.currentState.right = false;
        break;
      case 'Space':
        this.currentState.jump = false;
        break;
    }
  }

  /**
   * Accumulate delta time and process inputs at fixed timestep
   */
  public update(delta: number, callback: (input: InputState) => void): void {
    this.accumulator += delta;

    while (this.accumulator >= this.fixedTimestep) {
      // Create snapshot of current input state
      callback({ ...this.currentState });
      this.accumulator -= this.fixedTimestep;
    }
  }

  /**
   * Get current input state (for immediate queries)
   */
  public getState(): InputState {
    return { ...this.currentState };
  }

  /**
   * Set shoot input (external trigger from mouse, touch, etc.)
   */
  public fireShot(): void {
    this.currentState.shoot = true;
    // Auto-reset shoot flag next frame
    setTimeout(() => { this.currentState.shoot = false; }, 16);
  }

  /**
   * Reset all inputs (useful for scene transitions)
   */
  public reset(): void {
    this.currentState = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      shoot: false,
      jump: false
    };
    this.accumulator = 0;
  }

  public dispose(): void {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}
