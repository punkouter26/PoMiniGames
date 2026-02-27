import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { createRagdoll } from '../physics/ragdolls';

interface RagdollPreviewProps {
    racerType: string;
    isSelected?: boolean;
}

export default function RagdollPreview({ racerType, isSelected }: RagdollPreviewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const frameIdRef = useRef<number>(0);

    // isSelected used for potential future styling
    void isSelected;

    useEffect(() => {
        if (!containerRef.current) return;

        const container = containerRef.current;
        const width = container.clientWidth;
        const height = container.clientHeight;

        if (width === 0 || height === 0) return;

        const scene = new THREE.Scene();

        const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
        camera.position.set(0, 1.2, 4);
        camera.lookAt(0, 0.2, 0);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setClearColor(0x000000, 0);
        container.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const ambientLight = new THREE.AmbientLight(0x606060, 2.5);
        scene.add(ambientLight);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 3);
        directionalLight.position.set(3, 8, 5);
        scene.add(directionalLight);
        const backLight = new THREE.DirectionalLight(0x4466ff, 1);
        backLight.position.set(-3, 2, -5);
        scene.add(backLight);

        const ragdoll = createRagdoll(scene, null, { x: 0, y: 0, z: 0 }, racerType, { noPhysics: true });

        const clock = new THREE.Clock();
        const animate = () => {
            frameIdRef.current = requestAnimationFrame(animate);
            const time = clock.getElapsedTime();
            ragdoll.root.position.y = Math.sin(time * 1.5) * 0.08;
            ragdoll.root.rotation.y = Math.sin(time * 0.8) * 0.15;
            renderer.render(scene, camera);
        };
        animate();

        const handleResize = () => {
            if (!container || !renderer) return;
            const w = container.clientWidth;
            const h = container.clientHeight;
            if (w === 0 || h === 0) return;
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
        };
        window.addEventListener('resize', handleResize);

        return () => {
            cancelAnimationFrame(frameIdRef.current);
            window.removeEventListener('resize', handleResize);
            if (container.contains(renderer.domElement)) {
                container.removeChild(renderer.domElement);
            }
            renderer.dispose();
        };
    }, [racerType]);

    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
