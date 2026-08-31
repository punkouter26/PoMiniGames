// Map-stripped render model: same factory geometry, but every material replaced with
// a flat, unlit grey MeshBasicMaterial. Used for the blockout gate's "unlit,
// map-stripped evidence" screenshot — silhouette and structure only, no albedo/texture
// information that could let a texture stand in for real structure.
import * as THREE from "three";
import { createNavyUpholsteredChairModel } from "./createObjectModel.js";

export default function mapStrippedChair({ scene, renderer }) {
  const group = createNavyUpholsteredChairModel({
    wireframe: false,
    castShadow: false,
    receiveShadow: false,
  });
  const flat = new THREE.MeshBasicMaterial({ color: 0x9a9a9a });
  group.traverse((obj) => {
    if (obj.isMesh) {
      obj.material = flat;
      obj.castShadow = false;
      obj.receiveShadow = false;
    }
  });
  scene.add(group);
  // Kill the harness lights so nothing but the flat material shows.
  scene.traverse((obj) => {
    if (obj.isLight) obj.visible = false;
  });
  return group;
}
