import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { RACER_SPECIES } from '../lib/config';

export { RACER_SPECIES };

interface RagdollResult {
    root: THREE.Object3D;
    parts: THREE.Mesh[];
    bodies: RAPIER.RigidBody[];
    headBody: RAPIER.RigidBody;
}

interface Vec3Like {
    x: number;
    y: number;
    z: number;
}

function createBody(
    world: RAPIER.World,
    type: 'dynamic' | 'fixed',
    position: Vec3Like,
    colliderDesc: RAPIER.ColliderDesc,
    mass: number
): RAPIER.RigidBody {
    const bodyDesc = type === 'dynamic'
        ? RAPIER.RigidBodyDesc.dynamic()
        : RAPIER.RigidBodyDesc.fixed();

    bodyDesc.setTranslation(position.x, position.y, position.z);
    bodyDesc.setLinearDamping(0.5);
    bodyDesc.setAngularDamping(0.5);

    const body = world.createRigidBody(bodyDesc);
    const collider = world.createCollider(colliderDesc, body);

    collider.setMass(mass);
    collider.setFriction(0.5);
    collider.setRestitution(0.2);

    return body;
}

function createMesh(geometry: THREE.BufferGeometry, color: string): THREE.Mesh {
    const c = new THREE.Color(color);
    const material = new THREE.MeshStandardMaterial({
        color: c,
        roughness: 0.4,
        metalness: 0.1,
        emissive: c,
        emissiveIntensity: 0.25
    });
    return new THREE.Mesh(geometry, material);
}

function createBallJoint(
    world: RAPIER.World,
    parent: RAPIER.RigidBody,
    child: RAPIER.RigidBody,
    anchorParent: Vec3Like,
    anchorChild: Vec3Like
) {
    const params = RAPIER.JointData.spherical(
        new RAPIER.Vector3(anchorParent.x, anchorParent.y, anchorParent.z),
        new RAPIER.Vector3(anchorChild.x, anchorChild.y, anchorChild.z)
    );
    world.createImpulseJoint(params, parent, child, true);
}

export function createRagdoll(
    scene: THREE.Scene,
    world: RAPIER.World | null,
    position: Vec3Like,
    speciesType: string,
    options: { noPhysics?: boolean } = {}
): RagdollResult {
    const { noPhysics = false } = options;
    const species = RACER_SPECIES.find(s => s.type === speciesType) || RACER_SPECIES[0];

    switch (species.type) {
        case 'dog':
        case 'penguin':
        case 'dino':
            return createQuadruped(scene, world, position, species, noPhysics);
        case 'spider':
        case 'crab':
            return createArachnid(scene, world, position, species, noPhysics);
        case 'snake':
            return createSnake(scene, world, position, species, noPhysics);
        case 'human':
        case 'alien':
        default:
            return createBiped(scene, world, position, species, noPhysics);
    }
}

type Species = (typeof RACER_SPECIES)[number];

function createBiped(scene: THREE.Scene, world: RAPIER.World | null, position: Vec3Like, species: Species, noPhysics: boolean): RagdollResult {
    const bodies: RAPIER.RigidBody[] = [];
    const meshes: THREE.Mesh[] = [];
    const color = species.color;
    const pos = new THREE.Vector3(position.x, position.y, position.z);

    if (!world || noPhysics) {
        const group = new THREE.Group();
        group.position.set(pos.x, pos.y, pos.z);

        const torsoGeo = new THREE.BoxGeometry(0.6, 1, 0.4);
        const torsoMesh = createMesh(torsoGeo, color);
        torsoMesh.position.set(0, 0, 0);
        torsoMesh.castShadow = true;
        group.add(torsoMesh);

        const headGeo = new THREE.SphereGeometry(0.25, 16, 16);
        const headMesh = createMesh(headGeo, color);
        headMesh.position.set(0, 0.9, 0);
        headMesh.castShadow = true;
        group.add(headMesh);

        const eyeGeo = new THREE.SphereGeometry(0.06, 8, 8);
        const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
        const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
        leftEye.position.set(-0.08, 0.95, 0.22);
        group.add(leftEye);
        const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
        rightEye.position.set(0.08, 0.95, 0.22);
        group.add(rightEye);

        const pupilGeo = new THREE.SphereGeometry(0.03, 8, 8);
        const pupilMat = new THREE.MeshStandardMaterial({ color: 0x000000 });
        const leftPupil = new THREE.Mesh(pupilGeo, pupilMat);
        leftPupil.position.set(-0.08, 0.95, 0.26);
        group.add(leftPupil);
        const rightPupil = new THREE.Mesh(pupilGeo, pupilMat);
        rightPupil.position.set(0.08, 0.95, 0.26);
        group.add(rightPupil);

        const limbRadius = 0.12;
        const limbHeight = 0.7;
        const limbGeo = new THREE.CapsuleGeometry(limbRadius, limbHeight - limbRadius * 2, 8, 8);
        const limbPositions = [
            { x: -0.2, y: -0.85, z: 0 },
            { x: 0.2, y: -0.85, z: 0 },
            { x: -0.45, y: 0.3, z: 0 },
            { x: 0.45, y: 0.3, z: 0 },
        ];
        limbPositions.forEach(lp => {
            const limbMesh = createMesh(limbGeo, color);
            limbMesh.position.set(lp.x, lp.y, lp.z);
            limbMesh.castShadow = true;
            group.add(limbMesh);
        });

        scene.add(group);
        return { root: group, parts: [torsoMesh], bodies: [], headBody: undefined as unknown as RAPIER.RigidBody };
    }

    const torsoSize = { x: 0.6, y: 1, z: 0.4 };
    const torsoCollider = RAPIER.ColliderDesc.cuboid(torsoSize.x / 2, torsoSize.y / 2, torsoSize.z / 2);
    const torsoBody = createBody(world, 'dynamic', pos, torsoCollider, species.mass * 0.4);
    const torsoGeo = new THREE.BoxGeometry(torsoSize.x, torsoSize.y, torsoSize.z);
    const torsoMesh = createMesh(torsoGeo, color);
    torsoMesh.castShadow = true;
    scene.add(torsoMesh);
    bodies.push(torsoBody);
    meshes.push(torsoMesh);

    const headRadius = 0.25;
    const headPos = pos.clone().add(new THREE.Vector3(0, 0.9, 0));
    const headCollider = RAPIER.ColliderDesc.ball(headRadius);
    const headBody = createBody(world, 'dynamic', headPos, headCollider, species.mass * 0.1);
    const headGeo = new THREE.SphereGeometry(headRadius, 16, 16);
    const headMesh = createMesh(headGeo, color);
    headMesh.castShadow = true;
    scene.add(headMesh);
    bodies.push(headBody);
    meshes.push(headMesh);
    createBallJoint(world, torsoBody, headBody, { x: 0, y: 0.5, z: 0 }, { x: 0, y: -0.4, z: 0 });

    const limbRadius = 0.12;
    const limbHeight = 0.7;
    const limbGeo = new THREE.CapsuleGeometry(limbRadius, limbHeight - limbRadius * 2, 8, 8);

    const limbOffsets = [
        { pos: new THREE.Vector3(-0.2, -0.85, 0), pivotTorso: { x: -0.2, y: -0.5, z: 0 }, pivotLimb: { x: 0, y: limbHeight / 2, z: 0 }, isLeg: true },
        { pos: new THREE.Vector3(0.2, -0.85, 0), pivotTorso: { x: 0.2, y: -0.5, z: 0 }, pivotLimb: { x: 0, y: limbHeight / 2, z: 0 }, isLeg: true },
        { pos: new THREE.Vector3(-0.45, 0.3, 0), pivotTorso: { x: -0.3, y: 0.3, z: 0 }, pivotLimb: { x: 0, y: limbHeight / 2, z: 0 }, isLeg: false },
        { pos: new THREE.Vector3(0.45, 0.3, 0), pivotTorso: { x: 0.3, y: 0.3, z: 0 }, pivotLimb: { x: 0, y: limbHeight / 2, z: 0 }, isLeg: false }
    ];

    limbOffsets.forEach((off) => {
        const p = pos.clone().add(off.pos);
        const collider = RAPIER.ColliderDesc.capsule(limbHeight / 2, limbRadius);
        if (off.isLeg) {
            collider.setFriction(0.0);
            collider.setRestitution(0.0);
        } else {
            collider.setFriction(0.5);
        }
        const body = createBody(world, 'dynamic', p, collider, species.mass * 0.1);
        const mesh = createMesh(limbGeo, color);
        mesh.castShadow = true;
        scene.add(mesh);
        bodies.push(body);
        meshes.push(mesh);
        createBallJoint(world, torsoBody, body, off.pivotTorso, off.pivotLimb);
    });

    return { root: torsoMesh, parts: meshes, bodies, headBody };
}

function createQuadruped(scene: THREE.Scene, world: RAPIER.World | null, position: Vec3Like, species: Species, noPhysics: boolean): RagdollResult {
    const color = species.color;
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    const bodies: RAPIER.RigidBody[] = [];
    const meshes: THREE.Mesh[] = [];

    if (!world || noPhysics) {
        const group = new THREE.Group();
        group.position.copy(pos);
        const torso = createMesh(new THREE.BoxGeometry(1.0, 0.55, 0.55), color);
        torso.position.set(0, 0, 0);
        group.add(torso);
        const head = createMesh(new THREE.SphereGeometry(0.23, 14, 14), color);
        head.position.set(0, 0.1, 0.58);
        group.add(head);
        const limbGeo = new THREE.CapsuleGeometry(0.1, 0.5, 8, 8);
        const legOffsets = [
            new THREE.Vector3(-0.3, -0.45, 0.28), new THREE.Vector3(0.3, -0.45, 0.28),
            new THREE.Vector3(-0.3, -0.45, -0.28), new THREE.Vector3(0.3, -0.45, -0.28)
        ];
        legOffsets.forEach(offset => {
            const leg = createMesh(limbGeo, color);
            leg.position.copy(offset);
            group.add(leg);
        });
        scene.add(group);
        return { root: group, parts: [torso], bodies: [], headBody: undefined as unknown as RAPIER.RigidBody };
    }

    const torsoBody = createBody(world, 'dynamic', pos, RAPIER.ColliderDesc.cuboid(0.5, 0.275, 0.275), species.mass * 0.45);
    const torsoMesh = createMesh(new THREE.BoxGeometry(1.0, 0.55, 0.55), color);
    scene.add(torsoMesh);
    bodies.push(torsoBody);
    meshes.push(torsoMesh);

    const headPos = pos.clone().add(new THREE.Vector3(0, 0.1, 0.58));
    const headBody = createBody(world, 'dynamic', headPos, RAPIER.ColliderDesc.ball(0.23), species.mass * 0.12);
    const headMesh = createMesh(new THREE.SphereGeometry(0.23, 14, 14), color);
    scene.add(headMesh);
    bodies.push(headBody);
    meshes.push(headMesh);
    createBallJoint(world, torsoBody, headBody, { x: 0, y: 0.05, z: 0.35 }, { x: 0, y: 0, z: -0.2 });

    const legOffsets = [
        { pos: new THREE.Vector3(-0.3, -0.45, 0.28), torso: { x: -0.3, y: -0.22, z: 0.25 } },
        { pos: new THREE.Vector3(0.3, -0.45, 0.28), torso: { x: 0.3, y: -0.22, z: 0.25 } },
        { pos: new THREE.Vector3(-0.3, -0.45, -0.28), torso: { x: -0.3, y: -0.22, z: -0.25 } },
        { pos: new THREE.Vector3(0.3, -0.45, -0.28), torso: { x: 0.3, y: -0.22, z: -0.25 } }
    ];

    legOffsets.forEach(leg => {
        const legPos = pos.clone().add(leg.pos);
        const collider = RAPIER.ColliderDesc.capsule(0.25, 0.1);
        collider.setFriction(0.0);
        const legBody = createBody(world, 'dynamic', legPos, collider, species.mass * 0.1);
        const legMesh = createMesh(new THREE.CapsuleGeometry(0.1, 0.5, 8, 8), color);
        scene.add(legMesh);
        bodies.push(legBody);
        meshes.push(legMesh);
        createBallJoint(world, torsoBody, legBody, leg.torso, { x: 0, y: 0.25, z: 0 });
    });

    return { root: torsoMesh, parts: meshes, bodies, headBody };
}

function createArachnid(scene: THREE.Scene, world: RAPIER.World | null, position: Vec3Like, species: Species, noPhysics: boolean): RagdollResult {
    const color = species.color;
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    const bodies: RAPIER.RigidBody[] = [];
    const meshes: THREE.Mesh[] = [];
    const isCrab = species.type === 'crab';
    const legCount = isCrab ? 6 : 8;
    const torsoRadius = isCrab ? 0.42 : 0.35;

    if (!world || noPhysics) {
        const group = new THREE.Group();
        group.position.copy(pos);
        const torso = createMesh(new THREE.SphereGeometry(torsoRadius, 14, 14), color);
        group.add(torso);
        const head = createMesh(new THREE.SphereGeometry(isCrab ? 0.16 : 0.14, 12, 12), color);
        head.position.set(0, 0.08, torsoRadius + 0.14);
        group.add(head);
        const legGeo = new THREE.CapsuleGeometry(0.06, 0.42, 8, 8);
        for (let i = 0; i < legCount; i++) {
            const angle = ((Math.PI * 2) / legCount) * i;
            const leg = createMesh(legGeo, color);
            leg.position.set(Math.cos(angle) * (torsoRadius + 0.18), -0.05, Math.sin(angle) * (torsoRadius + 0.18));
            leg.rotation.z = Math.cos(angle) * 0.9;
            leg.rotation.x = Math.sin(angle) * 0.45;
            group.add(leg);
        }
        scene.add(group);
        return { root: group, parts: [torso], bodies: [], headBody: undefined as unknown as RAPIER.RigidBody };
    }

    const torsoBody = createBody(world, 'dynamic', pos, RAPIER.ColliderDesc.ball(torsoRadius), species.mass * 0.45);
    const torsoMesh = createMesh(new THREE.SphereGeometry(torsoRadius, 14, 14), color);
    scene.add(torsoMesh);
    bodies.push(torsoBody);
    meshes.push(torsoMesh);

    const headPos = pos.clone().add(new THREE.Vector3(0, 0.08, torsoRadius + 0.14));
    const headBody = createBody(world, 'dynamic', headPos, RAPIER.ColliderDesc.ball(isCrab ? 0.16 : 0.14), species.mass * 0.1);
    const headMesh = createMesh(new THREE.SphereGeometry(isCrab ? 0.16 : 0.14, 12, 12), color);
    scene.add(headMesh);
    bodies.push(headBody);
    meshes.push(headMesh);
    createBallJoint(world, torsoBody, headBody, { x: 0, y: 0.05, z: torsoRadius * 0.8 }, { x: 0, y: 0, z: -0.1 });

    for (let i = 0; i < legCount; i++) {
        const angle = ((Math.PI * 2) / legCount) * i;
        const lx = Math.cos(angle) * (torsoRadius + 0.2);
        const lz = Math.sin(angle) * (torsoRadius + 0.2);
        const legPos = pos.clone().add(new THREE.Vector3(lx, -0.05, lz));
        const legCollider = RAPIER.ColliderDesc.capsule(0.21, 0.06);
        legCollider.setFriction(0.0);
        const legBody = createBody(world, 'dynamic', legPos, legCollider, species.mass * 0.05);
        const legMesh = createMesh(new THREE.CapsuleGeometry(0.06, 0.42, 8, 8), color);
        legMesh.rotation.z = Math.cos(angle) * 0.9;
        legMesh.rotation.x = Math.sin(angle) * 0.45;
        scene.add(legMesh);
        bodies.push(legBody);
        meshes.push(legMesh);
        createBallJoint(world, torsoBody, legBody, { x: lx * 0.7, y: 0, z: lz * 0.7 }, { x: 0, y: 0.2, z: 0 });
    }

    return { root: torsoMesh, parts: meshes, bodies, headBody };
}

function createSnake(scene: THREE.Scene, world: RAPIER.World | null, position: Vec3Like, species: Species, noPhysics: boolean): RagdollResult {
    const color = species.color;
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    const bodies: RAPIER.RigidBody[] = [];
    const meshes: THREE.Mesh[] = [];
    const segmentCount = 6;
    const spacing = 0.34;

    if (!world || noPhysics) {
        const group = new THREE.Group();
        group.position.copy(pos);
        for (let i = 0; i < segmentCount; i++) {
            const radius = i === 0 ? 0.19 : 0.15;
            const segment = createMesh(new THREE.SphereGeometry(radius, 12, 12), color);
            segment.position.set(0, i === 0 ? 0.05 : 0, -i * spacing);
            group.add(segment);
        }
        scene.add(group);
        return { root: group, parts: [], bodies: [], headBody: undefined as unknown as RAPIER.RigidBody };
    }

    let previousBody: RAPIER.RigidBody | null = null;
    let headBody: RAPIER.RigidBody | null = null;
    let rootMesh: THREE.Mesh | null = null;

    for (let i = 0; i < segmentCount; i++) {
        const radius = i === 0 ? 0.19 : 0.15;
        const segmentPos = pos.clone().add(new THREE.Vector3(0, i === 0 ? 0.05 : 0, -i * spacing));
        const segmentBody = createBody(world, 'dynamic', segmentPos, RAPIER.ColliderDesc.ball(radius), species.mass * (i === 0 ? 0.2 : 0.13));
        const segmentMesh = createMesh(new THREE.SphereGeometry(radius, 12, 12), color);
        scene.add(segmentMesh);
        bodies.push(segmentBody);
        meshes.push(segmentMesh);
        if (i === 0) { headBody = segmentBody; rootMesh = segmentMesh; }
        if (previousBody) {
            createBallJoint(world, previousBody, segmentBody, { x: 0, y: 0, z: -spacing / 2 }, { x: 0, y: 0, z: spacing / 2 });
        }
        previousBody = segmentBody;
    }

    return {
        root: (rootMesh ?? meshes[0]) as THREE.Mesh,
        parts: meshes,
        bodies,
        headBody: (headBody ?? bodies[0]) as RAPIER.RigidBody
    };
}

export function syncRagdolls(racers: { bodies: RAPIER.RigidBody[]; parts: THREE.Mesh[] }[]): void {
    racers.forEach(racer => {
        racer.bodies.forEach((body, i) => {
            if (racer.parts[i] && body.isValid()) {
                const t = body.translation();
                const r = body.rotation();
                racer.parts[i].position.set(t.x, t.y, t.z);
                racer.parts[i].quaternion.set(r.x, r.y, r.z, r.w);
            }
        });
    });
}
