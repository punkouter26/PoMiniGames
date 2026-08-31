# img2threejs render harness

Playwright-driven Three.js render harness used by the img2threejs skill's vision-gate loop.

## Files

- `index.html` — single-page harness. Loads `three@0.160.0` from unpkg via importmap, mounts a
  PerspectiveCamera at a deterministic pose, three-point lights, OrbitControls, and an empty
  scene. Accepts a model URL via `?model=<path>` and a few camera/background overrides.
- `render.py` — Playwright driver. Launches headless Chromium, navigates to the harness, waits
  for `window.__modelReady === true`, screenshots the viewport to PNG.

## Quick start

```powershell
# Render a placeholder cube (no model supplied). Tests the harness end-to-end.
py tools/img2threejs-render/render.py <out-dir>\placeholder.png
# Render a model file. The model must be an ES module whose default export is a function
# `({ scene, THREE, camera, renderer }) => Group | Promise<Group>`.
py tools/img2threejs-render/render.py <model.js> <out-dir>\model.png
```

## Model contract

A model module is an ES module that exports a factory. The harness calls the factory
once after the scene is set up. The factory may return a `THREE.Group` (which the harness
adds to the scene for you) **or** it may add the geometry directly to `scene` and return
nothing. Both are accepted.

Minimal example:

```js
// tools/img2threejs-render/examples/placeholder-cube.js
import * as THREE from 'three';

export default function createModel({ scene, THREE }) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const m = new THREE.MeshStandardMaterial({ color: 0x4080c8, roughness: 0.6 });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.y = 0.5;
  scene.add(mesh);
}
```

## Camera overrides

The harness defaults to a 35° FOV camera at distance 2.6, azimuth 35°, elevation -12°, looking
at `(0, 0.5, 0)`. To override, append query parameters:

```powershell
py tools/img2threejs-render/render.py model.js out.png "distance=3.5&azimuth=20&elevation=-5"
```

Available parameters: `distance`, `azimuth`, `elevation`, `bg` (CSS color), `model`.

## Why a local HTTP server?

ES-module `import()` over `file://` is unreliable in headless Chromium (CORS surprises,
importmap resolution). The render driver starts a one-shot Python HTTP server rooted at the
harness directory, navigates to `http://127.0.0.1:<port>/index.html`, and tears the server down
on exit.
