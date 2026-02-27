import { useEffect, useRef, useCallback, useState } from 'react';
import * as THREE from 'three';
import type { World, RigidBody } from '@dimforge/rapier3d-compat';

import { GRAVITY } from '../physics/world';
import { createTrack, updateTrackAnimations, type AnimatedObject } from '../physics/track';
import { createRagdoll, syncRagdolls, RACER_SPECIES } from '../physics/ragdolls';
import { useGameStore } from '../store/gameStore';

interface RacerData {
    bodies: RigidBody[];
    parts: THREE.Mesh[];
    headBody: RigidBody;
}

const GROUND_Y = -5;
const TARGET_RACE_SECONDS = 6;
const RACE_TIMEOUT_SECONDS = 6.5;

export default function RaceCanvas() {
    const containerRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const worldRef = useRef<World | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const clockRef = useRef(new THREE.Clock());

    const racersRef = useRef<RacerData[]>([]);
    const trackRef = useRef<{ finishZ: number; animatedObjects: AnimatedObject[]; rampPos: THREE.Vector3; angleRad: number; rampTopZ: number; rampBottomZ: number; groundY: number } | null>(null);
    const frameIdRef = useRef<number>(0);
    const raceFinishedRef = useRef(false);
    const clockStartedRef = useRef(false);
    const cameraInitializedRef = useRef(false);
    const raceStartTimeRef = useRef(0);
    const physicsAccumulatorRef = useRef(0);
    const racerForcesRef = useRef<number[]>([]);
    const lockedLeaderIndexRef = useRef(0);
    const smoothedLeaderPosRef = useRef(new THREE.Vector3());
    const smoothedLookTargetRef = useRef(new THREE.Vector3());

    const { racers, finishRace, state: gameState } = useGameStore();

    const gameStateRef = useRef(gameState);
    gameStateRef.current = gameState;
    const finishRaceRef = useRef(finishRace);
    finishRaceRef.current = finishRace;

    const [isPhysicsReady, setIsPhysicsReady] = useState(false);

    useEffect(() => {
        let mounted = true;

        async function initPhysics() {
            try {
                const RAPIER = await import('@dimforge/rapier3d-compat');
                await RAPIER.init();
                if (mounted) {
                    setIsPhysicsReady(true);
                    console.log('Rapier Physics Initialized');
                }
            } catch (err) {
                console.error('Failed to init Rapier:', err);
            }
        }

        initPhysics();
        return () => { mounted = false; };
    }, []);

    const initScene = useCallback(async () => {
        if (!containerRef.current || !isPhysicsReady) return;

        if (rendererRef.current && containerRef.current.contains(rendererRef.current.domElement)) {
            containerRef.current.removeChild(rendererRef.current.domElement);
            rendererRef.current.dispose();
        }

        if (worldRef.current) {
            worldRef.current.free();
            worldRef.current = null;
        }

        const container = containerRef.current;
        const width = container.clientWidth;
        const height = container.clientHeight;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1e3a5f);
        scene.fog = new THREE.Fog(0x1e3a5f, 80, 400);
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
        camera.position.set(0, 15, -30);
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        container.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambientLight);

        const hemiLight = new THREE.HemisphereLight(0x87CEEB, 0x444444, 0.8);
        scene.add(hemiLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 2.5);
        directionalLight.position.set(30, 80, -20);
        directionalLight.castShadow = true;
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        directionalLight.shadow.camera.near = 0.5;
        directionalLight.shadow.camera.far = 500;
        directionalLight.shadow.camera.left = -100;
        directionalLight.shadow.camera.right = 100;
        directionalLight.shadow.camera.top = 100;
        directionalLight.shadow.camera.bottom = -100;
        scene.add(directionalLight);

        const fillLight = new THREE.DirectionalLight(0xffe0b2, 1.0);
        fillLight.position.set(-40, 50, 60);
        scene.add(fillLight);

        const groundGeo = new THREE.PlaneGeometry(500, 500);
        const groundMat = new THREE.MeshStandardMaterial({ color: 0x2a2a3a, roughness: 0.9 });
        const groundMesh = new THREE.Mesh(groundGeo, groundMat);
        groundMesh.rotation.x = -Math.PI / 2;
        groundMesh.position.y = GROUND_Y;
        groundMesh.receiveShadow = true;
        scene.add(groundMesh);

        const RAPIER = await import('@dimforge/rapier3d-compat');
        const world = new RAPIER.World(new RAPIER.Vector3(GRAVITY.x, GRAVITY.y, GRAVITY.z));
        worldRef.current = world;

        const slopeAngle = 20;
        const track = createTrack(scene, world, slopeAngle, GROUND_Y);
        trackRef.current = track;

        const angleRad = THREE.MathUtils.degToRad(slopeAngle);
        const trackWidth = 20;
        const laneWidth = trackWidth / 8;

        racersRef.current = racers.map((racer, index) => {
            const laneX = -trackWidth / 2 + laneWidth / 2 + index * laneWidth;
            const startZ = -80;
            const localPos = new THREE.Vector3(laneX, 3, startZ);
            localPos.applyAxisAngle(new THREE.Vector3(1, 0, 0), angleRad);
            const worldPos = track.rampPos.clone().add(localPos);

            const species = RACER_SPECIES.find(s => s.type === racer.type) || RACER_SPECIES[0];
            const ragdoll = createRagdoll(
                scene,
                world,
                worldPos,
                species.type
            );

            return {
                bodies: ragdoll.bodies,
                parts: ragdoll.parts,
                headBody: ragdoll.headBody
            };
        });

        racerForcesRef.current = racers.map(() => 0.7 + Math.random() * 0.6);

        if (typeof window !== 'undefined') {
            const initialPositions = racersRef.current.map((racer, idx) => {
                const t = racer.headBody.translation();
                return { index: idx, x: t.x, y: t.y, z: t.z };
            });
            (window as unknown as Record<string, unknown>).__RACE_INITIAL_POSITIONS__ = initialPositions;
            (window as unknown as Record<string, unknown>).__TRACK_INFO__ = {
                finishZ: track.finishZ,
                rampPosY: track.rampPos.y,
                rampPosZ: track.rampPos.z,
                rampTopZ: track.rampTopZ,
                rampBottomZ: track.rampBottomZ,
                groundY: track.groundY,
                angleRad: track.angleRad,
                startZ: -80,
            };
            (window as unknown as Record<string, unknown>).__RACE_CAMERA_DEBUG__ = null;
            (window as unknown as Record<string, unknown>).__RACE_CAMERA_SAMPLES__ = [];
            (window as unknown as Record<string, unknown>).__RACE_TIMING__ = {
                targetSeconds: TARGET_RACE_SECONDS,
                startedAt: performance.now(),
                finishedAt: null,
                elapsedSeconds: null,
            };
        }

        world.step();

        if (racersRef.current.length > 0) {
            let minZ = Infinity;
            let maxZ = -Infinity;
            let avgY = 0;
            racersRef.current.forEach(racer => {
                const t = racer.headBody.translation();
                if (t.z < minZ) minZ = t.z;
                if (t.z > maxZ) maxZ = t.z;
                avgY += t.y;
            });
            avgY /= racersRef.current.length;
            camera.position.set(0, avgY + 15, minZ - 25);
            camera.lookAt(0, avgY, maxZ);

            const leadIdx = racersRef.current.reduce((bestIdx, racer, idx, list) => (
                racer.headBody.translation().z > list[bestIdx]!.headBody.translation().z ? idx : bestIdx
            ), 0);
            const leadPos = racersRef.current[leadIdx]!.headBody.translation();
            smoothedLeaderPosRef.current.set(leadPos.x, leadPos.y, leadPos.z);
            smoothedLookTargetRef.current.set(leadPos.x, leadPos.y + 1.2, leadPos.z + 8);
            lockedLeaderIndexRef.current = leadIdx;
        }

        raceFinishedRef.current = false;
        clockStartedRef.current = false;
        cameraInitializedRef.current = false;
        raceStartTimeRef.current = performance.now();
        physicsAccumulatorRef.current = 0;
        clockRef.current = new THREE.Clock();

    }, [racers, isPhysicsReady]);

    const animate = useCallback(() => {
        frameIdRef.current = requestAnimationFrame(animate);

        const world = worldRef.current;
        const scene = sceneRef.current;
        const camera = cameraRef.current;
        const renderer = rendererRef.current;
        const track = trackRef.current;

        if (!world || !scene || !camera || !renderer || !track) return;

        const deltaTime = Math.min(clockRef.current.getDelta(), 0.1);
        const isFirstFrame = !clockStartedRef.current;
        if (isFirstFrame) clockStartedRef.current = true;

        if (!isFirstFrame && !raceFinishedRef.current) {
            const angleRad = track.angleRad;
            const sinA = Math.sin(angleRad);
            const cosA = Math.cos(angleRad);
            const basePushForce = 5;
            const maxVelocity = 8;

            racersRef.current.forEach((racer, rIdx) => {
                const forceMultiplier = racerForcesRef.current[rIdx] ?? 1.0;
                const torso = racer.bodies[0];
                if (!torso) return;
                const f = basePushForce * forceMultiplier * (torso.mass());
                torso.addForce({ x: 0, y: -sinA * f, z: cosA * f }, true);

                const linVel = torso.linvel();
                const speed = Math.sqrt(linVel.x * linVel.x + linVel.y * linVel.y + linVel.z * linVel.z);
                if (speed > maxVelocity) {
                    const scale = maxVelocity / speed;
                    torso.setLinvel({ x: linVel.x * scale, y: linVel.y * scale, z: linVel.z * scale }, true);
                }
            });

            world.step();
        }

        syncRagdolls(racersRef.current);

        if (track.animatedObjects) {
            updateTrackAnimations(track.animatedObjects, deltaTime);
        }

        let leadZ = -Infinity;
        let leaderIdx = 0;
        const leaderPos = new THREE.Vector3();
        const packPositions: THREE.Vector3[] = [];
        let packMinZ = Infinity;
        racersRef.current.forEach((racer, index) => {
            const t = racer.headBody.translation();
            const position = new THREE.Vector3(t.x, t.y, t.z);
            packPositions.push(position);
            if (t.z > leadZ) {
                leadZ = t.z;
                leaderIdx = index;
                leaderPos.copy(position);
            }
            if (t.z < packMinZ) packMinZ = t.z;
        });

        const currentLeaderIdx = Math.min(lockedLeaderIndexRef.current, Math.max(0, racersRef.current.length - 1));
        const currentLeaderPos = racersRef.current[currentLeaderIdx]?.headBody.translation();
        const shouldSwitchLeader = !currentLeaderPos || (leadZ - currentLeaderPos.z) > 1.5;
        if (shouldSwitchLeader) {
            lockedLeaderIndexRef.current = leaderIdx;
        }

        const lockedLeader = racersRef.current[Math.min(lockedLeaderIndexRef.current, racersRef.current.length - 1)];
        if (lockedLeader) {
            const t = lockedLeader.headBody.translation();
            leaderPos.set(t.x, t.y, t.z);
        }

        const slopeDir = new THREE.Vector3(0, -Math.sin(track.angleRad), Math.cos(track.angleRad)).normalize();
        const leaderVelocity = lockedLeader?.bodies[0]?.linvel();
        const leaderSpeed = leaderVelocity
            ? Math.sqrt((leaderVelocity.x ** 2) + (leaderVelocity.y ** 2) + (leaderVelocity.z ** 2))
            : 0;

        const followDistance = THREE.MathUtils.clamp(8 + leaderSpeed * 0.2, 8, 12);
        const followHeight = THREE.MathUtils.clamp(4 + leaderSpeed * 0.08, 4, 6);
        const lookAhead = THREE.MathUtils.clamp(10 + leaderSpeed * 0.35, 10, 18);

        const targetCamPos = leaderPos
            .clone()
            .addScaledVector(slopeDir, -followDistance)
            .add(new THREE.Vector3(0, followHeight, 0));
        targetCamPos.y = Math.max(targetCamPos.y, track.groundY + 3.5);

        smoothedLeaderPosRef.current.lerp(leaderPos, 0.08);

        const targetLook = smoothedLeaderPosRef.current
            .clone()
            .addScaledVector(slopeDir, lookAhead)
            .add(new THREE.Vector3(0, 1.2, 0));
        smoothedLookTargetRef.current.lerp(targetLook, 0.1);

        if (!cameraInitializedRef.current) {
            camera.position.copy(targetCamPos);
            cameraInitializedRef.current = true;
        } else {
            camera.position.lerp(targetCamPos, 0.06);
        }
        camera.lookAt(smoothedLookTargetRef.current);

        if (typeof window !== 'undefined') {
            const frameSample = {
                leaderIndex: leaderIdx,
                leader: { x: smoothedLeaderPosRef.current.x, y: smoothedLeaderPosRef.current.y, z: smoothedLeaderPosRef.current.z },
                camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
                lookTarget: { x: smoothedLookTargetRef.current.x, y: smoothedLookTargetRef.current.y, z: smoothedLookTargetRef.current.z },
                followDistance,
                followHeight,
                lookAhead,
                leadZ,
                packMinZ,
                timestamp: performance.now()
            };

            const win = window as unknown as Record<string, unknown>;
            win.__RACE_CAMERA_DEBUG__ = frameSample;
            const samples = ((win.__RACE_CAMERA_SAMPLES__ as Array<typeof frameSample>) ?? []);
            samples.push(frameSample);
            if (samples.length > 300) samples.shift();
            win.__RACE_CAMERA_SAMPLES__ = samples;
            win.__RACE_PACK_POSITIONS__ = packPositions.map((p) => ({ x: p.x, y: p.y, z: p.z }));
        }

        if (!raceFinishedRef.current && gameStateRef.current === 'RACING') {
            racersRef.current.forEach((racer, index) => {
                const t = racer.headBody.translation();
                if (t.z >= track.finishZ) {
                    raceFinishedRef.current = true;
                    if (typeof window !== 'undefined') {
                        const elapsedSeconds = (performance.now() - raceStartTimeRef.current) / 1000;
                        (window as unknown as Record<string, unknown>).__RACE_TIMING__ = {
                            targetSeconds: TARGET_RACE_SECONDS,
                            startedAt: raceStartTimeRef.current,
                            finishedAt: performance.now(),
                            elapsedSeconds,
                        };
                    }
                    finishRaceRef.current(index);
                }
            });

            if (!raceFinishedRef.current) {
                const elapsed = (performance.now() - raceStartTimeRef.current) / 1000;
                if (elapsed > RACE_TIMEOUT_SECONDS) {
                    let timeoutLeadIdx = 0;
                    let bestZ = -Infinity;
                    racersRef.current.forEach((racer, index) => {
                        const z = racer.headBody.translation().z;
                        if (z > bestZ) { bestZ = z; timeoutLeadIdx = index; }
                    });
                    raceFinishedRef.current = true;
                    if (typeof window !== 'undefined') {
                        const elapsedSeconds = (performance.now() - raceStartTimeRef.current) / 1000;
                        (window as unknown as Record<string, unknown>).__RACE_TIMING__ = {
                            targetSeconds: TARGET_RACE_SECONDS,
                            startedAt: raceStartTimeRef.current,
                            finishedAt: performance.now(),
                            elapsedSeconds,
                        };
                    }
                    finishRaceRef.current(timeoutLeadIdx);
                }
            }
        }

        renderer.render(scene, camera);
    }, []);

    useEffect(() => {
        initScene();
        animate();

        const handleResize = () => {
            if (!containerRef.current || !cameraRef.current || !rendererRef.current) return;
            const width = containerRef.current.clientWidth;
            const height = containerRef.current.clientHeight;
            cameraRef.current.aspect = width / height;
            cameraRef.current.updateProjectionMatrix();
            rendererRef.current.setSize(width, height);
        };
        window.addEventListener('resize', handleResize);

        return () => {
            cancelAnimationFrame(frameIdRef.current);
            window.removeEventListener('resize', handleResize);
            if (rendererRef.current && containerRef.current?.contains(rendererRef.current.domElement)) {
                containerRef.current.removeChild(rendererRef.current.domElement);
            }
            rendererRef.current?.dispose();
            if (worldRef.current) {
                worldRef.current.free();
                worldRef.current = null;
            }
        };
    }, [initScene, animate]);

    return <div ref={containerRef} data-testid="race-canvas" className="w-full h-full" />;
}
