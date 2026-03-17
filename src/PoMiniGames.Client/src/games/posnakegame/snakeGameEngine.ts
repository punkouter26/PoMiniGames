// ── Types ─────────────────────────────────────────────────────────────────
export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Position {
  x: number;
  y: number;
}

export interface Snake {
  segments: Position[];
  direction: Direction;
  color: string;
  isAlive: boolean;
  score: number;
  foodEaten: number;
  isPlayer: boolean;
  playerId?: string;
}

export interface GameState {
  snakes: Snake[];
  foods: Position[];
  arenaWidth: number;
  arenaHeight: number;
  timeRemaining: number;
  isRunning: boolean;
  isGameOver: boolean;
  countdown: number | null;
}

// ── Constants ─────────────────────────────────────────────────────────────
export const ARENA_WIDTH = 48;
export const ARENA_HEIGHT = 32;
export const GAME_DURATION = 30;
export const CPU_COUNT = 15;
export const INITIAL_FOOD_COUNT = 20;

export const PERSONALITY_COLORS = [
  '#808080', // Random  - Gray
  '#FFFF00', // Foodie  - Yellow
  '#00FFFF', // Cautious - Cyan
  '#00BFFF', // Survivor - Deep Sky Blue
  '#FFA500', // Speedy  - Orange
  '#800080', // Aggressive - Purple
];

// ── Pure helpers ───────────────────────────────────────────────────────────
export function computeCellSize(): number {
  const maxW = Math.min(window.innerWidth - 32, 960);
  const maxH = window.innerHeight - 200;
  const cellW = Math.floor(maxW / ARENA_WIDTH);
  const cellH = Math.floor(maxH / ARENA_HEIGHT);
  return Math.max(8, Math.min(cellW, cellH, 20));
}

export function createPosition(x: number, y: number): Position {
  return { x, y };
}

export function getDirectionDelta(direction: Direction): Position {
  switch (direction) {
    case 'up':    return { x: 0, y: -1 };
    case 'down':  return { x: 0, y: 1 };
    case 'left':  return { x: -1, y: 0 };
    case 'right': return { x: 1, y: 0 };
  }
}

export function getOppositeDirection(direction: Direction): Direction {
  switch (direction) {
    case 'up':    return 'down';
    case 'down':  return 'up';
    case 'left':  return 'right';
    case 'right': return 'left';
  }
}

// ── Game logic ─────────────────────────────────────────────────────────────
export function initializeGame(): GameState {
  const snakes: Snake[] = [];
  const foods: Position[] = [];

  snakes.push({
    segments: [createPosition(Math.floor(ARENA_WIDTH / 8), Math.floor(ARENA_HEIGHT / 2))],
    direction: 'right',
    color: '#00FF00',
    isAlive: true,
    score: 0,
    foodEaten: 0,
    isPlayer: true,
  });

  for (let i = 0; i < CPU_COUNT; i++) {
    let x: number, y: number;
    let attempts = 0;
    do {
      x = Math.floor(ARENA_WIDTH * 0.6) + Math.floor(Math.random() * (ARENA_WIDTH * 0.35));
      y = Math.floor(Math.random() * ARENA_HEIGHT);
      attempts++;
    } while (attempts < 20 && snakes.some(s => s.segments.some(seg => seg.x === x && seg.y === y)));
    const dirs: Direction[] = ['up', 'down', 'left', 'right'];
    snakes.push({
      segments: [createPosition(x, y)],
      direction: dirs[Math.floor(Math.random() * 4)]!,
      color: PERSONALITY_COLORS[i % PERSONALITY_COLORS.length]!,
      isAlive: true,
      score: 0,
      foodEaten: 0,
      isPlayer: false,
    });
  }

  for (let i = 0; i < INITIAL_FOOD_COUNT; i++) {
    foods.push(createPosition(
      Math.floor(Math.random() * ARENA_WIDTH),
      Math.floor(Math.random() * ARENA_HEIGHT),
    ));
  }

  return {
    snakes,
    foods,
    arenaWidth: ARENA_WIDTH,
    arenaHeight: ARENA_HEIGHT,
    timeRemaining: GAME_DURATION,
    isRunning: false,
    isGameOver: false,
    countdown: 3,
  };
}

export function initializeTwoPlayerGame(p1Id: string, p2Id: string): GameState {
  const snakes: Snake[] = [];
  const foods: Position[] = [];

  // Player 1 – left side, facing right, green
  snakes.push({
    segments: [createPosition(Math.floor(ARENA_WIDTH / 8), Math.floor(ARENA_HEIGHT / 2))],
    direction: 'right',
    color: '#00FF00',
    isAlive: true,
    score: 0,
    foodEaten: 0,
    isPlayer: true,
    playerId: p1Id,
  });

  // Player 2 – right side, facing left, cyan
  snakes.push({
    segments: [createPosition(Math.floor(ARENA_WIDTH * 7 / 8), Math.floor(ARENA_HEIGHT / 2))],
    direction: 'left',
    color: '#00FFFF',
    isAlive: true,
    score: 0,
    foodEaten: 0,
    isPlayer: true,
    playerId: p2Id,
  });

  // 15 CPU snakes – spread across middle/right area avoiding player start positions
  for (let i = 0; i < CPU_COUNT; i++) {
    let x: number, y: number;
    let attempts = 0;
    do {
      x = Math.floor(ARENA_WIDTH * 0.3) + Math.floor(Math.random() * (ARENA_WIDTH * 0.4));
      y = Math.floor(Math.random() * ARENA_HEIGHT);
      attempts++;
    } while (attempts < 20 && snakes.some(s => s.segments.some(seg => seg.x === x && seg.y === y)));
    const dirs: Direction[] = ['up', 'down', 'left', 'right'];
    snakes.push({
      segments: [createPosition(x, y)],
      direction: dirs[Math.floor(Math.random() * 4)]!,
      color: PERSONALITY_COLORS[i % PERSONALITY_COLORS.length]!,
      isAlive: true,
      score: 0,
      foodEaten: 0,
      isPlayer: false,
    });
  }

  for (let i = 0; i < INITIAL_FOOD_COUNT; i++) {
    foods.push(createPosition(
      Math.floor(Math.random() * ARENA_WIDTH),
      Math.floor(Math.random() * ARENA_HEIGHT),
    ));
  }

  return {
    snakes,
    foods,
    arenaWidth: ARENA_WIDTH,
    arenaHeight: ARENA_HEIGHT,
    timeRemaining: GAME_DURATION,
    isRunning: false,
    isGameOver: false,
    countdown: 3,
  };
}

export function updateCPUSnake(snake: Snake, state: GameState): Direction {
  const head = snake.segments[0]!;
  const validDirs = (['up', 'down', 'left', 'right'] as Direction[]).filter(
    d => d !== getOppositeDirection(snake.direction),
  );

  let nearest: Position | null = null;
  let nearestDist = Infinity;
  for (const food of state.foods) {
    const d = Math.abs(food.x - head.x) + Math.abs(food.y - head.y);
    if (d < nearestDist) { nearestDist = d; nearest = food; }
  }

  if (nearest && Math.random() > 0.3) {
    const dx = nearest.x - head.x;
    const dy = nearest.y - head.y;
    const pref: Direction[] = [];
    if (dx > 0 && validDirs.includes('right')) pref.push('right');
    if (dx < 0 && validDirs.includes('left'))  pref.push('left');
    if (dy > 0 && validDirs.includes('down'))  pref.push('down');
    if (dy < 0 && validDirs.includes('up'))    pref.push('up');
    if (pref.length > 0) return pref[Math.floor(Math.random() * pref.length)]!;
  }

  return validDirs[Math.floor(Math.random() * validDirs.length)]!;
}

export function updateGame(state: GameState): GameState {
  if (!state.isRunning || state.isGameOver) return state;

  let newFoods = [...state.foods];

  const newSnakes = state.snakes.map(snake => {
    if (!snake.isAlive) return snake;

    if (!snake.isPlayer) {
      snake.direction = updateCPUSnake(snake, state);
    }

    const head = snake.segments[0]!;
    const delta = getDirectionDelta(snake.direction);
    const newHead = createPosition(head.x + delta.x, head.y + delta.y);

    if (newHead.x < 0 || newHead.x >= state.arenaWidth ||
        newHead.y < 0 || newHead.y >= state.arenaHeight) {
      return { ...snake, isAlive: false };
    }
    if (snake.segments.some(s => s.x === newHead.x && s.y === newHead.y)) {
      return { ...snake, isAlive: false };
    }
    for (const other of state.snakes) {
      if (other === snake || !other.isAlive) continue;
      if (other.segments.some(s => s.x === newHead.x && s.y === newHead.y)) {
        return { ...snake, isAlive: false };
      }
    }

    const newSegments = [newHead, ...snake.segments];
    const foodIdx = newFoods.findIndex(f => f.x === newHead.x && f.y === newHead.y);
    if (foodIdx >= 0) {
      newFoods = [
        ...newFoods.slice(0, foodIdx),
        ...newFoods.slice(foodIdx + 1),
        createPosition(
          Math.floor(Math.random() * state.arenaWidth),
          Math.floor(Math.random() * state.arenaHeight),
        ),
      ];
      return { ...snake, segments: newSegments, score: snake.score + 10, foodEaten: snake.foodEaten + 1 };
    } else {
      newSegments.pop();
      return { ...snake, segments: newSegments };
    }
  });

  const players = newSnakes.filter(s => s.isPlayer);
  const isGameOver = (players.length > 0 && players.some(p => !p.isAlive)) || state.timeRemaining <= 0;
  return { ...state, snakes: newSnakes, foods: newFoods, isGameOver };
}

export function drawGame(ctx: CanvasRenderingContext2D, state: GameState, cellSize: number): void {
  const cs = cellSize;
  const canvasW = ARENA_WIDTH * cs;
  const canvasH = ARENA_HEIGHT * cs;

  ctx.fillStyle = '#0f0f1a';
  ctx.fillRect(0, 0, canvasW, canvasH);

  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= ARENA_WIDTH; x++) {
    ctx.beginPath(); ctx.moveTo(x * cs, 0); ctx.lineTo(x * cs, canvasH); ctx.stroke();
  }
  for (let y = 0; y <= ARENA_HEIGHT; y++) {
    ctx.beginPath(); ctx.moveTo(0, y * cs); ctx.lineTo(canvasW, y * cs); ctx.stroke();
  }

  for (const food of state.foods) {
    const cx = food.x * cs + cs / 2;
    const cy = food.y * cs + cs / 2;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, cs * 0.8);
    grad.addColorStop(0, 'rgba(255, 107, 107, 0.4)');
    grad.addColorStop(1, 'rgba(255, 107, 107, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(food.x * cs - cs * 0.3, food.y * cs - cs * 0.3, cs * 1.6, cs * 1.6);
    ctx.fillStyle = '#ff6b6b';
    ctx.beginPath();
    ctx.arc(cx, cy, cs / 3, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const snake of state.snakes) {
    if (!snake.isAlive) continue;
    for (let i = 0; i < snake.segments.length; i++) {
      const seg = snake.segments[i]!;
      const isHead = i === 0;

      if (snake.isPlayer && isHead) {
        ctx.shadowColor = snake.color; ctx.shadowBlur = cs * 0.6;
        ctx.fillStyle = snake.color;
        ctx.fillRect(seg.x * cs + 0.5, seg.y * cs + 0.5, cs - 1, cs - 1);
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffffff';
        const dotR = Math.max(1, cs * 0.12);
        ctx.beginPath(); ctx.arc(seg.x * cs + cs * 0.35, seg.y * cs + cs * 0.4, dotR, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(seg.x * cs + cs * 0.65, seg.y * cs + cs * 0.4, dotR, 0, Math.PI * 2); ctx.fill();
      } else if (snake.isPlayer) {
        ctx.fillStyle = snake.color;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(seg.x * cs + 1.5, seg.y * cs + 1.5, cs - 3, cs - 3);
        ctx.globalAlpha = 1;
      } else if (isHead) {
        ctx.fillStyle = snake.color;
        ctx.fillRect(seg.x * cs + 1, seg.y * cs + 1, cs - 2, cs - 2);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath(); ctx.arc(seg.x * cs + cs / 2, seg.y * cs + cs / 2, Math.max(1, cs * 0.12), 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = snake.color;
        ctx.globalAlpha = 0.7;
        ctx.fillRect(seg.x * cs + 2, seg.y * cs + 2, cs - 4, cs - 4);
        ctx.globalAlpha = 1;
      }
    }
  }

  if (state.countdown !== null && state.countdown > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.fillStyle = '#00FF00';
    ctx.font = `bold ${Math.round(cs * 5)}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = '#00FF00'; ctx.shadowBlur = 30;
    ctx.fillText(state.countdown.toString(), canvasW / 2, canvasH / 2);
    ctx.shadowBlur = 0;
  }
}
