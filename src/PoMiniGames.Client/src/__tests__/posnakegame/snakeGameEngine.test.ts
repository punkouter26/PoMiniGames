import { describe, it, expect } from 'vitest';
import {
  getDirectionDelta,
  getOppositeDirection,
  initializeGame,
  ARENA_WIDTH,
  ARENA_HEIGHT,
  CPU_COUNT,
  INITIAL_FOOD_COUNT,
  GAME_DURATION,
  type Direction,
} from '../../games/posnakegame/snakeGameEngine';

describe('getDirectionDelta', () => {
  it('up decrements y', () => {
    expect(getDirectionDelta('up')).toEqual({ x: 0, y: -1 });
  });
  it('down increments y', () => {
    expect(getDirectionDelta('down')).toEqual({ x: 0, y: 1 });
  });
  it('left decrements x', () => {
    expect(getDirectionDelta('left')).toEqual({ x: -1, y: 0 });
  });
  it('right increments x', () => {
    expect(getDirectionDelta('right')).toEqual({ x: 1, y: 0 });
  });
});

describe('getOppositeDirection', () => {
  const cases: [Direction, Direction][] = [
    ['up', 'down'],
    ['down', 'up'],
    ['left', 'right'],
    ['right', 'left'],
  ];

  it.each(cases)('%s → %s', (input, expected) => {
    expect(getOppositeDirection(input)).toBe(expected);
  });

  it('is its own inverse', () => {
    const dirs: Direction[] = ['up', 'down', 'left', 'right'];
    for (const d of dirs) {
      expect(getOppositeDirection(getOppositeDirection(d))).toBe(d);
    }
  });
});

describe('initializeGame', () => {
  it('returns a game state with correct arena dimensions', () => {
    const state = initializeGame();
    expect(state.arenaWidth).toBe(ARENA_WIDTH);
    expect(state.arenaHeight).toBe(ARENA_HEIGHT);
  });

  it('initialises food to INITIAL_FOOD_COUNT items', () => {
    const state = initializeGame();
    expect(state.foods).toHaveLength(INITIAL_FOOD_COUNT);
  });

  it('initialises one player snake and CPU_COUNT cpu snakes', () => {
    const state = initializeGame();
    const playerSnakes = state.snakes.filter(s => s.isPlayer);
    const cpuSnakes    = state.snakes.filter(s => !s.isPlayer);
    expect(playerSnakes).toHaveLength(1);
    expect(cpuSnakes).toHaveLength(CPU_COUNT);
  });

  it('player snake starts alive and facing right', () => {
    const state = initializeGame();
    const player = state.snakes.find(s => s.isPlayer)!;
    expect(player.isAlive).toBe(true);
    expect(player.direction).toBe('right');
  });

  it('player snake starts with score 0', () => {
    const state = initializeGame();
    const player = state.snakes.find(s => s.isPlayer)!;
    expect(player.score).toBe(0);
    expect(player.foodEaten).toBe(0);
  });

  it('game starts not running and not over', () => {
    const state = initializeGame();
    expect(state.isRunning).toBe(false);
    expect(state.isGameOver).toBe(false);
  });

  it('timeRemaining is set to GAME_DURATION', () => {
    const state = initializeGame();
    expect(state.timeRemaining).toBe(GAME_DURATION);
  });

  it('all food positions are within arena bounds', () => {
    const state = initializeGame();
    for (const food of state.foods) {
      expect(food.x).toBeGreaterThanOrEqual(0);
      expect(food.x).toBeLessThan(ARENA_WIDTH);
      expect(food.y).toBeGreaterThanOrEqual(0);
      expect(food.y).toBeLessThan(ARENA_HEIGHT);
    }
  });
});
