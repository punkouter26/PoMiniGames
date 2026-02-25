// @ts-nocheck
/**
 * Unified Particle Pool System
 * Consolidates ParticleEmitter and DebrisSystem into a single optimized pool
 * - Type 0: Spark particles (fast-moving, short-lived, visual-only)
 * - Type 1: Debris chunks (physics-based, settles, piles up)
 */
import * as THREE from 'three';

interface Particle {
  type: 0 | 1;  // 0=spark, 1=debris
  age: number;
  maxAge: number;
  gridKey?: string;
  settled?: boolean;
  expired?: boolean;
}

export class ParticlePool {
  private scene: THREE.Scene;
  private maxParticles = 155000; // 5k sparks + 150k debris

  private sparkPoints: THREE.Points;
  private debrisMesh: THREE.InstancedMesh;

  private particles: Particle[] = [];
  private positions: Float32Array;
  private velocities: Float32Array;
  private colors: Float32Array;

  private activeSparkCount = 0;
  private activeDebrisCount = 0;

  private heightMap: Map<string, number> = new Map();
  private dummy = new THREE.Object3D();
  private csm: any;

  constructor(scene: THREE.Scene, csm: any = null) {
    this.scene = scene;
    this.csm = csm;

    const sparkGeo = new THREE.BufferGeometry();
    this.positions = new Float32Array(this.maxParticles * 3);
    this.velocities = new Float32Array(this.maxParticles * 3);
    this.colors = new Float32Array(this.maxParticles * 3);

    sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));

    const sparkMat = new THREE.PointsMaterial({
      color: 0xffff55,
      size: 0.8,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.sparkPoints = new THREE.Points(sparkGeo, sparkMat);
    this.sparkPoints.frustumCulled = false;
    this.scene.add(this.sparkPoints);

    const debrisGeo = new THREE.BoxGeometry(0.45, 0.45, 0.45);
    const debrisMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

    this.debrisMesh = new THREE.InstancedMesh(debrisGeo, debrisMat, this.maxParticles);
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    (this.debrisMesh as any).instanceColor?.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.castShadow = false;
    this.debrisMesh.receiveShadow = false;
    this.scene.add(this.debrisMesh);

    for (let i = 0; i < this.maxParticles; i++) {
      this.particles.push({ type: 0, age: -1, maxAge: 0, expired: false });
    }
  }

  /**
   * Spawn spark particles at a position
   */
  public spawnSparks(origin: THREE.Vector3, normal: THREE.Vector3, count: number = 20): void {
    for (let i = 0; i < count; i++) {
      if (this.activeSparkCount >= 5000) return;

      const idx = this.activeSparkCount;
      const particle = this.particles[idx];

      particle.type = 0;
      particle.age = 0;
      particle.maxAge = Math.random() * 0.2 + 0.1;

      this.positions[idx * 3] = origin.x;
      this.positions[idx * 3 + 1] = origin.y;
      this.positions[idx * 3 + 2] = origin.z;

      const bounce = normal.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2
      )).normalize();

      const speed = Math.random() * 80 + 40;
      this.velocities[idx * 3] = bounce.x * speed;
      this.velocities[idx * 3 + 1] = bounce.y * speed;
      this.velocities[idx * 3 + 2] = bounce.z * speed;

      this.colors[idx * 3] = 1.0;
      this.colors[idx * 3 + 1] = 1.0;
      this.colors[idx * 3 + 2] = 0.33;

      this.activeSparkCount++;
    }

    this.sparkPoints.geometry.attributes.position.needsUpdate = true;
    this.sparkPoints.visible = this.activeSparkCount > 0;
  }

  /**
   * Spawn debris chunks at positions
   */
  public spawnDebris(spawnPos: THREE.Vector3[], sourceVelocity: THREE.Vector3, colorHex: number): void {
    const color = new THREE.Color(colorHex);

    for (const p of spawnPos) {
      if (this.activeDebrisCount >= this.maxParticles - 5000) return;

      const idx = 5000 + this.activeDebrisCount;
      const particle = this.particles[idx];

      particle.type = 1;
      particle.age = 0;
      particle.maxAge = 3.0;
      particle.settled = false;
      particle.expired = false;

      this.positions[idx * 3] = p.x;
      this.positions[idx * 3 + 1] = p.y;
      this.positions[idx * 3 + 2] = p.z;

      const randDir = new THREE.Vector3(
        (Math.random() - 0.5),
        (Math.random() - 0.5) + 0.5,
        (Math.random() - 0.5)
      ).normalize().multiplyScalar(Math.random() * 5 + 2);

      this.velocities[idx * 3] = sourceVelocity.x + randDir.x;
      this.velocities[idx * 3 + 1] = sourceVelocity.y + randDir.y;
      this.velocities[idx * 3 + 2] = sourceVelocity.z + randDir.z;

      this.colors[idx * 3] = color.r;
      this.colors[idx * 3 + 1] = color.g;
      this.colors[idx * 3 + 2] = color.b;

      this.dummy.position.copy(p);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.debrisMesh.setMatrixAt(idx, this.dummy.matrix);
      this.debrisMesh.setColorAt(idx, color);

      this.activeDebrisCount++;
    }

    this.debrisMesh.instanceMatrix.needsUpdate = true;
    if (this.debrisMesh.instanceColor) this.debrisMesh.instanceColor.needsUpdate = true;
    this.debrisMesh.count = 5000 + this.activeDebrisCount;
  }

  /**
   * Update all particles
   */
  public update(delta: number): void {
    let sparkNeedsUpdate = false;
    let debrisNeedsUpdate = false;

    const pos = new THREE.Vector3();

    // Update sparks
    for (let i = 0; i < this.activeSparkCount; i++) {
      const particle = this.particles[i];
      particle.age += delta;

      if (particle.age > particle.maxAge) {
        continue;
      }

      // Gravity
      this.velocities[i * 3 + 1] -= 90.0 * delta;

      this.positions[i * 3] += this.velocities[i * 3] * delta;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * delta;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * delta;

      sparkNeedsUpdate = true;
    }

    if (sparkNeedsUpdate) {
      this.sparkPoints.geometry.attributes.position.needsUpdate = true;
    }

    // Update debris
    for (let i = 0; i < this.activeDebrisCount; i++) {
      const idx = 5000 + i;
      const particle = this.particles[idx];

      particle.age += delta;

      if (particle.age >= particle.maxAge) {
        if (!particle.expired) {
          particle.expired = true;
          this.dummy.position.set(0, -10000, 0);
          this.dummy.scale.set(0, 0, 0);
          this.dummy.updateMatrix();
          this.debrisMesh.setMatrixAt(idx, this.dummy.matrix);
          debrisNeedsUpdate = true;
        }
        continue;
      }

      if (!(particle.settled)) {
        this.velocities[idx * 3 + 1] -= 29.8 * delta;

        this.positions[idx * 3] += this.velocities[idx * 3] * delta;
        this.positions[idx * 3 + 1] += this.velocities[idx * 3 + 1] * delta;
        this.positions[idx * 3 + 2] += this.velocities[idx * 3 + 2] * delta;

        const gx = Math.round(this.positions[idx * 3] / 0.45);
        const gz = Math.round(this.positions[idx * 3 + 2] / 0.45);
        const key = gx + '_' + gz;

        const hitHeight = (this.heightMap.get(key) || 0) + 0.225;

        if (this.positions[idx * 3 + 1] <= hitHeight) {
          this.positions[idx * 3 + 1] = hitHeight;

          if (Math.abs(this.velocities[idx * 3 + 1]) < 8.0) {
            particle.settled = true;
            this.heightMap.set(key, hitHeight + 0.45);
            this.velocities[idx * 3] = 0;
            this.velocities[idx * 3 + 1] = 0;
            this.velocities[idx * 3 + 2] = 0;
          } else {
            this.velocities[idx * 3 + 1] *= -0.3;
            this.velocities[idx * 3] *= 0.5;
            this.velocities[idx * 3 + 2] *= 0.5;
          }
        }

        pos.set(this.positions[idx * 3], this.positions[idx * 3 + 1], this.positions[idx * 3 + 2]);
        this.dummy.position.copy(pos);
        this.dummy.updateMatrix();
        this.debrisMesh.setMatrixAt(idx, this.dummy.matrix);
        debrisNeedsUpdate = true;
      }
    }

    if (debrisNeedsUpdate) {
      this.debrisMesh.instanceMatrix.needsUpdate = true;
    }
  }
}
