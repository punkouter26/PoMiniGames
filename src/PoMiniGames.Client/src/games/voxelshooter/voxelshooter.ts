import * as THREE from 'three';

import { initializeScene, setupWindowResize, setupPhysicsWorld, createFloor, getDevStats } from './SceneSetup';
import { UIManager } from './UIManager';
import { qualitySettings } from './QualitySettings';
import type { QualityPreset } from './QualitySettings';

import { VoxelSimulation } from './VoxelSimulation';
import { InstancedVoxels } from './InstancedVoxels';
import { ProjectileInteraction } from './ProjectileInteraction';
import { PlayerAvatar } from './PlayerAvatar';
import { EnemyShapes } from './EnemyShapes';
import { ParticlePool } from './ParticlePool';
import { GameLogic } from './GameLogic';

/**
 * Initializes the Voxel Shooter game inside the given canvas and container.
 * Returns a cleanup function that tears down all game state when called.
 */
export function initVoxelShooter(
  canvas: HTMLCanvasElement,
  container: HTMLElement,
  onReturnToMenu: () => void
): () => void {
  // Initialize scene and rendering
  const sceneSetup = initializeScene(canvas);
  const { scene, camera, renderer, composer, csm, controls, ssaoPass, bloomPass } = sceneSetup;

  // Setup physics world
  const world = setupPhysicsWorld();

  // Setup UI (shows main menu immediately)
  const ui = new UIManager(container);

  // Setup floor
  createFloor(scene);

  // Apply quality settings helper
  function applyQualitySettings(preset: QualityPreset): void {
    renderer.setPixelRatio(Math.min(preset.pixelRatio || 1.0, window.devicePixelRatio));

    if (ssaoPass) {
      ssaoPass.enabled = preset.ssao;
    }

    if (bloomPass) {
      bloomPass.enabled = preset.bloom;
      if (preset.bloom) {
        bloomPass.strength = preset.bloomStrength || 0.6;
        bloomPass.radius = preset.bloomRadius || 0.2;
        bloomPass.threshold = 1.0;
      }
    }

    if (preset.csm === 0) {
      renderer.shadowMap.enabled = false;
    } else {
      renderer.shadowMap.enabled = true;
    }
  }

  // Subscribe to quality changes
  const unsubscribeQuality = qualitySettings.subscribe((_level: string, preset: QualityPreset) => {
    applyQualitySettings(preset);
  });

  // Apply initial quality settings
  applyQualitySettings(qualitySettings.getPreset());

  // Animation timer
  const timer = new THREE.Timer();

  // Initialize stats (async, non-blocking)
  let stats = { update: () => {} };
  getDevStats(container).then((s: { update: () => void }) => { stats = s; });

  // Setup game systems
  const sim = new VoxelSimulation(renderer);
  const voxels = new InstancedVoxels(sim, 4096);
  scene.add(voxels.mesh);

  // Bullet scene (rendered as overlay, separate from main scene)
  const bulletScene = new THREE.Scene();

  // Game entities — created on game start
  let avatar: PlayerAvatar | null = null;
  let enemies: EnemyShapes | null = null;
  let particles: ParticlePool | null = null;
  let projectile: ProjectileInteraction | null = null;
  let gameLogic: GameLogic | null = null;

  let gameActive = false;
  let rafId = 0;

  function cleanupEnemies(): void {
    if (enemies) {
      for (const shape of enemies.shapes) {
        scene.remove(shape.mesh);
        shape.mesh.dispose();
        world.removeBody(shape.body);
      }
      enemies.shapes = [];
    }
  }

  function initializeGame(difficulty: string): void {
    cleanupEnemies();

    avatar = new PlayerAvatar(scene, world, camera);
    enemies = new EnemyShapes(scene, world, csm);
    particles = new ParticlePool(scene, csm);
    projectile = new ProjectileInteraction(camera, sim, particles, enemies, controls, bulletScene);
    gameLogic = new GameLogic(avatar, enemies, ui);
    gameLogic.setDifficulty(difficulty);
    gameActive = true;
  }

  // Wire up UI callbacks
  ui.onStartGame = (difficulty: string) => {
    initializeGame(difficulty);
  };

  ui.onResumeGame = () => {
    // Game continues naturally via RAF loop
  };

  ui.onMainMenu = () => {
    gameActive = false;
    cleanupEnemies();
    onReturnToMenu();
  };

  // Pause / ESC handling
  const onKeyDown = (e: KeyboardEvent) => {
    if (!gameActive || !gameLogic) return;
    if (e.code === 'Escape' || e.code === 'KeyP') {
      gameLogic.togglePause();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  // Main animation loop
  function tick(): void {
    rafId = requestAnimationFrame(tick);
    timer.update();
    const delta = Math.min(timer.getDelta(), 0.1);

    if (gameActive && avatar && enemies && gameLogic) {
      if (!gameLogic.isPaused()) {
        world.step(1 / 60, delta, 3);
      }

      avatar.update();
      if (!gameLogic.isPaused()) {
        enemies.update();
      }
      if (projectile) {
        projectile.update(delta);
      }
      if (!gameLogic.isPaused()) {
        sim.compute();
      }
      if (particles) {
        particles.update(delta);
      }
      voxels.update();
      gameLogic.update();
    }

    csm.update();
    composer.render();

    // Render bullet overlay on top
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(bulletScene, camera);
    renderer.autoClear = true;

    stats.update();
  }

  // Setup window resize handling
  const removeResize = setupWindowResize(canvas, camera, renderer, composer, csm);

  // Start loop
  tick();

  // Return cleanup function
  return () => {
    cancelAnimationFrame(rafId);
    window.removeEventListener('keydown', onKeyDown);
    removeResize();

    if (typeof unsubscribeQuality === 'function') {
      unsubscribeQuality();
    }

    avatar?.dispose();
    projectile?.dispose();

    cleanupEnemies();

    ui.clear();
    controls.dispose();
    renderer.dispose();
  };
}
