import { useRef } from 'react';
import * as THREE from 'three';

interface CameraFollowOptions {
    followDistance?: number;
    followHeight?: number;
    lookAhead?: number;
    lerpFactor?: number;
}

export function useCameraFollow(options: CameraFollowOptions = {}) {
    const {
        followDistance = 10,
        followHeight = 5,
        lookAhead = 12,
        lerpFactor = 0.08
    } = options;

    const smoothedLeaderPos = useRef(new THREE.Vector3());
    const smoothedLookTarget = useRef(new THREE.Vector3());
    const lockedLeaderIndex = useRef(0);
    const cameraInitialized = useRef(false);

    function update(
        camera: THREE.PerspectiveCamera,
        racerPositions: THREE.Vector3[],
        angleRad: number,
        groundY: number
    ) {
        if (racerPositions.length === 0) return;

        let leadZ = -Infinity;
        let leaderIdx = 0;
        const leaderPos = new THREE.Vector3();

        racerPositions.forEach((pos, idx) => {
            if (pos.z > leadZ) {
                leadZ = pos.z;
                leaderIdx = idx;
                leaderPos.copy(pos);
            }
        });

        const currentLeaderPos = racerPositions[lockedLeaderIndex.current];
        const shouldSwitch = !currentLeaderPos || (leadZ - currentLeaderPos.z) > 1.5;
        if (shouldSwitch) {
            lockedLeaderIndex.current = leaderIdx;
        }

        const slopeDir = new THREE.Vector3(0, -Math.sin(angleRad), Math.cos(angleRad)).normalize();

        const targetCamPos = leaderPos
            .clone()
            .addScaledVector(slopeDir, -followDistance)
            .add(new THREE.Vector3(0, followHeight, 0));
        targetCamPos.y = Math.max(targetCamPos.y, groundY + 3.5);

        smoothedLeaderPos.current.lerp(leaderPos, lerpFactor);

        const targetLook = smoothedLeaderPos.current
            .clone()
            .addScaledVector(slopeDir, lookAhead)
            .add(new THREE.Vector3(0, 1.2, 0));
        smoothedLookTarget.current.lerp(targetLook, lerpFactor * 1.25);

        if (!cameraInitialized.current) {
            camera.position.copy(targetCamPos);
            cameraInitialized.current = true;
        } else {
            camera.position.lerp(targetCamPos, lerpFactor);
        }
        camera.lookAt(smoothedLookTarget.current);
    }

    function reset() {
        cameraInitialized.current = false;
        lockedLeaderIndex.current = 0;
        smoothedLeaderPos.current.set(0, 0, 0);
        smoothedLookTarget.current.set(0, 0, 0);
    }

    return { update, reset };
}
