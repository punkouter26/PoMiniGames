// marbles.js — 8 identical sphere marbles (fair physics), progress + finish-order tracking.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { TRACK } from './track.js';

export const MARBLE_COLORS = [
  0x22d3ee, // cyan
  0xe879f9, // magenta
  0xa3e635, // lime
  0xfb923c, // orange
  0xf87171, // red
  0x60a5fa, // blue
  0xfde047, // yellow
  0xf472b6, // pink
];

export function hexString(i) {
  return '#' + MARBLE_COLORS[i].toString(16).padStart(6, '0');
}

const TRAIL_LEN = 16;

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
  const sphereGeo = new THREE.SphereGeometry(TRACK.MARBLE_R, 24, 18);
  const marbles = [];
  let finishCounter = 0;

  // Trails (#6) and contact blobs (#8) live in world space, so they sit in a sibling group
  // rather than under the (spinning) marble meshes.
  const decorations = new THREE.Group();
  const blobTex = blobTexture();
  const blobGeo = new THREE.CircleGeometry(TRACK.MARBLE_R * 1.5, 20);

  for (let i = 0; i < 8; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color: MARBLE_COLORS[i],
      // No emissive — the bloom post-pass was amplifying it into a halo, making the
      // marbles too bright. Let the environment map + base color carry the look.
      emissive: 0x000000,
      emissiveIntensity: 0,
      roughness: 0.12,   // glassy so the environment map reflects (#4)
      metalness: 0.6,
    });
    const mesh = new THREE.Mesh(sphereGeo, mat);
    mesh.position.copy(startPositions[i]);
    mesh.castShadow = true;     // #3 — marbles cast onto the chute
    mesh.receiveShadow = true;

    // Motion trail: a short additive streak that fades head→tail, coloured per marble.
    const trailPos = new Float32Array(TRAIL_LEN * 3);
    const trailCol = new Float32Array(TRAIL_LEN * 3);
    const baseCol = new THREE.Color(MARBLE_COLORS[i]);
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
    const trail = new THREE.Line(trailGeo, trailMat);
    trail.frustumCulled = false;
    decorations.add(trail);

    // Contact blob: a flat dark disc that tracks under the marble.
    const blob = new THREE.Mesh(blobGeo, new THREE.MeshBasicMaterial({
      map: blobTex, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false,
    }));
    blob.rotation.x = -Math.PI / 2;
    blob.renderOrder = 1;
    decorations.add(blob);

    // Highlight ring on the player's marble so it's findable on screen.
    // Plain white torus (no emissive) — the bloom pass was turning the previous
    // emissive ring into a bright halo around the player's marble.
    let ring = null;
    if (i === chosenIndex) {
      ring = new THREE.Mesh(
        new THREE.TorusGeometry(TRACK.MARBLE_R * 1.7, 0.18, 8, 28),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x000000, emissiveIntensity: 0 })
      );
      mesh.add(ring);
    }

    const body = new CANNON.Body({
      mass: 1,
      material: materials.marble,
      shape: new CANNON.Sphere(TRACK.MARBLE_R),
      position: new CANNON.Vec3(startPositions[i].x, startPositions[i].y, startPositions[i].z),
    });
    body.linearDamping = 0.01;
    body.angularDamping = 0.01;
    if (onCollide) {
      body.addEventListener('collide', (e) => {
        const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
        if (v > 1.2) onCollide(v, body.position, MARBLE_COLORS[i]);
      });
    }
    world.addBody(body);

    marbles.push({
      index: i, body, mesh, ring,
      trail, trailPos, blob,
      finished: false, finishOrder: -1, place: -1, finishTime: 0,
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
    try { world.removeBody(m.body); } catch { }
    m.mesh.visible = false;
    m.trail.visible = false;
    m.blob.visible = false;
    if (m.ring) m.ring.visible = false;
  }

  function sync() {
    for (const m of marbles) {
      if (m.eliminated) continue;
      m.mesh.position.copy(m.body.position);
      m.mesh.quaternion.copy(m.body.quaternion);
      m.speed = m.body.velocity.length();

      // Trail: shift the buffer back one and write the new head (#6).
      const tp = m.trailPos;
      for (let j = TRAIL_LEN - 1; j > 0; j--) {
        tp[j * 3] = tp[(j - 1) * 3];
        tp[j * 3 + 1] = tp[(j - 1) * 3 + 1];
        tp[j * 3 + 2] = tp[(j - 1) * 3 + 2];
      }
      tp[0] = m.body.position.x; tp[1] = m.body.position.y; tp[2] = m.body.position.z;
      m.trail.geometry.attributes.position.needsUpdate = true;

      // Contact blob sits just under the marble (#8).
      m.blob.position.set(m.body.position.x, m.body.position.y - TRACK.MARBLE_R * 0.92, m.body.position.z);
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

  // Max progress (0..1) across the marbles still in the race — feeds the HUD bar.
  function progress() {
    let max = 0;
    for (const m of marbles) { if (!m.eliminated) max = Math.max(max, m.body.position.z); }
    return Math.max(0, Math.min(1, max / TRACK.LENGTH));
  }

  // Attach the white highlight ring to the player's marble at pick time.
  function highlight(index) {
    for (const m of marbles) {
      if (m.ring) { m.mesh.remove(m.ring); m.ring.geometry.dispose(); m.ring.material.dispose(); m.ring = null; }
    }
    const m = marbles[index];
    if (!m) return;
    m.ring = new THREE.Mesh(
      new THREE.TorusGeometry(TRACK.MARBLE_R * 1.7, 0.18, 8, 28),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.0 })
    );
    m.mesh.add(m.ring);
  }

  function dispose() {
    for (const m of marbles) {
      world.removeBody(m.body);
      m.trail.geometry.dispose();
      m.trail.material.dispose();
      m.blob.material.dispose();
      // Dispose the highlight ring if this marble was the picked one at teardown.
      if (m.ring) { m.ring.geometry.dispose(); m.ring.material.dispose(); m.ring = null; }
    }
    sphereGeo.dispose();
    blobGeo.dispose();
  }

  return { marbles, decorations, sync, eliminate, checkFinishes, forceFinishRemaining, leaderboard, progress, highlight, dispose };
}
