// arena.js — the fight ring, breakable props, low-poly crowd and lighting.
// Materials are MeshStandardMaterial so they read the key/rim lights and (optionally)
// the env map that the engine can attach at startup.
import * as THREE from 'three';

export const RING_HALF = 5.2; // playable clamp radius (ring is 12x12, keep a margin)

// Procedural ring-canvas texture: lavender-blue vinyl with scuff noise, a
// worn (lighter) center from footwork, and a faint center-ring logo.
let _canvasTex = null;
function ringCanvasTexture() {
  if (_canvasTex) return _canvasTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#3d4680';
  g.fillRect(0, 0, 256, 256);
  // Worn center: fighters shuffle here, the vinyl lightens.
  const wear = g.createRadialGradient(128, 128, 10, 128, 128, 120);
  wear.addColorStop(0, 'rgba(200,205,235,0.16)');
  wear.addColorStop(1, 'rgba(200,205,235,0)');
  g.fillStyle = wear;
  g.fillRect(0, 0, 256, 256);
  // Faint center-ring logo.
  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.lineWidth = 4;
  g.beginPath();
  g.arc(128, 128, 42, 0, Math.PI * 2);
  g.stroke();
  // Scuff noise.
  for (let i = 0; i < 2200; i++) {
    const v = Math.random();
    g.fillStyle = v > 0.5
      ? `rgba(255,255,255,${(v - 0.5) * 0.05})`
      : `rgba(0,0,20,${(0.5 - v) * 0.07})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1);
  }
  _canvasTex = new THREE.CanvasTexture(c);
  _canvasTex.colorSpace = THREE.SRGBColorSpace;
  return _canvasTex;
}

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

  // Ring canvas: procedurally textured glossy vinyl — worn center, faint
  // ring logo, scuff noise. Low roughness + env map give it the reflective
  // sheen that sells "lit mat in a dark hall".
  const canvasMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.55, metalness: 0.0,
    map: ringCanvasTexture(),
  });
  if (envMap) { canvasMat.envMap = envMap; canvasMat.envMapIntensity = 0.5; }
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
  // PBR materials in shadow still read some colour. All handles are returned
  // so the engine can dim the house for the KO "lights down" cinematic.
  const hemi = new THREE.HemisphereLight(0x9aa4ff, 0x1a1030, 0.55);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff1d0, 1.6);
  key.position.set(6, 12, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  // Frustum hugs the ring (fight area is ±5.2, posts at ±5.8) — tighter
  // bounds roughly double the effective shadow resolution vs the old ±10.
  key.shadow.camera.left = -6.5;
  key.shadow.camera.right = 6.5;
  key.shadow.camera.top = 6.5;
  key.shadow.camera.bottom = -6.5;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  // Penumbra blur (works with PCFShadowMap; PCFSoft ignores radius).
  key.shadow.radius = 4;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x6070ff, 0.7);
  rim.position.set(-5, 6, -6);
  scene.add(rim);

  const fill = new THREE.PointLight(0xffe0a0, 0.5, 30, 1.4);
  fill.position.set(0, 6, 0);
  scene.add(fill);

  // Overhead ring spotlight — the classic bright-pool-over-the-ring look.
  // Casts its own shadow so the KO close-up gets a tight overhead shadow
  // under the fallen body; during the KO cinematic the engine brightens it
  // and retargets it onto the loser.
  const spot = new THREE.SpotLight(0xfff4e0, 1.1, 30, Math.PI / 4.5, 0.45, 1.2);
  spot.position.set(0, 11, 0);
  spot.target.position.set(0, 0, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0005;
  spot.shadow.normalBias = 0.02;
  spot.shadow.radius = 6;
  scene.add(spot);
  scene.add(spot.target);

  // Corner identity lighting: red vs blue side, matching the HUD bars.
  // Fighters pick up a warm/cool gradient as they cross the ring.
  const cornerA = new THREE.PointLight(0xff3b30, 1.3, 8, 1.8);
  cornerA.position.set(-6.2, 1.4, 0);
  scene.add(cornerA);
  const cornerB = new THREE.PointLight(0x3b6bff, 1.3, 8, 1.8);
  cornerB.position.set(6.2, 1.4, 0);
  scene.add(cornerB);

  // Emissive apron trim: unlit strips along the canvas edges glow against
  // the dark arena (red side / blue side / dim violet ends).
  const trimRed = new THREE.MeshBasicMaterial({ color: 0xff5a4a });
  const trimBlue = new THREE.MeshBasicMaterial({ color: 0x4a7dff });
  const trimEnd = new THREE.MeshBasicMaterial({ color: 0x584a9c });
  const trimZ = new THREE.BoxGeometry(0.08, 0.05, 11.6);
  const trimX = new THREE.BoxGeometry(11.6, 0.05, 0.08);
  for (const [geo, mat, x, z] of [
    [trimZ, trimRed, -5.82, 0],
    [trimZ, trimBlue, 5.82, 0],
    [trimX, trimEnd, 0, -5.82],
    [trimX, trimEnd, 0, 5.82],
  ]) {
    const strip = new THREE.Mesh(geo, mat);
    strip.position.set(x, 0.06, z);
    scene.add(strip);
  }

  // Fake volumetrics: additive gradient cone under the spotlight + drifting
  // dust motes inside the beam.
  const atmo = buildAtmosphere(scene);

  // Crowd: 4 rows of low-poly silhouettes around the ring.
  // They're tagged userData.crowd so we can bounce them on KOs (wave animation).
  const crowd = buildCrowd(scene);
  scene.add(crowd);

  // Camera-flash sprites sparkle in the crowd (a storm of them on KO).
  const flashes = buildCrowdFlashes(scene);

  return {
    posts, crowd, atmo, flashes,
    lights: { hemi, key, rim, fill, spot, cornerA, cornerB },
  };
}

// ── Atmosphere: light shaft + dust ────────────────────────────────────────
// The cone is a cheap "volumetric" — an open cylinder with a vertical
// alpha-gradient, additive-blended so it reads as light in smoky air.
function buildAtmosphere(scene) {
  const c = document.createElement('canvas');
  c.width = 1; c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, 'rgba(255,244,224,0.55)');
  grad.addColorStop(1, 'rgba(255,244,224,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 64);
  const tex = new THREE.CanvasTexture(c);

  const cone = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 4.2, 10, 24, 1, true),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.09,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false,
    })
  );
  cone.position.y = 5.6;
  cone.renderOrder = 2;
  scene.add(cone);

  const COUNT = 50;
  const pos = new Float32Array(COUNT * 3);
  const dustSeed = [];
  for (let i = 0; i < COUNT; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 2.0;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = 0.5 + Math.random() * 8.5;
    pos[i * 3 + 2] = Math.sin(a) * r;
    dustSeed.push({ vy: 0.1 + Math.random() * 0.2, phase: Math.random() * Math.PI * 2 });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const dust = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xfff4e0, size: 0.05, transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false,
    sizeAttenuation: true, fog: false,
  }));
  scene.add(dust);
  return { cone, dust, dustSeed };
}

// Pool of billboard sprites reused as crowd camera flashes. Kept in their
// own group (same coordinate space — the crowd group has no transform) so
// animateCrowd's child loop never touches them.
function buildCrowdFlashes(scene) {
  const group = new THREE.Group();
  const pool = [];
  for (let i = 0; i < 20; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      depthWrite: false, fog: false,
    }));
    s.scale.setScalar(0.14);
    s.visible = false;
    group.add(s);
    pool.push({ sprite: s, life: 0 });
  }
  scene.add(group);
  return pool;
}

// Per-frame atmosphere update: dust drifts down the beam and wraps; crowd
// flashes fire occasionally at rest and in a storm while `excited` > 0.
export function updateAtmosphere(arena, dt, t, excited) {
  const { atmo, flashes, crowd } = arena;
  if (atmo) {
    const attr = atmo.dust.geometry.attributes.position;
    const arr = attr.array;
    for (let i = 0; i < atmo.dustSeed.length; i++) {
      const s = atmo.dustSeed[i];
      arr[i * 3 + 1] -= s.vy * dt;
      if (arr[i * 3 + 1] < 0.3) arr[i * 3 + 1] = 9.0;
      arr[i * 3] += Math.sin(t * 0.6 + s.phase) * 0.05 * dt;
      arr[i * 3 + 2] += Math.cos(t * 0.5 + s.phase) * 0.05 * dt;
    }
    attr.needsUpdate = true;
  }
  if (flashes && crowd) {
    const rate = 1.2 + excited * 22; // expected flashes per second
    if (Math.random() < rate * dt) {
      const free = flashes.find((f) => f.life <= 0);
      const members = crowd.children;
      if (free && members.length) {
        const m = members[(Math.random() * members.length) | 0];
        free.sprite.position.set(
          m.position.x + (Math.random() - 0.5) * 0.3,
          m.position.y + 1.0 + Math.random() * 0.25,
          m.position.z + (Math.random() - 0.5) * 0.3
        );
        free.life = 0.09;
        free.sprite.visible = true;
      }
    }
    for (const f of flashes) {
      if (f.life > 0) {
        f.life -= dt;
        f.sprite.material.opacity = Math.max(0, f.life / 0.09);
        if (f.life <= 0) f.sprite.visible = false;
      }
    }
  }
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