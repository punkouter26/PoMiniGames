// arena.js — the fight ring, breakable props, low-poly crowd and lighting.
// Materials are MeshStandardMaterial so they read the key/rim lights and (optionally)
// the env map that the engine can attach at startup.
import * as THREE from 'three';

export const RING_HALF = 5.2; // playable clamp radius (ring is 12x12, keep a margin)

export function buildArena(scene, envMap = null) {
  scene.background = new THREE.Color(0x0d0f1a);
  scene.fog = new THREE.Fog(0x0d0f1a, 22, 60);

  // Outer floor.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0x14172a, roughness: 0.95, metalness: 0.0 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.5;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(80, 40, 0x232848, 0x1a1e38);
  grid.position.y = -0.49;
  grid.material.opacity = 0.55;
  grid.material.transparent = true;
  scene.add(grid);

  // Ring platform.
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x2a3160, roughness: 0.85, metalness: 0.05,
  });
  if (envMap) { ringMat.envMap = envMap; ringMat.envMapIntensity = 0.6; }
  const ring = new THREE.Mesh(new THREE.BoxGeometry(12, 0.5, 12), ringMat);
  ring.position.y = -0.25;
  ring.receiveShadow = true;
  scene.add(ring);

  const canvasMat = new THREE.MeshStandardMaterial({
    color: 0x3d4680, roughness: 0.95, metalness: 0.0,
  });
  const top = new THREE.Mesh(new THREE.BoxGeometry(11.6, 0.04, 11.6), canvasMat);
  top.position.y = 0.02;
  top.receiveShadow = true;
  scene.add(top);

  // Corner posts — breakable. The engine listens for collisions against these.
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x8a92c9, roughness: 0.45, metalness: 0.25,
  });
  if (envMap) { postMat.envMap = envMap; postMat.envMapIntensity = 0.9; }
  const postGeo = new THREE.CylinderGeometry(0.08, 0.1, 1.5, 10);
  const posts = [];
  const half = 5.8;
  for (const x of [-half, half]) {
    for (const z of [-half, half]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(x, 0.75, z);
      post.castShadow = true;
      post.receiveShadow = true;
      post.userData.breakable = true;
      post.userData.hp = 30;
      post.userData.maxHp = 30;
      post.userData.kind = 'post';
      post.userData.basePos = new THREE.Vector3(x, 0.75, z);
      scene.add(post);
      posts.push(post);

      // Foam topper for the post so it doesn't look like a bare pipe.
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.12, 0.1, 12),
        new THREE.MeshStandardMaterial({ color: 0xd0d4f0, roughness: 0.85 })
      );
      cap.position.set(x, 1.55, z);
      cap.castShadow = true;
      cap.userData.attachedTo = post;
      scene.add(cap);
    }
  }

  // Ropes (kept from the original).
  const ropeMat = new THREE.MeshStandardMaterial({
    color: 0xd0d4f0, roughness: 0.85, metalness: 0.0,
  });
  for (const y of [0.5, 0.9, 1.3]) {
    for (const side of [0, 1]) {
      for (const sign of [-1, 1]) {
        const rope = new THREE.Mesh(
          new THREE.BoxGeometry(side ? 0.04 : half * 2, 0.04, side ? half * 2 : 0.04),
          ropeMat
        );
        rope.position.set(side ? sign * half : 0, y, side ? 0 : sign * half);
        scene.add(rope);
      }
    }
  }

  // Lights — slightly warmer key, bluer rim, plus a low ambient bounce so
  // PBR materials in shadow still read some colour.
  scene.add(new THREE.HemisphereLight(0x9aa4ff, 0x1a1030, 0.55));
  const key = new THREE.DirectionalLight(0xfff1d0, 1.6);
  key.position.set(6, 12, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -10;
  key.shadow.camera.right = 10;
  key.shadow.camera.top = 10;
  key.shadow.camera.bottom = -10;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x6070ff, 0.7);
  rim.position.set(-5, 6, -6);
  scene.add(rim);

  const fill = new THREE.PointLight(0xffe0a0, 0.5, 30, 1.4);
  fill.position.set(0, 6, 0);
  scene.add(fill);

  // Crowd: 4 rows of low-poly silhouettes around the ring.
  // They're tagged userData.crowd so we can bounce them on KOs (wave animation).
  const crowd = buildCrowd(scene);
  scene.add(crowd);

  return { posts, crowd };
}

function buildCrowd(scene) {
  const group = new THREE.Group();
  group.userData.kind = 'crowd';
  const skinA = new THREE.MeshStandardMaterial({ color: 0xb88a6a, roughness: 0.9 });
  const skinB = new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.9 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.9 });
  const shirtB = new THREE.MeshStandardMaterial({ color: 0x252540, roughness: 0.9 });
  const palettes = [
    [skinA, shirt],
    [skinB, shirtB],
    [skinA, shirtB],
    [skinB, shirt],
  ];

  const ring = 7.6;
  const rows = [
    { r: ring, count: 24 },
    { r: ring + 1.6, count: 32 },
    { r: ring + 3.4, count: 40 },
    { r: ring + 5.5, count: 48 },
  ];
  let id = 0;
  for (const row of rows) {
    const count = row.count;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.05;
      const x = Math.sin(a) * row.r + (Math.random() - 0.5) * 0.4;
      const z = Math.cos(a) * row.r + (Math.random() - 0.5) * 0.4;
      const y = -0.45;

      const body = new THREE.Group();
      const heightJitter = 0.92 + Math.random() * 0.18;
      const pal = palettes[id % palettes.length];
      const torso2 = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 0.9 * heightJitter, 0.28),
        pal[1]
      );
      torso2.position.y = 0.45 * heightJitter;
      torso2.castShadow = false;
      body.add(torso2);
      const skull2 = new THREE.Mesh(
        new THREE.BoxGeometry(0.24, 0.26, 0.24),
        pal[0]
      );
      skull2.position.y = 1.05 * heightJitter;
      body.add(skull2);
      body.position.set(x, y, z);
      body.rotation.y = Math.atan2(-x, -z) + (Math.random() - 0.5) * 0.6;
      body.userData.crowd = true;
      body.userData.bouncePhase = Math.random() * Math.PI * 2;
      body.userData.baseY = y;
      group.add(body);
      id++;
    }
  }
  return group;
}

// Animate the crowd: a subtle idle sway plus an excited bounce while `excited` > 0.
// Called from the engine's _updateCrowd at render rate.
export function animateCrowd(crowd, dt, t, excited) {
  if (!crowd) return;
  for (const c of crowd.children) {
    const phase = (c.userData.bouncePhase ?? 0) + t * 1.4;
    const idle = Math.sin(phase) * 0.025;
    const wave = excited > 0 ? Math.sin(phase * 1.8 + c.userData.baseY) * 0.18 * excited : 0;
    c.position.y = c.userData.baseY + idle + wave;
    c.rotation.x = excited > 0 ? Math.sin(phase * 1.8) * 0.05 * excited : 0;
  }
}

// Knock chunks off a post on collision. Returns the debris meshes for the engine
// to integrate into its particle update list.
const _debrisGeo = new THREE.BoxGeometry(0.18, 0.06, 0.18);
const _debrisMat = new THREE.MeshStandardMaterial({ color: 0x8a92c9, roughness: 0.6 });
export function damagePost(post, dmg, scene) {
  if (!post || !post.userData.breakable) return [];
  post.userData.hp -= dmg;
  const debris = [];
  if (post.userData.hp <= 0 && post.userData.hp > -1000) {
    post.userData.hp = -1000; // sentinel to avoid re-spawning
    // Spawn 3-5 wood chunks that fly outward and fall.
    const chunks = 4 + Math.floor(Math.random() * 2);
    for (let i = 0; i < chunks; i++) {
      const chunk = new THREE.Mesh(_debrisGeo, _debrisMat.clone());
      chunk.position.copy(post.userData.basePos);
      chunk.userData.kind = 'debris';
      chunk.userData.vel = new THREE.Vector3(
        (Math.random() - 0.5) * 4,
        Math.random() * 4 + 2,
        (Math.random() - 0.5) * 4
      );
      chunk.userData.angVel = new THREE.Vector3(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8
      );
      chunk.userData.life = 1.5;
      scene.add(chunk);
      debris.push(chunk);
    }
    // Hide the post so it doesn't visually remain.
    post.visible = false;
    // Remove attached cap.
    post.parent && post.parent.traverse?.((o) => {
      if (o.userData && o.userData.attachedTo === post) o.visible = false;
    });
  }
  return debris;
}