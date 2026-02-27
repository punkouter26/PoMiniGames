type UpdateCallback = (_deltaTime: number) => void;

export class GameLoop {
    private lastFrameTime: number = 0;
    private accumulatedTime: number = 0;
    private readonly timeStep: number = 1000 / 60; // 60 FPS
    private requestID: number | null = null;
    private isRunning: boolean = false;
    private updateCallback: UpdateCallback | null = null;

    constructor() { }

    public setUpdateCallback(callback: UpdateCallback) {
        this.updateCallback = callback;
    }

    public start() {
        if (this.isRunning) return;
        // console.log('GameLoop: Started');
        this.isRunning = true;
        this.lastFrameTime = performance.now();
        this.accumulatedTime = 0;
        this.requestID = requestAnimationFrame(this.loop);
    }

    public stop() {
        this.isRunning = false;
        if (this.requestID !== null) {
            cancelAnimationFrame(this.requestID);
            this.requestID = null;
        }
    }

    private loop = (timestamp: number) => {
        if (!this.isRunning) return;

        let deltaTime = timestamp - this.lastFrameTime;
        this.lastFrameTime = timestamp;

        // Cap deltaTime to prevent spiral of death on lag spikes or tab switching
        if (deltaTime > 1000) {
            deltaTime = 1000;
        }

        this.accumulatedTime += deltaTime;

        while (this.accumulatedTime >= this.timeStep) {
            if (this.updateCallback) {
                // We pass the fixed timeStep in seconds
                this.updateCallback(this.timeStep / 1000);
            }
            this.accumulatedTime -= this.timeStep;
        }

        this.requestID = requestAnimationFrame(this.loop);
    };
}

export const gameLoop = new GameLoop();
