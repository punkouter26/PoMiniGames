import { describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';

// Tooling smoke: proves Vitest resolves ES modules and that cannon-es runs headless
// in Node, which the physics tier (plan T10) depends on.
describe('SimJs tooling', () => {
  it('runs cannon-es in Node', () => {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });
    const body = new CANNON.Body({ mass: 1, shape: new CANNON.Sphere(0.5) });
    body.position.set(0, 10, 0);
    world.addBody(body);
    for (let i = 0; i < 20; i++) world.step(1 / 60);
    expect(body.position.y).toBeLessThan(10);
  });
});
