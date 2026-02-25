// @ts-nocheck
import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import * as CANNON from 'cannon-es';
import { RENDER_CONFIG } from './RenderConfig';

/**
 * Scene Initialization Module
 * Adapted to accept a container element instead of using document.body directly
 */
export interface SceneSetup {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  csm: CSM;
  controls: PointerLockControls;
  ssaoPass?: any;
  bloomPass?: any;
}

export function initializeScene(canvas: HTMLCanvasElement): SceneSetup {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050510);

  const camera = new THREE.PerspectiveCamera(75, w / h, 0.1, 1000);
  camera.position.set(30, 40, 50);
  camera.lookAt(0, 32, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambientLight);

  const csm = new CSM({
    maxFar: RENDER_CONFIG.CSM.maxFar,
    cascades: RENDER_CONFIG.CSM.cascades,
    mode: RENDER_CONFIG.CSM.mode,
    parent: scene,
    shadowMapSize: RENDER_CONFIG.CSM.shadowMapSize,
    lightDirection: new THREE.Vector3(
      RENDER_CONFIG.CSM.lightDirection.x,
      RENDER_CONFIG.CSM.lightDirection.y,
      RENDER_CONFIG.CSM.lightDirection.z
    ).normalize(),
    camera: camera,
  });

  const composer = new EffectComposer(renderer);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const ssaoPass = new SSAOPass(scene, camera, w, h);
  ssaoPass.kernelRadius = RENDER_CONFIG.SSAO.kernelRadius;
  ssaoPass.minDistance = RENDER_CONFIG.SSAO.minDistance;
  ssaoPass.maxDistance = RENDER_CONFIG.SSAO.maxDistance;
  composer.addPass(ssaoPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(w, h),
    1.5,
    0.4,
    0.85
  );
  bloomPass.threshold = RENDER_CONFIG.BLOOM.threshold;
  bloomPass.strength = RENDER_CONFIG.BLOOM.strength;
  bloomPass.radius = RENDER_CONFIG.BLOOM.radius;
  composer.addPass(bloomPass);

  if (RENDER_CONFIG.SMAA_ENABLED) {
    const smaaPass = new SMAAPass();
    composer.addPass(smaaPass);
  }

  // Use canvas as the PointerLockControls target (not document.body)
  const controls = new PointerLockControls(camera, canvas);

  return {
    scene,
    camera,
    renderer,
    composer,
    csm,
    controls,
    ssaoPass,
    bloomPass
  };
}

export function setupWindowResize(
  canvas: HTMLCanvasElement,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
  composer: EffectComposer,
  csm: CSM
): () => void {
  const handler = () => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    csm.updateFrustums();
  };
  window.addEventListener('resize', handler);
  return () => window.removeEventListener('resize', handler);
}

export function setupPhysicsWorld(): CANNON.World {
  const world = new CANNON.World({
    gravity: new CANNON.Vec3(0, -9.82, 0),
  });

  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = true;

  const solver = new CANNON.GSSolver();
  solver.iterations = 15;
  solver.tolerance = 0.01;
  world.solver = solver;

  const floorBody = new CANNON.Body({
    type: CANNON.Body.STATIC,
    shape: new CANNON.Plane(),
  });
  floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(floorBody);

  return world;
}

export function createFloor(scene: THREE.Scene): void {
  const gridHelper = new THREE.GridHelper(400, 40, 0x4ade80, 0x222222);
  gridHelper.position.y = 0.01;
  scene.add(gridHelper);

  const floorGeo = new THREE.PlaneGeometry(200, 200);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.0;
  scene.add(floor);
}

export async function getDevStats(container?: HTMLElement): Promise<any> {
  try {
    const StatsModule = await import('three/examples/jsm/libs/stats.module.js');
    const Stats = StatsModule.default;
    const stats = new Stats();
    (container ?? document.body).appendChild(stats.dom);
    return stats;
  } catch (e) {
    return { update: () => {}, dom: document.createElement('div') };
  }
}
