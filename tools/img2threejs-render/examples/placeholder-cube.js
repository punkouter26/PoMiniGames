// Placeholder model used to smoke-test render.py end-to-end.
// Renders a navy cube (matches the chair reference palette for visual sanity).
import * as THREE from 'three';

export default function createModel({ scene, THREE }) {
  const g = new THREE.BoxGeometry(0.6, 0.6, 0.6);
  const m = new THREE.MeshStandardMaterial({ color: 0x1f3864, roughness: 0.7, metalness: 0.0 });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.y = 0.3;
  scene.add(mesh);
}
