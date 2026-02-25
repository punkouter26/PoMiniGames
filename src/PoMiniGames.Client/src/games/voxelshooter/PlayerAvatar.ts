import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export class PlayerAvatar {
    public mesh: THREE.Mesh;
    public body: CANNON.Body;

    private moveSpeed = 30.0;
    private velocity = new THREE.Vector3();
    private input = { forward: false, backward: false, left: false, right: false };

    private scene: THREE.Scene;
    private world: CANNON.World;
    private camera: THREE.PerspectiveCamera;

    private _onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e);
    private _onKeyUp = (e: KeyboardEvent) => this.handleKeyUp(e);

    constructor(scene: THREE.Scene, world: CANNON.World, camera: THREE.PerspectiveCamera) {
        this.scene = scene;
        this.world = world;
        this.camera = camera;

        const geo = new THREE.BoxGeometry(2, 2, 2);
        const mat = new THREE.MeshStandardMaterial({ color: 0x4ade80, roughness: 0.2, metalness: 0.8 });
        this.mesh = new THREE.Mesh(geo, mat);
        this.mesh.castShadow = true;
        this.scene.add(this.mesh);

        const shape = new CANNON.Box(new CANNON.Vec3(1, 1, 1));
        this.body = new CANNON.Body({
            mass: 0,
            type: CANNON.Body.KINEMATIC,
            shape: shape,
            position: new CANNON.Vec3(0, 1, 0)
        });
        this.world.addBody(this.body);

        this.camera.position.set(0, 2, 0);

        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
    }

    private handleKeyDown(event: KeyboardEvent) {
        if (event.code === 'KeyW' || event.code === 'ArrowUp') this.input.forward = true;
        if (event.code === 'KeyS' || event.code === 'ArrowDown') this.input.backward = true;
        if (event.code === 'KeyA' || event.code === 'ArrowLeft') this.input.left = true;
        if (event.code === 'KeyD' || event.code === 'ArrowRight') this.input.right = true;
    }

    private handleKeyUp(event: KeyboardEvent) {
        if (event.code === 'KeyW' || event.code === 'ArrowUp') this.input.forward = false;
        if (event.code === 'KeyS' || event.code === 'ArrowDown') this.input.backward = false;
        if (event.code === 'KeyA' || event.code === 'ArrowLeft') this.input.left = false;
        if (event.code === 'KeyD' || event.code === 'ArrowRight') this.input.right = false;
    }

    public update() {
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        dir.y = 0;
        dir.normalize();

        const right = new THREE.Vector3();
        right.crossVectors(this.camera.up, dir).normalize();

        this.velocity.set(0, 0, 0);

        if (this.input.forward) this.velocity.add(dir.clone().multiplyScalar(this.moveSpeed));
        if (this.input.backward) this.velocity.add(dir.clone().multiplyScalar(-this.moveSpeed));
        if (this.input.left) this.velocity.add(right.clone().multiplyScalar(this.moveSpeed));
        if (this.input.right) this.velocity.add(right.clone().multiplyScalar(-this.moveSpeed));

        this.body.velocity.x = this.velocity.x;
        this.body.velocity.z = this.velocity.z;

        const limit = 80;
        if (this.body.position.x < -limit) this.body.position.x = -limit;
        if (this.body.position.x > limit) this.body.position.x = limit;
        if (this.body.position.z < -limit) this.body.position.z = -limit;
        if (this.body.position.z > limit) this.body.position.z = limit;

        this.mesh.position.copy(this.body.position as any);

        const targetPoint = this.mesh.position.clone().add(dir);
        this.mesh.lookAt(targetPoint);

        this.camera.position.x = this.body.position.x;
        this.camera.position.y = this.body.position.y + 1;
        this.camera.position.z = this.body.position.z;
    }

    public dispose(): void {
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        this.scene.remove(this.mesh);
        this.world.removeBody(this.body);
    }
}
