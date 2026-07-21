// marbles.js — a 101-marble field (1 red player marble + 100 blue AI), progress + finish
// tracking.
//
// The field is now one RED marble the player steers against a pack of 100 identical BLUE
// marbles. Every marble is physically identical (same radius/mass/damping), so a race is
// decided purely by steering skill and the scramble of the pack — there's no per-marble build
// to pick anymore. To keep 101 marbles cheap, the blue pack shares a single geometry and
// material and carries no trails/blobs/shadows; only the red player marble gets the full
// treatment (own material, motion trail, contact blob, collision sparks).
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { TRACK } from './track.js';

export const MARBLE_COUNT = 101;    // 1 red player + 100 blue AI
export const PLAYER_INDEX = 0;      // index 0 is the red marble the player controls

const RED = 0xef4444;   // the player
const BLUE = 0x3b82f6;  // the pack

// Kept as an array so the rest of the engine can still look a marble up by index. Physically
// uniform — index 0 is red, everything else blue.
//
// Real glass marble: at the world scale of 1 unit = 1 cm, a radius-1 marble is 20 mm across,
// and solid soda-lime glass (~2500 kg/m³) makes that ≈ 10.5 g. Mass is carried here as 1.0
// "marble unit" (the obstacle masses in track.js are multiples of it), and cannon-es derives a
// real SOLID-SPHERE moment of inertia (I = 2/5·m·r²) from the sphere shape — so the marbles
// carry realistic rotational momentum and roll true. Damping is near zero: real glass has
// negligible rolling resistance and air drag at this size, so a marble keeps its spin.
export const MARBLE_ROSTER = Array.from({ length: MARBLE_COUNT }, (_, i) => ({
  name: i === PLAYER_INDEX ? 'You' : 'Marble',
  color: i === PLAYER_INDEX ? RED : BLUE,
  radius: 1.0, mass: 1.0, linDamp: 0.003, angDamp: 0.002,
}));

export const MARBLE_COLORS = MARBLE_ROSTER.map((m) => m.color);

const TRAIL_LEN = 16;

// ── Marker chrome: deliberately none ──
// There used to be a white highlight ring around the player's marble and two billboarded pins
// above it ('YOU' and '◉ ON AIR'). All three are gone. They existed to answer "which marble is
// mine?" back when the field was eight differently-coloured marbles that the camera could cut
// away from. Neither condition holds now: the player is the ONE red marble in a pack of 100
// identical blue ones, and the camera stays locked to it for the whole race (game.js _pickShot),
// so the marble you steer is the red one in the middle of the screen. The ring and pins were
// just occluding it.

// Soft radial-gradient disc used as a fake contact shadow under each marble (#8). Built once.
let _blobTex = null;
function blobTexture() {
  if (_blobTex) return _blobTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  _blobTex = new THREE.CanvasTexture(c);
  return _blobTex;
}

export function createMarbles(world, materials, startPositions, chosenIndex, onCollide) {
  const marbles = [];
  let finishCounter = 0;

  // Trails (#6) and contact blobs (#8) live in world space, so they sit in a sibling group
  // rather than under the (spinning) marble meshes.
  const decorations = new THREE.Group();
  const blobTex = blobTexture();

  // The 100 blue marbles are identical, so they SHARE one geometry + one material — the whole
  // point of making them uniform is that the pack is cheap to draw. The red player marble owns
  // its own geometry/material (and is the only marble with a trail, blob, ring, pins and
  // collision sparks). Low-poly blue sphere: 100 of them, so the segment count matters.
  const blueGeo = new THREE.SphereGeometry(1.0, 16, 12);
  const blueMat = new THREE.MeshStandardMaterial({
    color: BLUE, emissive: 0x000000, emissiveIntensity: 0, roughness: 0.18, metalness: 0.5,
  });

  for (let i = 0; i < MARBLE_COUNT; i++) {
    const spec = MARBLE_ROSTER[i];
    const isPlayer = i === PLAYER_INDEX;
    const radius = spec.radius;

    let sphereGeo, mat;
    if (isPlayer) {
      sphereGeo = new THREE.SphereGeometry(radius, 24, 18);
      mat = new THREE.MeshStandardMaterial({
        color: RED, emissive: 0x3b0a0a, emissiveIntensity: 0.25, roughness: 0.1, metalness: 0.5,
      });
    } else {
      sphereGeo = blueGeo; mat = blueMat;   // shared — do NOT dispose per-marble
    }
    const mesh = new THREE.Mesh(sphereGeo, mat);
    mesh.position.copy(startPositions[i]);
    // Only the player casts/receives shadows — 100 shadow-casters would swamp the shadow map.
    mesh.castShadow = isPlayer;
    mesh.receiveShadow = isPlayer;

    // Trail + contact blob are the player's alone (a trail per blue marble would be 100 extra
    // draw calls for marbles you're not watching).
    let trail = null, trailPos = null, blob = null, blobGeo = null;
    if (isPlayer) {
      trailPos = new Float32Array(TRAIL_LEN * 3);
      const trailCol = new Float32Array(TRAIL_LEN * 3);
      const baseCol = new THREE.Color(RED);
      for (let j = 0; j < TRAIL_LEN; j++) {
        trailPos[j * 3] = startPositions[i].x;
        trailPos[j * 3 + 1] = startPositions[i].y;
        trailPos[j * 3 + 2] = startPositions[i].z;
        const f = 1 - j / TRAIL_LEN;
        trailCol[j * 3] = baseCol.r * f; trailCol[j * 3 + 1] = baseCol.g * f; trailCol[j * 3 + 2] = baseCol.b * f;
      }
      const trailGeo = new THREE.BufferGeometry();
      trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
      trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
      const trailMat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      trail = new THREE.Line(trailGeo, trailMat);
      trail.frustumCulled = false;
      decorations.add(trail);

      blobGeo = new THREE.CircleGeometry(radius * 1.5, 20);
      blob = new THREE.Mesh(blobGeo, new THREE.MeshBasicMaterial({
        map: blobTex, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false,
      }));
      blob.rotation.x = -Math.PI / 2;
      blob.renderOrder = 1;
      decorations.add(blob);
    }

    const body = new CANNON.Body({
      mass: spec.mass,
      material: materials.marble,
      shape: new CANNON.Sphere(radius),
      position: new CANNON.Vec3(startPositions[i].x, startPositions[i].y, startPositions[i].z),
    });
    body.linearDamping = spec.linDamp;
    body.angularDamping = spec.angDamp;
    // Only the player's collisions make sparks/sound — 100 marbles clattering would be a spark
    // firehose and an audio wall.
    if (onCollide && isPlayer) {
      body.addEventListener('collide', (e) => {
        const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
        if (v > 1.2) onCollide(v, body.position, RED);
      });
    }
    world.addBody(body);

    marbles.push({
      index: i, body, mesh,
      trail, trailPos, blob,
      spec, radius, sphereGeo, blobGeo,
      finished: false, finishOrder: -1, place: -1, finishTime: 0,
      // prevPlace lets the director spot an overtake without re-deriving standings.
      prevPlace: -1,
      eliminated: false,
      speed: 0,
    });
  }

  // Remove a marble that has fallen off the track: pull its body out of the
  // world (safe here — this runs from the frame loop, never inside a contact
  // callback) and hide its visuals. It no longer counts toward the race.
  function eliminate(m) {
    if (m.eliminated) return;
    m.eliminated = true;
    // Clear the stale placing. leaderboard() only ranks marbles still in the race, so an
    // eliminated marble would otherwise keep whatever place it held on the frame before it
    // fell — and a player eliminated while running 2nd would be scored a top-3 finish.
    m.place = -1;
    try { world.removeBody(m.body); } catch { }
    m.mesh.visible = false;
    if (m.trail) m.trail.visible = false;
    if (m.blob) m.blob.visible = false;
  }

  function sync() {
    for (const m of marbles) {
      if (m.eliminated) continue;
      m.mesh.position.copy(m.body.position);
      m.mesh.quaternion.copy(m.body.quaternion);
      m.speed = m.body.velocity.length();

      // Trail + blob belong to the player marble only (both null on the blue pack).
      if (m.trail) {
        // Trail: shift the buffer back one and write the new head (#6).
        const tp = m.trailPos;
        for (let j = TRAIL_LEN - 1; j > 0; j--) {
          tp[j * 3] = tp[(j - 1) * 3];
          tp[j * 3 + 1] = tp[(j - 1) * 3 + 1];
          tp[j * 3 + 2] = tp[(j - 1) * 3 + 2];
        }
        tp[0] = m.body.position.x; tp[1] = m.body.position.y; tp[2] = m.body.position.z;
        m.trail.geometry.attributes.position.needsUpdate = true;
      }
      // Contact blob sits just under the marble (#8).
      if (m.blob) m.blob.position.set(m.body.position.x, m.body.position.y - m.radius * 0.92, m.body.position.z);
    }
  }

  // Record finish order + time as marbles cross the finish plane. Returns
  // { allDone, justFinished } where justFinished lists marbles that crossed on
  // THIS tick (so the caller can fire confetti + a chime per finisher).
  // Stop a marble dead on the finish line: zero its motion and pull the body out
  // of the physics world so it freezes exactly where it crossed instead of rolling
  // off the end and falling. The mesh stays visible (sync keeps drawing it at the
  // frozen position), and with no body it can't block or bump trailing marbles.
  // Safe here — called from the frame loop, never inside a contact callback.
  function freezeMarble(m) {
    m.body.velocity.set(0, 0, 0);
    m.body.angularVelocity.set(0, 0, 0);
    try { world.removeBody(m.body); } catch { }
  }

  function checkFinishes(finishZ, raceClock) {
    const justFinished = [];
    for (const m of marbles) {
      if (m.eliminated || m.finished) continue;
      if (m.body.position.z >= finishZ) {
        m.finished = true;
        m.finishOrder = finishCounter++;
        m.finishTime = raceClock || 0;
        freezeMarble(m);
        justFinished.push(m);
      }
    }
    // The race is done once every marble still in it has finished (eliminated
    // marbles are out and no longer block completion).
    const allDone = marbles.every((m) => m.finished || m.eliminated);
    return { allDone, justFinished };
  }

  // Force-finish any stragglers (failsafe) ordered by current progress.
  function forceFinishRemaining(raceClock) {
    const rest = marbles.filter((m) => !m.finished && !m.eliminated).sort((a, b) => b.body.position.z - a.body.position.z);
    for (const m of rest) { m.finished = true; m.finishOrder = finishCounter++; m.finishTime = raceClock || 0; freezeMarble(m); }
  }

  // Live ordering (excludes eliminated marbles): finished first (by finish
  // order), then unfinished by progress.
  function leaderboard() {
    const order = marbles.filter((m) => !m.eliminated).sort((a, b) => {
      if (a.finished && b.finished) return a.finishOrder - b.finishOrder;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.body.position.z - a.body.position.z;
    });
    order.forEach((m, idx) => { m.place = idx + 1; });
    return order;
  }

  // Max progress (0..1) across the marbles still in the race — the LEADER's progress.
  function progress() {
    let max = 0;
    for (const m of marbles) { if (!m.eliminated) max = Math.max(max, m.body.position.z); }
    return Math.max(0, Math.min(1, max / TRACK.LENGTH));
  }

  // One marble's own progress (0..1). The HUD showed only progress() above, so the bar
  // tracked the leader — a player running last watched a bar that wasn't theirs fill up.
  function progressOf(m) {
    if (!m) return 0;
    return Math.max(0, Math.min(1, m.body.position.z / TRACK.LENGTH));
  }

  function dispose() {
    // The blue pack shares one geometry + one material — dispose them ONCE here, not per-marble.
    blueGeo.dispose();
    blueMat.dispose();
    for (const m of marbles) {
      // Eliminated/finished marbles already had their body pulled out of the world.
      try { world.removeBody(m.body); } catch { }
      // Trail/blob/red-material/red-geometry are owned by the player marble only.
      if (m.trail) { m.trail.geometry.dispose(); m.trail.material.dispose(); }
      if (m.blob) m.blob.material.dispose();
      if (m.index === PLAYER_INDEX) {
        m.mesh.material.dispose();
        m.sphereGeo.dispose();
        if (m.blobGeo) m.blobGeo.dispose();
      }
    }
  }

  return { marbles, decorations, sync, eliminate, checkFinishes, forceFinishRemaining, leaderboard, progress, progressOf, dispose };
}
