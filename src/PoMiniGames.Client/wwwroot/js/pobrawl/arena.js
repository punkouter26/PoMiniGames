// arena.js — the fight ring: raised platform, corner posts, ropes, floor, lights, fog.
import * as THREE from 'three';

export const RING_HALF = 5.2; // playable clamp radius (ring is 12x12, keep a margin)

export function buildArena(scene) {
  scene.background = new THREE.Color(0x0d0f1a);
  scene.fog = new THREE.Fog(0x0d0f1a, 18, 42);

  // Outer floor.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshLambertMaterial({ color: 0x14172a })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.5;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(80, 40, 0x232848, 0x1a1e38);
  grid.position.y = -0.49;
  scene.add(grid);

  // Ring platform (top surface at y=0).
  const mat = new THREE.MeshLambertMaterial({ color: 0x2a3160 });
  const ring = new THREE.Mesh(new THREE.BoxGeometry(12, 0.5, 12), mat);
  ring.position.y = -0.25;
  ring.receiveShadow = true;
  scene.add(ring);

  const canvasMat = new THREE.MeshLambertMaterial({ color: 0x3d4680 });
  const top = new THREE.Mesh(new THREE.BoxGeometry(11.6, 0.04, 11.6), canvasMat);
  top.position.y = 0.02;
  top.receiveShadow = true;
  scene.add(top);

  // Corner posts + three rope lines per side.
  const postMat = new THREE.MeshLambertMaterial({ color: 0x8a92c9 });
  const ropeMat = new THREE.MeshLambertMaterial({ color: 0xd0d4f0 });
  const half = 5.8;
  for (const x of [-half, half]) {
    for (const z of [-half, half]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.5, 8), postMat);
      post.position.set(x, 0.75, z);
      post.castShadow = true;
      scene.add(post);
    }
  }
  for (const y of [0.5, 0.9, 1.3]) {
    for (const side of [0, 1]) {
      for (const sign of [-1, 1]) {
        const rope = new THREE.Mesh(new THREE.BoxGeometry(side ? 0.04 : half * 2, 0.04, side ? half * 2 : 0.04), ropeMat);
        rope.position.set(side ? sign * half : 0, y, side ? 0 : sign * half);
        scene.add(rope);
      }
    }
  }

  // Lights.
  scene.add(new THREE.HemisphereLight(0x9aa4ff, 0x1a1030, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(6, 12, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -9;
  key.shadow.camera.right = 9;
  key.shadow.camera.top = 9;
  key.shadow.camera.bottom = -9;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x6070ff, 0.5);
  rim.position.set(-5, 6, -6);
  scene.add(rim);
}
