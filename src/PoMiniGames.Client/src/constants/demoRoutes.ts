export const DEMO_ROUTES = [
  '/tictactoe?demo=1&demo_return=1',
  '/connectfive?demo=1&demo_return=1',
  '/pofight?demo=1&demo_return=1',
] as const;

export function pickRandomDemoRoute(): string {
  return DEMO_ROUTES[Math.floor(Math.random() * DEMO_ROUTES.length)]!;
}
