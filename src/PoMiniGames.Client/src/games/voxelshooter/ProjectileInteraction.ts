// @ts-nocheck
import * as THREE from 'three';
import { VoxelSimulation } from './VoxelSimulation';
import { EnemyShapes } from './EnemyShapes';
import { ParticlePool } from './ParticlePool';

export class ProjectileInteraction {
    private raycaster = new THREE.Raycaster();

    private camera: THREE.PerspectiveCamera;
    private sim: VoxelSimulation;
    private particles: ParticlePool;
    private enemies: EnemyShapes;
    private enemyMeshes: THREE.InstancedMesh[] = [];
    private controls: any;

    // Bullet scene passed in (previously a module-level export in main.ts)
    private bulletScene: THREE.Scene;

    private bullets: { mesh: THREE.Mesh, velocity: THREE.Vector3, lastPos: THREE.Vector3 }[] = [];
    private bulletSpeed = 200.0;
    private fireRate = 1 / 6; // 6 bullets/second cap
    private lastShotTime = 0;
    private ammoCount = 0;

    private bulletMaterial = new THREE.MeshBasicMaterial({
        color: 0xffff00,
        depthTest: false
    });
    private bulletGeo = new THREE.SphereGeometry(0.8, 8, 8);

    private _onMouseDown = (e: MouseEvent) => this.handleMouseDown(e);

    constructor(
        camera: THREE.PerspectiveCamera,
        sim: VoxelSimulation,
        particles: ParticlePool,
        enemies: EnemyShapes,
        controls: any,
        bulletScene: THREE.Scene
    ) {
        this.camera = camera;
        this.sim = sim;
        this.particles = particles;
        this.enemies = enemies;
        this.controls = controls;
        this.bulletScene = bulletScene;

        window.addEventListener('mousedown', this._onMouseDown);
    }

    private handleMouseDown(event: MouseEvent) {
        if (event.button !== 0) return;

        if (!this.controls.isLocked) {
            this.controls.lock();
            return;
        }

        const now = performance.now() / 1000;
        if (now - this.lastShotTime < this.fireRate) return;
        this.lastShotTime = now;

        const bulletMesh = new THREE.Mesh(this.bulletGeo, this.bulletMaterial);
        bulletMesh.position.copy(this.camera.position);

        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);

        bulletMesh.position.addScaledVector(dir, 3.0);

        const velocity = dir.multiplyScalar(this.bulletSpeed);

        this.bulletScene.add(bulletMesh);
        this.bullets.push({
            mesh: bulletMesh,
            velocity: velocity,
            lastPos: bulletMesh.position.clone()
        });

        this.ammoCount++;
    }

    public update(delta: number) {
        this.enemyMeshes = this.enemies.shapes.map(s => s.mesh);

        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const bullet = this.bullets[i];

            bullet.lastPos.copy(bullet.mesh.position);
            bullet.mesh.position.addScaledVector(bullet.velocity, delta);

            const dir = new THREE.Vector3().subVectors(bullet.mesh.position, bullet.lastPos);
            const dist = dir.length();

            if (dist > 0) {
                dir.normalize();

                this.raycaster.set(bullet.lastPos, dir);
                this.raycaster.far = dist;

                const intersects = this.raycaster.intersectObjects(this.enemyMeshes, false);

                if (intersects.length > 0) {
                    const hitPoint = intersects[0].point;
                    const meshHit = intersects[0].object as THREE.InstancedMesh;

                    const index = this.enemies.shapes.findIndex(s => s.mesh === meshHit);

                    if (index !== -1) {
                        const damageRadius = 8.0;
                        const destroyedVoxels = this.enemies.applyDamage(index, hitPoint, damageRadius);

                        if (destroyedVoxels.length > 0) {
                            const inwardDir = new THREE.Vector3(0, hitPoint.y, 0).sub(hitPoint).normalize();
                            const colorHex = this.enemies.shapes[index]?.colorHex ?? 0xffffff;
                            this.particles.spawnDebris(destroyedVoxels, bullet.velocity.clone().multiplyScalar(0.05), colorHex);
                            this.particles.spawnSparks(hitPoint, inwardDir, 30);
                            this.sim.triggerExplosion(hitPoint, inwardDir);
                        }
                    }

                    this.bulletScene.remove(bullet.mesh);
                    bullet.mesh.geometry.dispose();
                    this.bullets.splice(i, 1);
                    continue;
                }
            }

            if (bullet.mesh.position.lengthSq() > 100000) {
                this.bulletScene.remove(bullet.mesh);
                bullet.mesh.geometry.dispose();
                this.bullets.splice(i, 1);
            }
        }
    }

    public getAmmoCount(): number {
        return this.ammoCount;
    }

    public getActiveBulletCount(): number {
        return this.bullets.length;
    }

    public dispose(): void {
        window.removeEventListener('mousedown', this._onMouseDown);
        // Clean up remaining bullets
        for (const bullet of this.bullets) {
            this.bulletScene.remove(bullet.mesh);
            bullet.mesh.geometry.dispose();
        }
        this.bullets = [];
    }
}
