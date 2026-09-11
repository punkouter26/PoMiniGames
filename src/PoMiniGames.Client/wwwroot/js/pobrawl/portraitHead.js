// The portrait supplies geometry; each fighter supplies the game's materials.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const MODEL_URL = new URL('../../models/pobrawl/FacePortrait_HeadNeck_50k.glb', import.meta.url);
const SCALP_OFFSET = 0.075; // source units; about 1 cm after fitting to the rig
let portraitPromise;

export function loadPortraitHead() {
  // Cache CPU geometry only. Each round owns its GPU geometry and materials.
  portraitPromise ??= new GLTFLoader().loadAsync(MODEL_URL.href).then((gltf) => {
    const parts = [];
    const materials = new Set();
    const textures = new Set();
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((obj) => {
      if (!obj.isMesh) return;
      const geometry = obj.geometry.clone().applyMatrix4(obj.matrixWorld);
      if (/undercoat/i.test(obj.material.name)) {
        // The source scalp lies almost on the head. Separate it slightly so
        // solid game colors do not expose depth fighting hidden by the photo.
        const positions = geometry.getAttribute('position');
        const normals = geometry.getAttribute('normal');
        for (let i = 0; i < positions.count; i++) {
          positions.setXYZ(i,
            positions.getX(i) + normals.getX(i) * SCALP_OFFSET,
            positions.getY(i) + normals.getY(i) * SCALP_OFFSET,
            positions.getZ(i) + normals.getZ(i) * SCALP_OFFSET);
        }
      }
      // Photo vertex colors and UV sets do not belong to the procedural style.
      // Keep the first UV set for the game's shared pore/roughness textures.
      for (const key of Object.keys(geometry.attributes)) {
        if (!['position', 'normal', 'uv'].includes(key)) geometry.deleteAttribute(key);
      }
      if (!geometry.getAttribute('uv')) {
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(
          new Float32Array(geometry.getAttribute('position').count * 2), 2));
      }
      parts.push({ geometry, materialName: obj.material.name });
      obj.geometry.dispose();
      for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) {
        materials.add(mat);
        for (const value of Object.values(mat)) if (value?.isTexture) textures.add(value);
      }
    });
    for (const mat of materials) mat.dispose();
    const images = new Set();
    for (const tex of textures) { images.add(tex.image); tex.dispose(); }
    for (const image of images) image?.close?.();
    if (!parts.length) throw new Error('Portrait GLB contains no head geometry');
    return parts;
  }).catch((error) => {
    portraitPromise = null; // A later visit can retry a failed network request.
    throw error;
  });
  return portraitPromise;
}

export function buildPortraitHead(parts, config, dims, { faceMat, hairMat }) {
  // The imported hair includes thin, open surfaces, as in its source GLB.
  hairMat.side = THREE.DoubleSide;
  const sclera = new THREE.MeshStandardMaterial({ color: 0xf3eee5, roughness: 0.4 });
  const iris = new THREE.MeshStandardMaterial({ color: config.face?.eyes?.color ?? 0x4a3a28, roughness: 0.4 });
  const pupil = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.35 });
  const materials = [faceMat, hairMat, sclera, iris, pupil];
  const materialIndex = (name) => {
    if (/hair|undercoat/i.test(name)) return 1;
    if (/sclera/i.test(name)) return 2;
    if (/iris/i.test(name)) return 3;
    if (/pupils/i.test(name)) return 4;
    return 0;
  };
  const geometry = mergeGeometries(parts.map(p => p.geometry), true);
  if (!geometry) throw new Error('Portrait geometry could not be combined');
  geometry.groups.forEach((group, i) => { group.materialIndex = materialIndex(parts[i].materialName); });
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  // Fit the existing head envelope, with the neck bottom inside the collar.
  // Bake the fit into vertices: refs.skull must retain unit scale for swelling.
  geometry.translate(-center.x, -bounds.min.y, -center.z);
  geometry.scale((dims.w + 0.02) / size.x, (dims.h + 0.12) / size.y, (dims.d + 0.06) / size.z);
  geometry.translate(0, -0.225, 0); // skull pivot is +0.16 above the head joint
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.name = 'PlayerPortraitHead';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return {
    mesh,
    dispose() {
      geometry.dispose();
      // All five materials belong to this round; the cached template owns none.
      for (const material of materials) material.dispose();
    },
  };
}
