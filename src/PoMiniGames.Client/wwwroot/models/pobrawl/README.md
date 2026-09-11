FacePortrait_HeadNeck_50k.glb is the user-provided portrait, reduced to the head
and neck: 44,986 vertices, 39,300 triangles, one glTF mesh with 12 material
sections. The original embedded textures remain in this source asset.

PoBrawl loads it for the player-controlled fighter in 1P mode. portraitHead.js
combines the material sections into one Three.js mesh, fits it to the existing
head joint, and uses the fighter's procedural skin, hair, and eye materials.
The opponent, 2P mode, and demo mode keep their procedural heads.
