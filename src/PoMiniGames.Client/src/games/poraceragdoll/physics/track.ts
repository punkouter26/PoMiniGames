import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { COLLISION_GROUPS } from './world';

export interface AnimatedObject {
    update: (deltaTime: number) => void;
    bodies: RAPIER.RigidBody[];
    meshes: THREE.Mesh[];
}

export interface TrackResult {
    ramp: THREE.Mesh;
    bodies: RAPIER.RigidBody[];
    meshes: THREE.Mesh[];
    animatedObjects: AnimatedObject[];
    finishZ: number;
    rampPos: THREE.Vector3;
    rampTopZ: number;
    rampBottomZ: number;
    groundY: number;
    angleRad: number;
    world: RAPIER.World;
}

export function createTrack(scene: THREE.Scene, world: RAPIER.World, slopeAngle: number, groundY = -5): TrackResult {
    const angleRad = THREE.MathUtils.degToRad(slopeAngle);
    const trackLength = 200;
    const trackWidth = 20;

    const bodies: RAPIER.RigidBody[] = [];
    const meshes: THREE.Mesh[] = [];
    const animatedObjects: AnimatedObject[] = [];

    // --- Ramp ---
    const rampSize = { x: trackWidth, y: 1, z: trackLength };
    const drop = Math.sin(angleRad) * (trackLength / 2);
    const forward = Math.cos(angleRad) * (trackLength / 2);
    const topSurfaceYOffset = (rampSize.y / 2) * Math.cos(angleRad);
    const rampPos = new THREE.Vector3(0, groundY + drop - topSurfaceYOffset, forward);

    const rampTopLocal = new THREE.Vector3(0, 0, -trackLength / 2);
    const rampBottomLocal = new THREE.Vector3(0, 0, trackLength / 2);
    const rampTopPos = rampPos.clone().add(rampTopLocal.applyAxisAngle(new THREE.Vector3(1, 0, 0), angleRad));
    const rampBottomPos = rampPos.clone().add(rampBottomLocal.applyAxisAngle(new THREE.Vector3(1, 0, 0), angleRad));

    const rampBodyDesc = RAPIER.RigidBodyDesc.fixed()
        .setTranslation(rampPos.x, rampPos.y, rampPos.z)
        .setRotation({ x: Math.sin(angleRad / 2), y: 0, z: 0, w: Math.cos(angleRad / 2) });

    const rampBody = world.createRigidBody(rampBodyDesc);
    const rampCollider = RAPIER.ColliderDesc.cuboid(rampSize.x / 2, rampSize.y / 2, rampSize.z / 2);
    rampCollider.setFriction(0.0);
    rampCollider.setRestitution(0.1);
    world.createCollider(rampCollider, rampBody);
    bodies.push(rampBody);

    const rampGeo = new THREE.BoxGeometry(rampSize.x, rampSize.y, rampSize.z);
    const rampMat = new THREE.MeshStandardMaterial({ color: 0x5a5a6e, roughness: 0.6, metalness: 0.1 });
    const rampMesh = new THREE.Mesh(rampGeo, rampMat);
    rampMesh.position.copy(rampPos);
    rampMesh.rotation.x = angleRad;
    rampMesh.receiveShadow = true;
    scene.add(rampMesh);
    meshes.push(rampMesh);

    // --- Lane markings ---
    const laneMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, side: THREE.DoubleSide });
    const laneWidth = trackWidth / 8;
    for (let i = 1; i < 8; i++) {
        const lineGeo = new THREE.PlaneGeometry(0.1, trackLength - 10);
        const lineMesh = new THREE.Mesh(lineGeo, laneMat);
        const laneX = -trackWidth / 2 + i * laneWidth;
        const localPos = new THREE.Vector3(laneX, 0.55, 0);
        localPos.applyAxisAngle(new THREE.Vector3(1, 0, 0), angleRad);
        lineMesh.position.copy(rampPos.clone().add(localPos));
        lineMesh.rotation.x = -Math.PI / 2 + angleRad;
        scene.add(lineMesh);
        meshes.push(lineMesh);
    }

    // --- Catch plane ---
    const catchPlaneY = groundY - 5;
    const catchBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, catchPlaneY, 0);
    const catchBody = world.createRigidBody(catchBodyDesc);
    world.createCollider(RAPIER.ColliderDesc.cuboid(250, 0.5, 250), catchBody);
    bodies.push(catchBody);

    // --- Walls ---
    const wallHeight = 10;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x40e0d0, opacity: 0.5, transparent: true });

    const createWall = (xOffset: number) => {
        const wallSize = { x: 0.5, y: wallHeight, z: trackLength };
        const localPos = new THREE.Vector3(xOffset, wallHeight / 2, 0);
        localPos.applyAxisAngle(new THREE.Vector3(1, 0, 0), angleRad);
        const wallPos = rampPos.clone().add(localPos);

        const wallBodyDesc = RAPIER.RigidBodyDesc.fixed()
            .setTranslation(wallPos.x, wallPos.y, wallPos.z)
            .setRotation({ x: Math.sin(angleRad / 2), y: 0, z: 0, w: Math.cos(angleRad / 2) });

        const wallBody = world.createRigidBody(wallBodyDesc);
        const wallCollider = RAPIER.ColliderDesc.cuboid(wallSize.x / 2, wallSize.y / 2, wallSize.z / 2);
        wallCollider.setFriction(0.0);
        world.createCollider(wallCollider, wallBody);
        bodies.push(wallBody);

        const wallGeo = new THREE.BoxGeometry(wallSize.x, wallSize.y, wallSize.z);
        const wallMesh = new THREE.Mesh(wallGeo, wallMat);
        wallMesh.position.copy(wallPos);
        wallMesh.rotation.x = angleRad;
        scene.add(wallMesh);
        meshes.push(wallMesh);
    };

    createWall(-trackWidth / 2 - 0.25);
    createWall(trackWidth / 2 + 0.25);

    // --- Finish Line ---
    const finishZ = rampBottomPos.z;
    const finishPos = new THREE.Vector3(0, groundY + 4, finishZ);
    const finishMat = new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide });
    const finishGeo = new THREE.PlaneGeometry(trackWidth + 4, 8);
    const finishMesh = new THREE.Mesh(finishGeo, finishMat);
    finishMesh.position.copy(finishPos);
    scene.add(finishMesh);
    meshes.push(finishMesh);

    const finishGroundGeo = new THREE.PlaneGeometry(trackWidth, 2);
    const finishGroundMesh = new THREE.Mesh(finishGroundGeo, finishMat);
    finishGroundMesh.position.set(0, groundY + 0.02, finishZ);
    finishGroundMesh.rotation.x = -Math.PI / 2;
    scene.add(finishGroundMesh);
    meshes.push(finishGroundMesh);

    // --- Obstacles ---
    const obstacleMat = new THREE.MeshStandardMaterial({ color: 0xff4444, metalness: 0.6, roughness: 0.3 });
    const obstacleCount = 10;
    const zoneLength = 140 / obstacleCount;

    for (let i = 0; i < obstacleCount; i++) {
        const zoneStart = -60 + i * zoneLength;
        const zPos = zoneStart + Math.random() * (zoneLength * 0.7);
        const side = Math.random() > 0.5 ? 1 : -1;
        const xPos = side * (2 + Math.random() * (trackWidth / 2 - 4));
        const isCylinder = Math.random() > 0.5;

        let obsCollider: RAPIER.ColliderDesc;
        let obstacleMesh: THREE.Mesh;
        let obsHeight: number;

        if (isCylinder) {
            obsHeight = 3;
            obsCollider = RAPIER.ColliderDesc.cylinder(obsHeight / 2, 0.7);
            obstacleMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, obsHeight, 12), obstacleMat);
        } else {
            obsHeight = 1.5;
            obsCollider = RAPIER.ColliderDesc.cuboid(0.5, obsHeight / 2, 0.5);
            obstacleMesh = new THREE.Mesh(new THREE.BoxGeometry(1, obsHeight, 1), obstacleMat);
        }

        const localPos = new THREE.Vector3(xPos, 0.5 + obsHeight / 2, zPos);
        localPos.applyAxisAngle(new THREE.Vector3(1, 0, 0), angleRad);
        const obsPos = rampPos.clone().add(localPos);

        const obsBodyDesc = RAPIER.RigidBodyDesc.fixed()
            .setTranslation(obsPos.x, obsPos.y, obsPos.z)
            .setRotation({ x: Math.sin(angleRad / 2), y: 0, z: 0, w: Math.cos(angleRad / 2) });

        const obsBody = world.createRigidBody(obsBodyDesc);
        world.createCollider(obsCollider, obsBody);
        bodies.push(obsBody);

        obstacleMesh.position.copy(obsPos);
        obstacleMesh.rotation.x = angleRad;
        obstacleMesh.castShadow = true;
        scene.add(obstacleMesh);
        meshes.push(obstacleMesh);
    }

    return {
        ramp: rampMesh,
        bodies,
        meshes,
        animatedObjects,
        finishZ,
        rampPos,
        rampTopZ: rampTopPos.z,
        rampBottomZ: rampBottomPos.z,
        groundY,
        angleRad,
        world,
    };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
void COLLISION_GROUPS; // ensure the import is used

export function updateTrackAnimations(animatedObjects: AnimatedObject[], deltaTime: number): void {
    animatedObjects.forEach(obj => obj.update(deltaTime));
}
