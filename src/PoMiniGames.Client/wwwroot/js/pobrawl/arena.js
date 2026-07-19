// arena.js — the fight ring, breakable props, low-poly crowd and lighting.
// Materials are MeshStandardMaterial so they read the key/rim lights and (optionally)
// the env map that the engine can attach at startup.
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

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
  // Exponential haze instead of the old far-plane linear fog: the fighters
  // (4-6 m from camera) stay clean while the crowd rows and hall edges melt
  // progressively into the dark — "smoky arena air".
  scene.fog = new THREE.FogExp2(0x0d0f1a, 0.022);

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

  // Ropes: bendable bezier tubes with a spring-loaded midpoint. A fighter
  // pressed against the ring boundary bows the ropes on that side outward;
  // a hard rebound twangs them (see updateRopes / twangRope).
  const ropeMat = new THREE.MeshStandardMaterial({
    color: 0xd0d4f0, roughness: 0.85, metalness: 0.0,
  });
  const ropes = [];
  for (const y of [0.5, 0.9, 1.3]) {
    for (const axis of ['x', 'z']) {           // 'x' = runs along X (z = ±half)
      for (const sign of [-1, 1]) {
        const rope = {
          axis, sign, y, half,
          offset: 0, vel: 0, built: -1,
          mesh: new THREE.Mesh(undefined, ropeMat),
        };
        rope.mesh.geometry = ropeGeometry(rope);
        rope.built = 0;
        scene.add(rope.mesh);
        ropes.push(rope);
      }
    }
  }

  // Lights — slightly warmer key, bluer rim, plus a low ambient bounce so
  // PBR materials in shadow still read some colour. All handles are returned
  // so the engine can dim the house for the KO "lights down" cinematic.
  // Slightly lower than before — the RectArea rig panels below now carry a
  // share of the ambient level.
  // Hemisphere is a flat, directionless fill: every unit of it raises the floor
  // of the image without ever creating a highlight. At 0.42 it was lifting the
  // whole frame into a mid-grey haze with no true blacks. Keep just enough to
  // stop shadowed PBR surfaces going pure black, and let the key/spot/rig
  // panels (plus the raised exposure in game.js) build the contrast.
  const hemi = new THREE.HemisphereLight(0x9aa4ff, 0x1a1030, 0.14);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff1d0, 2.6);
  key.position.set(6, 12, 4);
  key.castShadow = true;
  // 4096 over the tight ±6.5 frustum (idea #7): halving the texel size gives
  // the fighters' contact shadows a crisp, grounded edge at the feet instead
  // of the mushy penumbra a 2048 map left toward the far side of the ring.
  key.shadow.mapSize.set(4096, 4096);
  // Frustum hugs the ring (fight area is ±5.2, posts at ±5.8) — tighter
  // bounds roughly double the effective shadow resolution vs the old ±10.
  key.shadow.camera.left = -6.5;
  key.shadow.camera.right = 6.5;
  key.shadow.camera.top = 6.5;
  key.shadow.camera.bottom = -6.5;
  key.shadow.bias = -0.0005;
  // normalBias trades shadow acne for peter-panning: too high and contact
  // shadows detach from the feet, which is most of why the fighters read as
  // floating. 0.02 over this frustum is more than the geometry needs.
  key.shadow.normalBias = 0.008;
  // NOTE: shadow.radius is ignored by PCFSoftShadowMap (it only applies to
  // PCFShadowMap/VSM), so the old radius=4 here was dead config — the softness
  // you see is PCFSoft's fixed kernel scaled by texel size. Penumbra is
  // therefore controlled by mapSize vs frustum extent, not by this value.
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x6070ff, 0.7);
  rim.position.set(-5, 6, -6);
  scene.add(rim);

  const fill = new THREE.PointLight(0xffe0a0, 0.35, 30, 1.4);
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
  // 2048 (idea #7): the KO cinematic pushes in on the tight overhead shadow
  // under the fallen body — 1024 pixelated its edge at that framing.
  spot.shadow.mapSize.set(2048, 2048);
  spot.shadow.bias = -0.0005;
  spot.shadow.normalBias = 0.02;
  spot.shadow.radius = 6;
  scene.add(spot);
  scene.add(spot.target);

  // Studio rig panels: two RectAreaLights angled over the ring give the
  // broad soft speculars on the vinyl and gradient falloff on the fighters
  // that point/spot lights can't fake. No shadows (RectArea can't cast) —
  // the key/spot still own shadowing.
  RectAreaLightUniformsLib.init();
  const rectA = new THREE.RectAreaLight(0xfff0d8, 2.6, 4.5, 3.2);
  rectA.position.set(-3.6, 8.5, 3.6);
  rectA.lookAt(0, 0, 0);
  scene.add(rectA);
  const rectB = new THREE.RectAreaLight(0xdfe6ff, 1.8, 4.5, 3.2);
  rectB.position.set(3.6, 8.5, -3.6);
  rectB.lookAt(0, 0, 0);
  scene.add(rectB);

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

  // Backdrop architecture (idea #3): overhead truss rig, hanging banners and a
  // jumbotron fill the black void behind the crowd so the ring reads as an
  // event in a hall, not a lit island in a vacuum. All dim/emissive and far
  // from the camera — cheap, and the fog swallows their edges.
  const backdrop = buildBackdrop(scene);

  // Crowd: 4 rows of low-poly silhouettes around the ring.
  // They're tagged userData.crowd so we can bounce them on KOs (wave animation).
  const crowd = buildCrowd(scene);
  scene.add(crowd);

  // Camera-flash sprites sparkle in the crowd (a storm of them on KO).
  const flashes = buildCrowdFlashes(scene);

  return {
    posts, crowd, atmo, flashes, ropes, backdrop,
    lights: { hemi, key, rim, fill, spot, cornerA, cornerB, rectA, rectB },
  };
}

// ── Backdrop architecture (idea #3) ─────────────────────────────────────────
// Everything here lives well outside the crowd ring and mostly above the
// fighters, so it never crowds the fight but gives the frame depth and a
// "big event" read: a square lighting truss overhead with rig-light blocks,
// four hanging banners, and a pair of emissive jumbotron screens. The
// jumbotron material is returned so the engine could pulse it, but it's fine
// left static.
function buildBackdrop(scene) {
  const group = new THREE.Group();
  group.userData.kind = 'backdrop';

  // Dark structural metal for trusses/frames — reads as silhouette against
  // the fog, catching only a little of the rig lights.
  const steel = new THREE.MeshStandardMaterial({
    color: 0x12141f, roughness: 0.7, metalness: 0.6,
  });

  // Overhead lighting truss: a square ring of box beams up in the rafters,
  // with cross-braces. Sits above the spotlight so its shadow never matters.
  const trussY = 9.4;
  const trussHalf = 7.5;
  const beamLong = new THREE.BoxGeometry(trussHalf * 2, 0.22, 0.22);
  const beamSideGeo = new THREE.BoxGeometry(0.22, 0.22, trussHalf * 2);
  for (const z of [-trussHalf, trussHalf]) {
    const beam = new THREE.Mesh(beamLong, steel);
    beam.position.set(0, trussY, z);
    group.add(beam);
  }
  for (const x of [-trussHalf, trussHalf]) {
    const beam = new THREE.Mesh(beamSideGeo, steel);
    beam.position.set(x, trussY, 0);
    group.add(beam);
  }
  // A few cross-braces so the truss reads as a lattice, not a bare square.
  const braceGeo = new THREE.BoxGeometry(trussHalf * 2, 0.1, 0.1);
  for (const z of [-3.5, 0, 3.5]) {
    const brace = new THREE.Mesh(braceGeo, steel);
    brace.position.set(0, trussY - 0.15, z);
    group.add(brace);
  }

  // Rig-light blocks clamped to the truss — small emissive lenses pointing
  // down at the ring. Purely decorative (the real lights are in buildArena).
  const lensGeo = new THREE.BoxGeometry(0.3, 0.18, 0.3);
  const lensColors = [0xfff2d0, 0xbcd0ff, 0xfff2d0, 0xffd0d0];
  let li = 0;
  for (const x of [-5, -1.7, 1.7, 5]) {
    for (const z of [-trussHalf, trussHalf]) {
      const lens = new THREE.Mesh(lensGeo, new THREE.MeshStandardMaterial({
        color: 0x0a0a0a, emissive: lensColors[li % lensColors.length],
        emissiveIntensity: 1.4, roughness: 0.4,
      }));
      lens.position.set(x, trussY - 0.28, z);
      group.add(lens);
      li++;
    }
  }

  // Hanging banners: tall vertical panels dropping from the truss on all four
  // sides, alternating red/blue to echo the corner identity. Unlit-ish
  // standard material so they sit back in the gloom.
  const bannerGeo = new THREE.PlaneGeometry(2.2, 4.0);
  const bannerRed = new THREE.MeshStandardMaterial({
    color: 0x6a1f22, roughness: 0.9, side: THREE.DoubleSide,
    emissive: 0x2a0a0c, emissiveIntensity: 0.4,
  });
  const bannerBlue = new THREE.MeshStandardMaterial({
    color: 0x1f2f6a, roughness: 0.9, side: THREE.DoubleSide,
    emissive: 0x0a1030, emissiveIntensity: 0.4,
  });
  const bannerSpots = [
    { x: -trussHalf + 0.3, z: 0, ry: Math.PI / 2, mat: bannerRed },
    { x: trussHalf - 0.3, z: 0, ry: Math.PI / 2, mat: bannerBlue },
    { x: 0, z: -trussHalf + 0.3, ry: 0, mat: bannerBlue },
    { x: 0, z: trussHalf - 0.3, ry: 0, mat: bannerRed },
  ];
  for (const b of bannerSpots) {
    const banner = new THREE.Mesh(bannerGeo, b.mat);
    banner.position.set(b.x, trussY - 2.3, b.z);
    banner.rotation.y = b.ry;
    group.add(banner);
  }

  // Jumbotron: two big emissive screens on the far ends (behind the crowd on
  // the ±Z sides, high up). A dim procedural "static" texture reads as a live
  // feed from a distance without needing to render one.
  const screenTex = jumbotronTexture();
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, fog: true });
  const frameGeo = new THREE.BoxGeometry(6.4, 3.4, 0.3);
  const screenGeo = new THREE.PlaneGeometry(6.0, 3.0);
  for (const sign of [-1, 1]) {
    const frame = new THREE.Mesh(frameGeo, steel);
    frame.position.set(0, 6.4, sign * 14);
    group.add(frame);
    // Screen sits 0.16 toward the ring from its frame so the frame never
    // occludes it, and faces inward (the −z screen faces +z, and vice-versa).
    const screen = new THREE.Mesh(screenGeo, screenMat);
    screen.position.set(0, 6.4, sign * 13.84);
    screen.rotation.y = sign > 0 ? Math.PI : 0;
    group.add(screen);
  }

  group.userData.screenMat = screenMat;
  scene.add(group);
  return group;
}

// Procedural jumbotron screen: a dim bluish glow with scanline banding and a
// blocky "crowd cam" smear — legible as a big screen only from across the hall.
let _jumboTex = null;
function jumbotronTexture() {
  if (_jumboTex) return _jumboTex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#0a1428';
  g.fillRect(0, 0, 128, 64);
  // Blocky colour smears — a fuzzy, unreadable live feed.
  for (let i = 0; i < 60; i++) {
    const hue = 200 + Math.random() * 60;
    g.fillStyle = `hsla(${hue}, 40%, ${30 + Math.random() * 30}%, 0.5)`;
    g.fillRect(Math.random() * 128, Math.random() * 64, 4 + Math.random() * 10, 3 + Math.random() * 8);
  }
  // Scanlines.
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let y = 0; y < 64; y += 2) g.fillRect(0, y, 128, 1);
  _jumboTex = new THREE.CanvasTexture(c);
  _jumboTex.colorSpace = THREE.SRGBColorSpace;
  return _jumboTex;
}

// ── Rope physics ──────────────────────────────────────────────────────────
// Each rope is a quadratic-bezier tube whose midpoint control rides a
// damped spring. Pressing bows it outward (and slightly down); releasing
// twangs it back with an underdamped snap.
const _ropeA = new THREE.Vector3();
const _ropeM = new THREE.Vector3();
const _ropeB = new THREE.Vector3();
function ropeGeometry(rope) {
  const { axis, sign, y, half, offset } = rope;
  if (axis === 'x') {
    _ropeA.set(-half, y, sign * half);
    _ropeB.set(half, y, sign * half);
    _ropeM.set(0, y - Math.abs(offset) * 0.18, sign * (half + offset * 1.6));
  } else {
    _ropeA.set(sign * half, y, -half);
    _ropeB.set(sign * half, y, half);
    _ropeM.set(sign * (half + offset * 1.6), y - Math.abs(offset) * 0.18, 0);
  }
  return new THREE.TubeGeometry(
    new THREE.QuadraticBezierCurve3(_ropeA.clone(), _ropeM.clone(), _ropeB.clone()),
    12, 0.022, 6);
}

// Per-frame rope solve. `fighters` is the engine's fighter list; a body
// leaning past the clamp margin presses the ropes on that side.
export function updateRopes(arena, dt, fighters) {
  if (!arena.ropes) return;
  const pressStart = RING_HALF - 0.55; // bodies this far out start pressing
  for (const rope of arena.ropes) {
    let target = 0;
    if (fighters) {
      for (const f of fighters) {
        const p = f.rig.root.position;
        const along = rope.axis === 'x' ? p.x : p.z;
        const out = (rope.axis === 'x' ? p.z : p.x) * rope.sign;
        if (Math.abs(along) > rope.half - 0.4) continue; // near the posts, not the span
        const press = out - pressStart;
        if (press > 0) {
          // The middle rope (torso height) takes the most load.
          const w = rope.y === 0.9 ? 1.1 : 0.6;
          target = Math.max(target, Math.min(0.55, press * w));
        }
      }
    }
    // Underdamped spring toward the press target — released ropes twang.
    rope.vel += ((target - rope.offset) * 55 - rope.vel * 7) * dt;
    rope.offset += rope.vel * dt;
    if (Math.abs(rope.offset - rope.built) > 0.004) {
      rope.mesh.geometry.dispose();
      rope.mesh.geometry = ropeGeometry(rope);
      rope.built = rope.offset;
    }
  }
}

// Impulse a side's ropes (rebound off the boundary): axis 'x'|'z' is the
// world axis the fighter was clamped on, sign which side.
export function twangRope(arena, clampAxis, sign, power = 1) {
  if (!arena.ropes) return;
  for (const rope of arena.ropes) {
    // A clamp on world X hits the ropes that run along Z at x = sign*half.
    const runsAlong = clampAxis === 'x' ? 'z' : 'x';
    if (rope.axis === runsAlong && rope.sign === sign) {
      rope.vel += 2.6 * power;
    }
  }
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

  // (Floating dust motes removed per user request — the shaft alone carries
  // the volumetric read.)
  return { cone };
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
  const { flashes, crowd } = arena;
  if (flashes && crowd) {
    const rate = 1.2 + excited * 22; // expected flashes per second
    if (Math.random() < rate * dt) {
      const free = flashes.find((f) => f.life <= 0);
      const spots = crowd.userData.spots;
      if (free && spots && spots.length) {
        const m = spots[(Math.random() * spots.length) | 0];
        free.sprite.position.set(
          m.x + (Math.random() - 0.5) * 0.3,
          m.y + 0.15 + Math.random() * 0.25,
          m.z + (Math.random() - 0.5) * 0.3
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

// GPU-instanced crowd: all torsos in one InstancedMesh, all heads in another
// (2 draw calls total, was ~290 as individual meshes). The idle sway and the
// excited bounce moved into the vertex shader — a per-instance phase
// attribute plus shared uTime/uExcited uniforms displace each spectator.
// Instances only rotate about Y, so an object-space +Y offset in
// begin_vertex IS a world-space bounce.
function crowdBounceMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uExcited = uniforms.uExcited;
    shader.vertexShader = `
      uniform float uTime;
      uniform float uExcited;
      attribute float aPhase;
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      float crowdPhase = aPhase + uTime * 1.4;
      transformed.y += sin(crowdPhase) * 0.025
        + sin(crowdPhase * 1.8) * 0.18 * uExcited;`);
  };
  return mat;
}

function buildCrowd(scene) {
  const group = new THREE.Group();
  group.userData.kind = 'crowd';

  const skins = [0xb88a6a, 0x6b4a32, 0xd8a67f, 0x8a5d3f];
  const shirts = [0x4a4a4a, 0x252540, 0x5a2f2f, 0x2f4a3a, 0x3a3a5c, 0x6b5a2f];

  const ring = 7.6;
  const rows = [
    { r: ring, count: 24 },
    { r: ring + 1.6, count: 32 },
    { r: ring + 3.4, count: 40 },
    { r: ring + 5.5, count: 48 },
  ];
  const total = rows.reduce((n, r) => n + r.count, 0);

  const uniforms = { uTime: { value: 0 }, uExcited: { value: 0 } };
  const torsoMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.42, 0.9, 0.28), crowdBounceMaterial(uniforms), total);
  const headMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.24, 0.26, 0.24), crowdBounceMaterial(uniforms), total);
  torsoMesh.castShadow = false;
  headMesh.castShadow = false;

  const phases = new Float32Array(total);
  const spots = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const color = new THREE.Color();

  let id = 0;
  for (const row of rows) {
    for (let i = 0; i < row.count; i++) {
      const a = (i / row.count) * Math.PI * 2 + (Math.random() - 0.5) * 0.05;
      const x = Math.sin(a) * row.r + (Math.random() - 0.5) * 0.4;
      const z = Math.cos(a) * row.r + (Math.random() - 0.5) * 0.4;
      const y = -0.45;
      const heightJitter = 0.92 + Math.random() * 0.18;
      const yaw = Math.atan2(-x, -z) + (Math.random() - 0.5) * 0.6;
      q.setFromAxisAngle(up, yaw);

      // Torso: height jitter via Y scale (its box is 0.9 tall around origin).
      s.set(1, heightJitter, 1);
      p.set(x, y + 0.45 * heightJitter, z);
      m.compose(p, q, s);
      torsoMesh.setMatrixAt(id, m);
      torsoMesh.setColorAt(id, color.setHex(shirts[(Math.random() * shirts.length) | 0]));

      s.set(1, 1, 1);
      p.set(x, y + 1.05 * heightJitter, z);
      m.compose(p, q, s);
      headMesh.setMatrixAt(id, m);
      headMesh.setColorAt(id, color.setHex(skins[(Math.random() * skins.length) | 0]));

      phases[id] = Math.random() * Math.PI * 2;
      spots.push({ x, y: y + 1.05 * heightJitter, z });
      id++;
    }
  }
  const phaseAttr = new THREE.InstancedBufferAttribute(phases, 1);
  torsoMesh.geometry.setAttribute('aPhase', phaseAttr);
  headMesh.geometry.setAttribute('aPhase', phaseAttr);
  torsoMesh.instanceMatrix.needsUpdate = true;
  headMesh.instanceMatrix.needsUpdate = true;
  if (torsoMesh.instanceColor) torsoMesh.instanceColor.needsUpdate = true;
  if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;

  group.add(torsoMesh, headMesh);
  group.userData.uniforms = uniforms;
  // Head positions for the camera-flash sprites (updateAtmosphere).
  group.userData.spots = spots;
  return group;
}

// Animate the crowd: the sway/bounce runs in the vertex shader now — this
// just feeds the clock and excitement uniforms. Called from the engine's
// _updateCrowd at render rate.
export function animateCrowd(crowd, dt, t, excited) {
  if (!crowd || !crowd.userData.uniforms) return;
  crowd.userData.uniforms.uTime.value = t;
  crowd.userData.uniforms.uExcited.value = excited;
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