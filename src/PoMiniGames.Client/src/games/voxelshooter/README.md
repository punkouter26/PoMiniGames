# VoxelShooter — Status & Technical Notes

## Status: Active Prototype

VoxelShooter is a **work-in-progress** 3D FPS built on Three.js + WebGPU. It is fully playable but carries known technical debt that should be resolved before treating this module as production-grade.

## TypeScript Debt (`@ts-nocheck`)

All 15 source files in this directory have `// @ts-nocheck` at the top with a `TODO: Remove @ts-nocheck` comment. This disables all TypeScript type checking for the entire game.

**Do not refactor these files without first removing `@ts-nocheck` in the file you are editing.**  
Suggested incremental order (simplest first):

1. `RenderConfig.ts` — constants/config only
2. `QualitySettings.ts` — settings presets
3. `InputBuffer.ts` — input queue
4. `ParticlePool.ts` — object pool
5. `ShaderCompiler.ts` — GLSL→WGSL stub (note: `TODO: Implement full GLSL -> WGSL transpiler`)
6. `PlayerAvatar.ts` — avatar mesh
7. `InstancedVoxels.ts` — instanced rendering helpers
8. `ProjectileInteraction.ts` — collision/damage
9. `VoxelSimulation.ts` — voxel grid
10. `GameLogic.ts` — score/enemy tracking
11. `SceneSetup.ts` — Three.js scene init (see below)
12. `voxelshooter.ts` — main entry/event loop

## SceneSetup.ts — Split Recommendation

`SceneSetup.ts` (~350 lines) is the largest file in this module and handles several distinct concerns in one place. Once `@ts-nocheck` is resolved, it should be split into:

| New File | Responsibility |
|---|---|
| `SceneLighting.ts` | Directional, ambient, hemisphere lights |
| `ScenePostProcessing.ts` | SSAO, bloom, tone-mapping passes |
| `SceneRenderer.ts` | WebGLRenderer / WebGPURenderer setup, shadow cascade maps (CSM) |

The existing `SceneSetup.ts` then becomes a thin orchestrator that wires the three sub-modules.

## ShaderCompiler.ts — Incomplete

`ShaderCompiler.ts` contains a stub GLSL→WGSL transpiler with a `TODO: Implement full GLSL -> WGSL transpiler` comment. Until this is implemented, shaders fall back to Three.js defaults. Do not rely on WebGPU shader cross-compilation in this game.
