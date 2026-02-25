// @ts-nocheck
import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js';
import { SpatialHashGrid } from './SpatialHashGrid';

export class VoxelSimulation {
  private renderer: THREE.WebGLRenderer;
  private computedRenderer: GPUComputationRenderer;

  public positionVariable: any;
  public velocityVariable: any;

  // Reduced by ~16-20x from previous value to massively improve performance
  public readonly width = 64;
  public readonly height = 64;

  private readBuffer: Float32Array;
  private forceTexture: THREE.DataTexture;
  private grid: SpatialHashGrid;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.computedRenderer = new GPUComputationRenderer(this.width, this.height, this.renderer);

    this.readBuffer = new Float32Array(this.width * this.height * 4);

    const forceData = new Float32Array(this.width * this.height * 4);
    this.forceTexture = new THREE.DataTexture(forceData, this.width, this.height, THREE.RGBAFormat, THREE.FloatType);
    this.forceTexture.needsUpdate = true;

    this.grid = new SpatialHashGrid(2.0); // 2x voxel size cell for quick query

    this.init();
  }

  private init() {
    const dtPosition = this.computedRenderer.createTexture();
    const dtVelocity = this.computedRenderer.createTexture();

    this.fillPositionTexture(dtPosition);
    this.fillVelocityTexture(dtVelocity);

    const positionShader = `
      uniform vec3 explosionPos;
      uniform float explosionActive;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture2D(texturePosition, uv);
        vec4 vel = texture2D(textureVelocity, uv);

        if (vel.w > 0.005 && vel.w < 10.0) {
          pos.xyz += vel.xyz * (1.0 / 60.0);
          
          if (pos.y <= 0.5) {
            pos.y = 0.5;
          }
        } else if (vel.w < 0.005 && explosionActive > 0.5) {
          float r = hash(uv + fract(explosionActive));
          if (r > 0.99) {
            pos.xyz = explosionPos + vec3(
               hash(uv * 1.1) * 2.0 - 1.0,
               hash(uv * 1.5) * 2.0 - 1.0,
               hash(uv * 1.9) * 2.0 - 1.0
            ) * 0.5;
          }
        }
        
        pos.w = vel.w;
        gl_FragColor = pos;
      }
    `;

    const velocityShader = `
      uniform vec3 explosionPos;
      uniform float explosionActive;
      uniform vec3 explosionDir;

      uniform sampler2D textureForce;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture2D(texturePosition, uv);
        vec4 vel = texture2D(textureVelocity, uv);
        vec4 force = texture2D(textureForce, uv);

        if (vel.w < 0.005 && explosionActive > 0.5) {
          float r = hash(uv + fract(explosionActive));
          if (r > 0.99) {
            vel.w = 0.01;
            
            vec3 scatter = vec3(
               hash(uv) * 2.0 - 1.0,
               abs(hash(uv + vec2(1.0, 0.0))) * 1.5,
               hash(uv + vec2(0.0, 1.0)) * 2.0 - 1.0
            );
            vec3 dir = normalize(explosionDir * 2.0 + scatter);
            
            vel.xyz = dir * (20.0 + hash(uv * 2.0) * 15.0);
          }
        }

        if (vel.w > 0.005 && vel.w < 10.0) {
          vel.xyz += force.xyz * (1.0 / 60.0);
          vel.y -= 9.8 * (1.0 / 60.0);

          if (pos.y <= 0.5) {
            vel.xyz *= 0.8;
            vel.y = max(0.0, vel.y * -0.3);
          }
          
          vel.w += 1.0 / 60.0;
        }

        if (vel.w >= 10.0) {
           vel.w = 10.0;
        }

        gl_FragColor = vel;
      }
    `;

    this.positionVariable = this.computedRenderer.addVariable('texturePosition', positionShader, dtPosition);
    this.velocityVariable = this.computedRenderer.addVariable('textureVelocity', velocityShader, dtVelocity);

    this.computedRenderer.setVariableDependencies(this.positionVariable, [this.positionVariable, this.velocityVariable]);
    this.computedRenderer.setVariableDependencies(this.velocityVariable, [this.positionVariable, this.velocityVariable]);

    this.positionVariable.material.uniforms.explosionPos = { value: new THREE.Vector3() };
    this.positionVariable.material.uniforms.explosionActive = { value: 0.0 };

    this.velocityVariable.material.uniforms.explosionPos = { value: new THREE.Vector3() };
    this.velocityVariable.material.uniforms.explosionActive = { value: 0.0 };
    this.velocityVariable.material.uniforms.explosionDir = { value: new THREE.Vector3(0, 0, 1) };
    this.velocityVariable.material.uniforms.textureForce = { value: this.forceTexture };

    const error = this.computedRenderer.init();
    if (error !== null) {
      console.error(error);
    }
  }

  private fillPositionTexture(texture: THREE.DataTexture) {
    const data = texture.image.data;
    if (!data) return;

    for (let i = 0; i < data.length; i += 4) {
      data[i + 0] = 0;
      data[i + 1] = -9999;
      data[i + 2] = 0;
      data[i + 3] = 0;
    }
  }

  private fillVelocityTexture(texture: THREE.DataTexture) {
    const data = texture.image.data;
    if (!data) return;
    for (let i = 0; i < data.length; i += 4) {
      data[i + 0] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
    }
  }

  public compute() {
    this.computedRenderer.compute();

    const renderTarget = this.computedRenderer.getCurrentRenderTarget(this.positionVariable);
    this.renderer.readRenderTargetPixels(renderTarget, 0, 0, this.width, this.height, this.readBuffer);

    this.grid.clear();
    const len = this.width * this.height;

    const activeIndices: number[] = [];

    for (let i = 0; i < len; i++) {
      const idx = i * 4;
      const x = this.readBuffer[idx];
      const y = this.readBuffer[idx + 1];
      const z = this.readBuffer[idx + 2];
      const timer = this.readBuffer[idx + 3];
      const isDynamic = timer > 0.005 && timer < 10.0;

      if (isDynamic) {
        this.grid.insert(i, x, y, z);
        activeIndices.push(i);
      }
    }

    const forceData = this.forceTexture.image.data;
    if (!forceData) return;
    forceData.fill(0);

    const repulsionStrength = 200.0;

    for (let currentId of activeIndices) {
      const idx = currentId * 4;
      const x = this.readBuffer[idx];
      const y = this.readBuffer[idx + 1];
      const z = this.readBuffer[idx + 2];

      const neighbors = this.grid.getNearby(x, y, z);
      let fx = 0, fy = 0, fz = 0;

      for (let neighborId of neighbors) {
        if (neighborId === currentId) continue;

        const nIdx = neighborId * 4;
        const nx = this.readBuffer[nIdx];
        const ny = this.readBuffer[nIdx + 1];
        const nz = this.readBuffer[nIdx + 2];

        const dx = x - nx;
        const dy = y - ny;
        const dz = z - nz;
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq > 0 && distSq < 1.0) {
          const dist = Math.sqrt(distSq);
          const overlap = 1.0 - dist;

          fx += (dx / dist) * overlap * repulsionStrength;
          fy += (dy / dist) * overlap * repulsionStrength;
          fz += (dz / dist) * overlap * repulsionStrength;
        }
      }

      forceData[idx] = fx;
      forceData[idx + 1] = fy;
      forceData[idx + 2] = fz;
    }

    this.forceTexture.needsUpdate = true;
  }

  public getPositionTexture() {
    return this.computedRenderer.getCurrentRenderTarget(this.positionVariable).texture;
  }

  // Trigger an explosion at a point
  public triggerExplosion(pos: THREE.Vector3, inwardDir?: THREE.Vector3) {
    const activeGen = Math.random() + 0.5;

    this.positionVariable.material.uniforms.explosionActive.value = activeGen;
    this.positionVariable.material.uniforms.explosionPos.value.copy(pos);

    this.velocityVariable.material.uniforms.explosionActive.value = activeGen;
    this.velocityVariable.material.uniforms.explosionPos.value.copy(pos);
    if (inwardDir) {
      this.velocityVariable.material.uniforms.explosionDir.value.copy(inwardDir);
    } else {
      this.velocityVariable.material.uniforms.explosionDir.value.set(0, 0, 1);
    }
  }
}
