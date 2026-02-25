// @ts-nocheck
import * as THREE from 'three';
import { VoxelSimulation } from './VoxelSimulation';

export class InstancedVoxels {
    public mesh: THREE.InstancedMesh;
    private material: THREE.MeshStandardMaterial;
    private geometry: THREE.BoxGeometry;

    private sim: VoxelSimulation;

    constructor(sim: VoxelSimulation, count: number) {
        this.sim = sim;
        this.geometry = new THREE.BoxGeometry(1, 1, 1);

        // We add some basic UVs and color, but we'll modify the shader to read positions from GPGPU.
        this.material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.1,
            metalness: 0.2
        });

        const uvAttribute = new Float32Array(count * 2);
        for (let i = 0; i < count; i++) {
            // Calculate 2D UV coordinates corresponding to the 1D index
            const uvX = (i % sim.width) / sim.width;
            const uvY = Math.floor(i / sim.width) / sim.height;
            uvAttribute[i * 2 + 0] = uvX;
            uvAttribute[i * 2 + 1] = uvY;
        }

        // Pass the GPGPU data index to each instance so we can look up its texture pixel
        const referenceBuffer = new THREE.InstancedBufferAttribute(uvAttribute, 2);
        this.geometry.setAttribute('reference', referenceBuffer);

        this.material.onBeforeCompile = (shader) => {
            shader.uniforms.positionTexture = { value: null };

            shader.vertexShader = `
        uniform sampler2D positionTexture;
        attribute vec2 reference;
      ` + shader.vertexShader;

            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                `
        vec4 computePos = texture2D(positionTexture, reference);
        vec3 transformed = vec3(position);
        if (computePos.w >= 10.0) {
            transformed = vec3(0.0);
            computePos.xyz = vec3(-9999.0);
        }
        transformed += computePos.xyz;
        `
            );

            this.material.userData.shader = shader;
        };

        this.mesh = new THREE.InstancedMesh(this.geometry, this.material, count);

        // Disable frustum culling since all instances' bounding boxes won't reflect dynamic positions properly
        this.mesh.frustumCulled = false;
        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;

        // Apply default identity matrices
        // Apply default identity matrices and colors
        const dummy = new THREE.Object3D();
        const color = new THREE.Color();
        const size = 64; // same size as used in VoxelSimulation.ts

        for (let i = 0; i < count; i++) {
            this.mesh.setMatrixAt(i, dummy.matrix);

            // Reconstruct x, y, z to generate nice procedural colors
            const x = i % size;
            const y = Math.floor((i / size) % size);
            const z = Math.floor(i / (size * size));

            color.setHSL((x / size) * 0.8 + (y / size) * 0.2, 0.8, 0.4 + (z / size) * 0.4);
            this.mesh.setColorAt(i, color);
        }
        this.mesh.instanceMatrix.needsUpdate = true;
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }

    public update() {
        if (this.material.userData.shader) {
            this.material.userData.shader.uniforms.positionTexture.value = this.sim.getPositionTexture();
        }
    }
}
