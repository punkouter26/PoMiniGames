// @ts-nocheck
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export class EnemyShapes {
    public shapes: {
        mesh: THREE.InstancedMesh,
        body: CANNON.Body,
        type: string,
        health: number,
        maxHealth: number,
        colorHex: number,
        material?: THREE.Material,
        gridSize: number,
        grid: Int32Array
    }[] = [];

    private voxelSize = 0.45; // 10x denser scaling
    private gridResolution = 75; // 75x75x75 templates
    private spawnRadius = 250; // spawn far away in a circle
    public speed = 10.0; // Public to allow difficulty escalation

    private timer = new THREE.Timer();
    private lastSpawnTime = 0;

    private scene: THREE.Scene;
    private world: CANNON.World;
    private csm: any;

    // Shared geometry for InstancedMesh
    private sharedGeo = new THREE.BoxGeometry(0.45, 0.45, 0.45);

    constructor(scene: THREE.Scene, world: CANNON.World, csm: any = null) {
        this.scene = scene;
        this.world = world;
        this.csm = csm;
    }

    public update() {
        this.timer.update();
        const time = this.timer.getElapsed();

        // Spawn a new shape every 3 seconds
        if (time - this.lastSpawnTime > 3.0) {
            this.spawnRandomShape();
            this.lastSpawnTime = time;
        }

        // Move shapes towards the player (Origin 0,0,0)
        for (let i = this.shapes.length - 1; i >= 0; i--) {
            const shape = this.shapes[i];

            // Calculate direction to center
            const dir = new THREE.Vector3(0, 0, 0).sub(shape.body.position as any).normalize();

            // Override X and Z to push towards player, but DO NOT override Y!
            shape.body.velocity.x = dir.x * this.speed;
            shape.body.velocity.z = dir.z * this.speed;

            // Keep rotation locked so they don't tumble over, just slide and drop straight down.
            shape.body.angularVelocity.set(0, 0, 0);

            // Despawn if it gets too close to the origin or passes it
            const distSq = shape.body.position.x * shape.body.position.x + shape.body.position.z * shape.body.position.z;

            if (distSq < 2) {
                this.removeShape(i);
            } else {
                // Sync Mesh
                shape.mesh.position.copy(shape.body.position as any);
                shape.mesh.quaternion.copy(shape.body.quaternion as any);
            }
        }
    }

    // Called when an enemy is fully destroyed or despawned
    public removeShape(index: number): boolean {
        const shape = this.shapes[index];
        if (shape) {
            this.scene.remove(shape.mesh);
            shape.mesh.dispose();
            this.world.removeBody(shape.body);
            this.shapes.splice(index, 1);
            return true;
        }
        return false;
    }

    public applyDamage(index: number, worldHitPoint: THREE.Vector3, radius: number): THREE.Vector3[] {
        const shape = this.shapes[index];
        if (!shape) return [];

        const mesh = shape.mesh;

        // Transform the hit point into the mesh's local space
        const invMatrix = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
        const localHitPoint = worldHitPoint.clone().applyMatrix4(invMatrix);

        const radiusSq = radius * radius;

        const dummyMatrix = new THREE.Matrix4();
        const position = new THREE.Vector3();
        const scale = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();

        const destroyedPositions: THREE.Vector3[] = [];
        let hitCount = 0;

        for (let i = 0; i < shape.maxHealth; i++) {
            mesh.getMatrixAt(i, dummyMatrix);

            // Extract scale to see if it's already dead (scale 0)
            dummyMatrix.decompose(position, quaternion, scale);
            if (scale.x < 0.1) continue; // Already destroyed

            // Check distance to local hit point
            const distSq = position.distanceToSquared(localHitPoint);
            const scorchRadiusSq = radiusSq * 2.5; // Wider char mark

            if (distSq <= radiusSq) {
                // Destroy this voxel
                scale.set(0, 0, 0);
                dummyMatrix.compose(position, quaternion, scale);
                mesh.setMatrixAt(i, dummyMatrix);

                // Add to removed list (converted back to world space)
                const wp = position.clone().applyMatrix4(mesh.matrixWorld);
                destroyedPositions.push(wp);

                // Update grid mapping
                const maxX = shape.gridSize;
                const gridX = Math.round((position.x / this.voxelSize) + maxX / 2);
                const gridY = Math.round((position.y / this.voxelSize) + maxX / 2);
                const gridZ = Math.round((position.z / this.voxelSize) + maxX / 2);

                if (gridX >= 0 && gridX < maxX && gridY >= 0 && gridY < maxX && gridZ >= 0 && gridZ < maxX) {
                    shape.grid[gridX + gridZ * maxX + gridY * maxX * maxX] = -1;
                }

                hitCount++;
            } else if (distSq <= scorchRadiusSq) {
                // Not destroyed, but close enough to be scorched by the blast heat!
                const charColor = new THREE.Color(0x222222); // Charred black
                mesh.setColorAt(i, charColor);
                if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
            }
        }

        if (hitCount > 0) {
            shape.health -= hitCount;

            // If the entire ship is destroyed, clear it out completely
            if (shape.health <= 0) {
                for (let i = 0; i < shape.grid.length; i++) {
                    if (shape.grid[i] !== -1) {
                        const instanceId = shape.grid[i];
                        mesh.getMatrixAt(instanceId, dummyMatrix);
                        dummyMatrix.decompose(position, quaternion, scale);
                        const wp = position.clone().applyMatrix4(mesh.matrixWorld);
                        destroyedPositions.push(wp);
                    }
                }
                this.removeShape(index);
                return destroyedPositions;
            } else {
                this.detectAndDestroyDetachedIslands(shape, destroyedPositions);
            }
            mesh.instanceMatrix.needsUpdate = true;
            this.recalculatePhysicsBounds(shape);

            // Wake up the physics body so gravity immediately takes effect if its support is destroyed!
            shape.body.wakeUp();
        }

        return destroyedPositions;
    }

    private recalculatePhysicsBounds(shape: any) {
        let minX = Infinity, maxXBound = -Infinity;
        let minY = Infinity, maxYBound = -Infinity;
        let minZ = Infinity, maxZBound = -Infinity;

        const dummyMatrix = new THREE.Matrix4();
        const position = new THREE.Vector3();
        const scale = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();

        let hasVoxels = false;

        for (let i = 0; i < shape.grid.length; i++) {
            if (shape.grid[i] !== -1) {
                const instanceId = shape.grid[i];
                shape.mesh.getMatrixAt(instanceId, dummyMatrix);
                dummyMatrix.decompose(position, quaternion, scale);

                if (position.x < minX) minX = position.x;
                if (position.x > maxXBound) maxXBound = position.x;
                if (position.y < minY) minY = position.y;
                if (position.y > maxYBound) maxYBound = position.y;
                if (position.z < minZ) minZ = position.z;
                if (position.z > maxZBound) maxZBound = position.z;

                hasVoxels = true;
            }
        }

        if (hasVoxels) {
            const hWidth = (maxXBound - minX) / 2 + (this.voxelSize / 2);
            const hHeight = (maxYBound - minY) / 2 + (this.voxelSize / 2);
            const hDepth = (maxZBound - minZ) / 2 + (this.voxelSize / 2);

            const offsetX = (maxXBound + minX) / 2;
            const offsetY = (maxYBound + minY) / 2;
            const offsetZ = (maxZBound + minZ) / 2;

            if (shape.body.shapes.length > 0) {
                const oldOffset = shape.body.shapeOffsets[0];
                const oldShape = shape.body.shapes[0] as CANNON.Box;

                const oldBottom = oldOffset.y - oldShape.halfExtents.y;
                const newBottom = offsetY - hHeight;

                if (newBottom > oldBottom) {
                    shape.body.position.y -= (newBottom - oldBottom);
                }
            }

            // Update CANNON shape
            shape.body.shapes = [];
            shape.body.shapeOffsets = [];
            shape.body.shapeOrientations = [];

            const boxShape = new CANNON.Box(new CANNON.Vec3(hWidth, hHeight, hDepth));
            shape.body.addShape(boxShape, new CANNON.Vec3(offsetX, offsetY, offsetZ));
        }
    }

    private detectAndDestroyDetachedIslands(shape: any, destroyedPositions: THREE.Vector3[]) {
        const grid = shape.grid;
        const size = shape.gridSize;
        const visited = new Uint8Array(grid.length);

        const components: number[][] = [];

        // Find connected components
        for (let i = 0; i < grid.length; i++) {
            if (grid[i] !== -1 && visited[i] === 0) {
                const comp: number[] = [];
                const queue: number[] = [i];
                visited[i] = 1;

                let head = 0;
                while (head < queue.length) {
                    const curr = queue[head++];
                    comp.push(curr);

                    const gx = curr % size;
                    const gz = Math.floor(curr / size) % size;
                    const gy = Math.floor(curr / (size * size));

                    // Check 6 neighbors
                    const neighbors = [
                        [gx + 1, gy, gz], [gx - 1, gy, gz],
                        [gx, gy + 1, gz], [gx, gy - 1, gz],
                        [gx, gy, gz + 1], [gx, gy, gz - 1]
                    ];

                    for (const n of neighbors) {
                        const nx = n[0], ny = n[1], nz = n[2];
                        if (nx >= 0 && nx < size && ny >= 0 && ny < size && nz >= 0 && nz < size) {
                            const nIndex = nx + nz * size + ny * size * size;
                            if (grid[nIndex] !== -1 && visited[nIndex] === 0) {
                                visited[nIndex] = 1;
                                queue.push(nIndex);
                            }
                        }
                    }
                }
                components.push(comp);
            }
        }

        // If multiple components exist, keep the largest and destroy the rest
        if (components.length > 1) {
            let largestIdx = 0;
            let maxLen = components[0].length;
            for (let i = 1; i < components.length; i++) {
                if (components[i].length > maxLen) {
                    maxLen = components[i].length;
                    largestIdx = i;
                }
            }

            const dummyMatrix = new THREE.Matrix4();
            const position = new THREE.Vector3();
            const scale = new THREE.Vector3();
            const quaternion = new THREE.Quaternion();

            for (let i = 0; i < components.length; i++) {
                if (i === largestIdx) continue;

                const comp = components[i];
                for (const idx of comp) {
                    const instanceId = grid[idx];

                    shape.mesh.getMatrixAt(instanceId, dummyMatrix);
                    dummyMatrix.decompose(position, quaternion, scale);
                    scale.set(0, 0, 0);
                    dummyMatrix.compose(position, quaternion, scale);
                    shape.mesh.setMatrixAt(instanceId, dummyMatrix);

                    const wp = position.clone().applyMatrix4(shape.mesh.matrixWorld);
                    destroyedPositions.push(wp);

                    grid[idx] = -1;
                    shape.health--;
                }
            }
        }
    }

    private spawnRandomShape() {
        const types = ['asteroid', 'ship'];
        const type = types[Math.floor(Math.random() * types.length)];

        // Pick a random angle around the full 360 circle
        const angle = Math.random() * Math.PI * 2;
        const xOffset = Math.cos(angle) * this.spawnRadius;
        const zOffset = Math.sin(angle) * this.spawnRadius;

        let template: number[][][] = []; // [y][z][x]
        let material: THREE.Material;

        if (type === 'asteroid') {
            template = this.createComplexAsteroid();
            material = new THREE.MeshStandardMaterial({
                color: 0xe74c3c,
                roughness: 0.9,
                metalness: 0.1
            });
        } else if (type === 'ship') {
            template = this.createComplexShip();
            material = new THREE.MeshStandardMaterial({
                color: 0xf1c40f,
                roughness: 0.2,
                metalness: 0.8
            });
        } else {
            material = new THREE.MeshStandardMaterial({ color: 0xffffff });
        }

        if (this.csm) {
            this.csm.setupMaterial(material);
        }

        this.buildShapeFromTemplate(template, new CANNON.Vec3(xOffset, 15, zOffset), type, material);
    }

    private buildShapeFromTemplate(template: number[][][], rootPos: CANNON.Vec3, type: string, material: THREE.Material) {
        let maxY = template.length;
        let maxZ = template[0].length;
        let maxX = template[0][0].length;

        // First, count total active voxels to allocate InstancedMesh
        let instanceCount = 0;
        for (let y = 0; y < maxY; y++) {
            for (let z = 0; z < maxZ; z++) {
                for (let x = 0; x < maxX; x++) {
                    if (template[y][z][x] === 1) instanceCount++;
                }
            }
        }

        if (instanceCount === 0) return;

        // Create an InstancedMesh using the specific Physical/Standard material
        const instancedMesh = new THREE.InstancedMesh(this.sharedGeo, material, instanceCount);
        instancedMesh.castShadow = true;
        instancedMesh.receiveShadow = true;

        let dummy = new THREE.Object3D();
        let currentInstance = 0;

        let minX = Infinity, maxXBound = -Infinity;
        let minY = Infinity, maxYBound = -Infinity;
        let minZ = Infinity, maxZBound = -Infinity;

        // 1D Array to map (x, y, z) spatial coordinates to Instance Index
        const grid = new Int32Array(maxX * maxY * maxZ).fill(-1);

        for (let y = 0; y < maxY; y++) {
            for (let z = 0; z < maxZ; z++) {
                for (let x = 0; x < maxX; x++) {
                    if (template[y][z][x] === 1) {
                        const lx = (x - maxX / 2) * this.voxelSize;
                        const ly = (y - maxY / 2) * this.voxelSize;
                        const lz = (z - maxZ / 2) * this.voxelSize;

                        if (lx < minX) minX = lx;
                        if (lx > maxXBound) maxXBound = lx;
                        if (ly < minY) minY = ly;
                        if (ly > maxYBound) maxYBound = ly;
                        if (lz < minZ) minZ = lz;
                        if (lz > maxZBound) maxZBound = lz;

                        dummy.position.set(lx, ly, lz);
                        dummy.updateMatrix();
                        instancedMesh.setMatrixAt(currentInstance, dummy.matrix);
                        instancedMesh.setColorAt(currentInstance, new THREE.Color(0xffffff));

                        grid[x + z * maxX + y * maxX * maxZ] = currentInstance;

                        currentInstance++;
                    }
                }
            }
        }

        instancedMesh.instanceMatrix.needsUpdate = true;
        if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;

        const hWidth = (maxXBound - minX) / 2 + (this.voxelSize / 2);
        const hHeight = (maxYBound - minY) / 2 + (this.voxelSize / 2);
        const hDepth = (maxZBound - minZ) / 2 + (this.voxelSize / 2);

        const offsetX = (maxXBound + minX) / 2;
        const offsetY = (maxYBound + minY) / 2;
        const offsetZ = (maxZBound + minZ) / 2;

        const body = new CANNON.Body({
            mass: 500,
            type: CANNON.Body.DYNAMIC,
            position: rootPos,
            collisionFilterGroup: 2,
            collisionFilterMask: 1,
        });

        const boxShape = new CANNON.Box(new CANNON.Vec3(hWidth, hHeight, hDepth));
        body.addShape(boxShape, new CANNON.Vec3(offsetX, offsetY, offsetZ));

        // Lock rotation so it slides cleanly
        body.angularFactor.set(0, 0, 0);

        this.scene.add(instancedMesh);
        this.world.addBody(body);

        let colorHex = 0xffffff;
        if ((material as any).color) {
            colorHex = (material as any).color.getHex();
        }

        this.shapes.push({
            mesh: instancedMesh,
            body,
            type,
            health: instanceCount,
            maxHealth: instanceCount,
            colorHex,
            material,
            gridSize: maxX,
            grid
        });
    }

    // --- Procedural 75x75x75 Generators ---

    private createComplexAsteroid() {
        const size = this.gridResolution;
        const radius = size / 2.5;
        const scl = size / 35;
        return this.generateTemplate(size, (x, y, z) => {
            const dx = x - size / 2;
            const dy = y - size / 2;
            const dz = z - size / 2;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const noise = (Math.sin(x * 0.4 / scl) + Math.cos(y * 0.6 / scl) + Math.sin(z * 0.3 / scl)) * (2.5 * scl) +
                (Math.cos(x * 1.1 / scl) + Math.sin(y * 0.9 / scl) + Math.cos(z * 1.2 / scl)) * (1.5 * scl);
            return dist < (radius + noise) ? 1 : 0;
        });
    }

    private createComplexShip() {
        const size = this.gridResolution;
        const scl = size / 35;
        return this.generateTemplate(size, (x, y, z) => {
            const cx = size / 2;
            const cy = size / 2;

            if (x > cx - 3 * scl && x < cx + 3 * scl && y > cy - 3 * scl && y < cy + 3 * scl && z < size - 4 * scl) return 1;
            const wingWidth = z * 0.9;
            if (y > cy - 1 * scl && y < cy + 1 * scl && x > cx - wingWidth && x < cx + wingWidth && z > 6 * scl && z < size - 6 * scl) return 1;
            if (x > cx - 1 * scl && x < cx + 1 * scl && y > cy && y < cy + z * 0.4 && z > size * 0.6) return 1;
            if ((Math.abs(x - cx) > wingWidth * 0.8) && y > cy - 2 * scl && y < cy + 2 * scl && z > size * 0.7) return 1;

            return 0;
        });
    }

    private generateTemplate(size: number, rule: (x: number, y: number, z: number) => number) {
        const template: number[][][] = [];
        for (let y = 0; y < size; y++) {
            const layerZ: number[][] = [];
            for (let z = 0; z < size; z++) {
                const rowX: number[] = [];
                for (let x = 0; x < size; x++) {
                    rowX.push(rule(x, y, z));
                }
                layerZ.push(rowX);
            }
            template.push(layerZ);
        }
        return template;
    }
}
