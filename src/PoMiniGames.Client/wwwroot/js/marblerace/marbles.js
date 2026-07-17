// marbles.js — the 8-marble roster (each with its own physique), progress + finish-order tracking.
//
// The marbles used to be byte-identical spheres, which made the pick a pure 1-in-8 coin flip
// and gave a viewer nothing to attach to. Each one now has a name and a real physical build:
// radius, mass and damping vary across the roster, so "heavy" marbles carry momentum through
// the Gauntlet while "light" ones accelerate off the boost pads and get bullied in traffic.
// No archetype is strictly best — that's the design constraint on this table.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { TRACK } from './track.js';

// radius/mass/damping are absolute values, NOT scale factors — TRACK.MARBLE_R (1.0) is the
// base the track is dimensioned around, and these sit within ±20% of it so the start grid
// spacing (~3.3) still clears the widest pair.
export const MARBLE_ROSTER = [
  { name: 'Volt',    trait: 'Sprinter',      color: 0x22d3ee, radius: 0.88, mass: 0.75, linDamp: 0.004, angDamp: 0.004 },
  { name: 'Hex',     trait: 'Bouncer',       color: 0xe879f9, radius: 0.95, mass: 0.85, linDamp: 0.006, angDamp: 0.020 },
  { name: 'Sprout',  trait: 'All-rounder',   color: 0xa3e635, radius: 1.00, mass: 1.00, linDamp: 0.010, angDamp: 0.010 },
  { name: 'Ember',   trait: 'Brawler',       color: 0xfb923c, radius: 1.12, mass: 1.45, linDamp: 0.014, angDamp: 0.008 },
  { name: 'Scarlet', trait: 'Heavyweight',   color: 0xf87171, radius: 1.18, mass: 1.70, linDamp: 0.016, angDamp: 0.006 },
  { name: 'Azure',   trait: 'Glider',        color: 0x60a5fa, radius: 0.92, mass: 0.90, linDamp: 0.005, angDamp: 0.012 },
  { name: 'Sol',     trait: 'Wildcard',      color: 0xfde047, radius: 1.05, mass: 1.10, linDamp: 0.012, angDamp: 0.004 },
  { name: 'Blossom', trait: 'Featherweight', color: 0xf472b6, radius: 0.82, mass: 0.62, linDamp: 0.003, angDamp: 0.016 },
];

export const MARBLE_COLORS = MARBLE_ROSTER.map((m) => m.color);

export function hexString(i) {
  return '#' + MARBLE_COLORS[i].toString(16).padStart(6, '0');
}

const TRAIL_LEN = 16;

// The player's highlight ring. Deliberately NOT emissive: the bloom post-pass blows an emissive
// ring out into a bright halo that swallows the marble. Built in one place because the two
// call sites had drifted apart — the unused one was non-emissive and carried the comment
// explaining why, while the live one (highlight()) still set emissive white at full intensity,
// so the halo this was supposed to fix was never actually gone.
function makeRing(radius) {
  return new THREE.Mesh(
    new THREE.TorusGeometry(radius * 1.7, 0.18, 8, 28),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x000000, emissiveIntensity: 0 })
  );
}

// ── Floating pins ──
// Two questions the HUD couldn't answer while the race was moving: which marble is MINE, and
// which one is the camera on? A leaderboard tag can't answer either — you'd have to match a
// colour swatch to a ball in a moving pack of eight. These are billboarded labels pinned in
// world space above the marble itself, drawn with depthTest off so they stay readable through
// the chute walls and over the crest of a banked turn.
function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function makePinTexture(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 80;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 80);
  // Label body
  roundRectPath(g, 6, 4, 244, 48, 14);
  g.fillStyle = 'rgba(2, 6, 23, 0.88)';
  g.fill();
  g.strokeStyle = color;
  g.lineWidth = 5;
  g.stroke();
  // Downward tail so the label points AT the marble rather than floating near it
  g.beginPath();
  g.moveTo(114, 52); g.lineTo(142, 52); g.lineTo(128, 74);
  g.closePath();
  g.fillStyle = color;
  g.fill();

  g.font = 'bold 30px system-ui, "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  g.fillText(text, 128, 29);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makePin(text, color) {
  const tex = makePinTexture(text, color);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  }));
  sprite.scale.set(9, 2.8, 1);
  sprite.renderOrder = 10;   // over the chute, under nothing
  sprite.visible = false;
  return sprite;
}

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

  // Each marble now has its own radius, so geometry can't be shared across the roster the way
  // it was when all 8 were identical. Both geometries are owned per-marble and disposed below.
  for (let i = 0; i < MARBLE_ROSTER.length; i++) {
    const spec = MARBLE_ROSTER[i];
    const sphereGeo = new THREE.SphereGeometry(spec.radius, 24, 18);
    const blobGeo = new THREE.CircleGeometry(spec.radius * 1.5, 20);
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

    // Highlight ring on the player's marble so it's findable on screen. Attached at pick time
    // via highlight() — which is the only path, since every caller passes chosenIndex -1.
    let ring = null;
    if (i === chosenIndex) {
      ring = makeRing(spec.radius);
      mesh.add(ring);
    }

    const body = new CANNON.Body({
      mass: spec.mass,
      material: materials.marble,
      shape: new CANNON.Sphere(spec.radius),
      position: new CANNON.Vec3(startPositions[i].x, startPositions[i].y, startPositions[i].z),
    });
    body.linearDamping = spec.linDamp;
    body.angularDamping = spec.angDamp;
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
      spec, radius: spec.radius, sphereGeo, blobGeo,
      finished: false, finishOrder: -1, place: -1, finishTime: 0,
      // prevPlace lets the director spot an overtake without re-deriving standings.
      prevPlace: -1,
      eliminated: false,
      speed: 0,
    });
  }

  // The two pins. Built once and repositioned each sync() rather than reparented, so a
  // camera cut costs nothing and there's no per-cut allocation.
  let youPin = null;      // rebuilt on pick — the label carries the marble's own name/colour
  let youIndex = -1;
  const camPin = makePin('◉ ON AIR', '#f87171');
  let camIndex = -1;
  decorations.add(camPin);

  function setYou(index) {
    const m = marbles[index];
    if (youPin) {
      decorations.remove(youPin);
      youPin.material.map.dispose();
      youPin.material.dispose();
      youPin = null;
    }
    youIndex = m ? index : -1;
    if (!m) return;
    youPin = makePin(`YOU · ${m.spec.name}`, hexString(index));
    decorations.add(youPin);
  }

  // Which marble the camera director is currently on (game.js _pickShot).
  function setCameraFocus(index) { camIndex = index; }

  // Stack the pins above a marble: YOU sits closest to the ball, ON AIR above it, so when
  // the camera is on your own marble both read instead of overlapping into mush.
  function placePins() {
    if (youPin) {
      const m = marbles[youIndex];
      const show = !!m && !m.eliminated;
      youPin.visible = show;
      if (show) youPin.position.set(m.body.position.x, m.body.position.y + m.radius + 3.2, m.body.position.z);
    }
    const cm = marbles[camIndex];
    const showCam = !!cm && !cm.eliminated;
    camPin.visible = showCam;
    if (showCam) {
      const stacked = camIndex === youIndex ? 6.6 : 3.2;
      camPin.position.set(cm.body.position.x, cm.body.position.y + cm.radius + stacked, cm.body.position.z);
    }
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
      m.blob.position.set(m.body.position.x, m.body.position.y - m.radius * 0.92, m.body.position.z);
    }
    placePins();
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

  // Attach the white highlight ring to the player's marble at pick time.
  function highlight(index) {
    for (const m of marbles) {
      if (m.ring) { m.mesh.remove(m.ring); m.ring.geometry.dispose(); m.ring.material.dispose(); m.ring = null; }
    }
    const m = marbles[index];
    if (!m) return;
    m.ring = makeRing(m.radius);
    m.mesh.add(m.ring);
    setYou(index);   // the ring alone was too easy to lose in a pack of eight
  }

  function dispose() {
    if (youPin) { youPin.material.map.dispose(); youPin.material.dispose(); youPin = null; }
    camPin.material.map.dispose();
    camPin.material.dispose();
    for (const m of marbles) {
      // Eliminated/finished marbles already had their body pulled out of the world.
      try { world.removeBody(m.body); } catch { }
      m.trail.geometry.dispose();
      m.trail.material.dispose();
      m.blob.material.dispose();
      // Each marble owns its material AND (since the roster gave them different radii) its
      // sphere/blob geometry. Leaving any of it behind leaked GPU resources on every track
      // regeneration — and R regenerates on demand.
      m.mesh.material.dispose();
      m.sphereGeo.dispose();
      m.blobGeo.dispose();
      // Dispose the highlight ring if this marble was the picked one at teardown.
      if (m.ring) { m.ring.geometry.dispose(); m.ring.material.dispose(); m.ring = null; }
    }
  }

  return { marbles, decorations, sync, eliminate, checkFinishes, forceFinishRemaining, leaderboard, progress, progressOf, highlight, setCameraFocus, dispose };
}
