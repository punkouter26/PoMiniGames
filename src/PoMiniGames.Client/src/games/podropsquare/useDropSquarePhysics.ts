import { useEffect, useRef, useCallback, type RefObject } from 'react';
import Matter from 'matter-js';

// ─── Constants (ported from physics-engine.js) ──────────────────────────────
const W = 300;
const H = 200;
const GOAL_Y = 40;
const BLOCK = 20;
const WALL = 10;
const DANGER_MS = 2000;
const VELOCITY_THRESHOLD = 0.5;
const HALF_BLOCK = BLOCK / 2;

const COLORS = [
  '#4834d4', '#686de0', '#e056fd', '#f9ca24',
  '#f0932b', '#6ab04c', '#22a6b3', '#be2edd',
];

export interface PhysicsCallbacks {
  onDangerStart: () => void;
  onDangerUpdate: (elapsedSeconds: number) => void;
  onDangerCancel: () => void;
  onVictory: (survivalTimeSeconds: number) => void;
  onBlockLanded: () => void;
}

export interface PhysicsHandle {
  dropBlock: (canvasRelativeX: number) => void;
  reset: () => void;
  start: () => void;
  stop: () => void;
  getBlockCount: () => number;
}

// ─── Hook ────────────────────────────────────────────────────────────────────
export function useDropSquarePhysics(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  callbacks: PhysicsCallbacks,
  active: boolean,
) {
  const engineRef = useRef<Matter.Engine | null>(null);
  const renderRef = useRef<Matter.Render | null>(null);
  const blocksRef = useRef<Matter.Body[]>([]);
  const rafRef = useRef<number>(0);
  const runningRef = useRef(false);
  const gameStartRef = useRef<number>(0);
  const dangerStartRef = useRef<number | null>(null);
  const victoryFiredRef = useRef(false);
  const cbRef = useRef(callbacks);

  // Sync callbacks every render via direct ref assignment (latest-ref pattern)
  cbRef.current = callbacks;

  // ── tick ──────────────────────────────────────────────────────────────────
  const tick = useCallback(() => {
    if (!runningRef.current || !engineRef.current) return;

    const TARGET_DELTA = 1000 / 60;
    Matter.Engine.update(engineRef.current, TARGET_DELTA);

    // --- danger / victory check ---
    if (!victoryFiredRef.current) {
      const stableAbove = blocksRef.current.some(b => {
        const topY = b.position.y - HALF_BLOCK;
        const slow =
          Math.abs(b.velocity.x) < VELOCITY_THRESHOLD &&
          Math.abs(b.velocity.y) < VELOCITY_THRESHOLD;
        return topY <= GOAL_Y && slow;
      });

      if (stableAbove) {
        if (dangerStartRef.current === null) {
          dangerStartRef.current = performance.now();
          cbRef.current.onDangerStart();
        } else {
          const elapsed = performance.now() - dangerStartRef.current;
          cbRef.current.onDangerUpdate(Math.min(elapsed / 1000, 2.0));

          if (elapsed >= DANGER_MS) {
            victoryFiredRef.current = true;
            const survivalSecs = parseFloat(
              ((performance.now() - gameStartRef.current) / 1000).toFixed(2),
            );
            cbRef.current.onVictory(survivalSecs);
          }
        }
      } else if (dangerStartRef.current !== null) {
        dangerStartRef.current = null;
        cbRef.current.onDangerCancel();
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // ── init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;

    // Engine
    const engine = Matter.Engine.create({
      enableSleeping: true,
      positionIterations: 6,
      velocityIterations: 4,
    });
    engine.world.gravity.y = 0.8;
    engineRef.current = engine;

    // Renderer
    const render = Matter.Render.create({
      canvas,
      engine,
      options: {
        width: W,
        height: H,
        wireframes: false,
        background: '#1a1a2e',
        pixelRatio: 'auto' as unknown as number,
      },
    });
    renderRef.current = render;

    canvas.width = W;
    canvas.height = H;

    // Boundaries
    const floor = Matter.Bodies.rectangle(W / 2, H - WALL / 2, W, WALL, {
      isStatic: true,
      render: { fillStyle: '#2d2d54' },
    });
    const wallL = Matter.Bodies.rectangle(WALL / 2, H / 2, WALL, H, {
      isStatic: true,
      render: { fillStyle: '#2d2d54' },
    });
    const wallR = Matter.Bodies.rectangle(W - WALL / 2, H / 2, WALL, H, {
      isStatic: true,
      render: { fillStyle: '#2d2d54' },
    });

    // Goal line (sensor)
    const goalLine = Matter.Bodies.rectangle(
      W / 2,
      GOAL_Y,
      W - WALL * 2,
      2,
      {
        isStatic: true,
        isSensor: true,
        render: { fillStyle: '#ff4757' },
        label: 'goalLine',
      },
    );

    Matter.World.add(engine.world, [floor, wallL, wallR, goalLine]);

    Matter.Render.run(render);
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      runningRef.current = false;
      Matter.Render.stop(render);
      Matter.Engine.clear(engine);
      blocksRef.current = [];
      engineRef.current = null;
      renderRef.current = null;
      dangerStartRef.current = null;
      victoryFiredRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ── public API ────────────────────────────────────────────────────────────
  const handle: PhysicsHandle = {
    dropBlock(canvasRelativeX: number) {
      if (!runningRef.current || !engineRef.current) return;
      const color = COLORS[blocksRef.current.length % COLORS.length];
      const x = Math.max(WALL + HALF_BLOCK, Math.min(W - WALL - HALF_BLOCK, canvasRelativeX));
      const block = Matter.Bodies.rectangle(x, BLOCK, BLOCK, BLOCK, {
        restitution: 0.2,
        friction: 0.8,
        frictionAir: 0.01,
        density: 0.002,
        sleepThreshold: 60,
        render: { fillStyle: color },
        label: 'block',
      });
      blocksRef.current.push(block);
      Matter.World.add(engineRef.current.world, block);
      cbRef.current.onBlockLanded();
    },

    reset() {
      if (!engineRef.current) return;
      blocksRef.current.forEach(b => Matter.World.remove(engineRef.current!.world, b));
      blocksRef.current = [];
      dangerStartRef.current = null;
      victoryFiredRef.current = false;
    },

    start() {
      runningRef.current = true;
      gameStartRef.current = performance.now();
      victoryFiredRef.current = false;
      dangerStartRef.current = null;
    },

    stop() {
      runningRef.current = false;
    },

    getBlockCount() {
      return blocksRef.current.length;
    },
  };

  const handleRef = useRef(handle);
  handleRef.current = handle;

  return handleRef;
}
