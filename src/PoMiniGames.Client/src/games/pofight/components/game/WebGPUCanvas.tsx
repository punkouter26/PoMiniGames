import { useRef, useEffect } from 'react';
import { Fighter } from '../../engine/Fighter';
import { WebGPURenderer } from '../../engine/renderer/WebGPURenderer';

interface WebGPUCanvasProps {
    fighters: Fighter[];
    onError?: (err: Error) => void;
    onRendererReady?: (renderer: WebGPURenderer) => void;
}

export const WebGPUCanvas = ({ fighters, onError, onRendererReady }: WebGPUCanvasProps) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rendererRef = useRef<WebGPURenderer | null>(null);

    useEffect(() => {
        if (!canvasRef.current) return;
        console.log('WebGPUCanvas mounted');

        const init = async () => {
            const renderer = new WebGPURenderer(canvasRef.current!);
            try {
                await renderer.initialize();
                rendererRef.current = renderer;
                renderer.setFighters(fighters);
                console.log('WebGPU renderer initialized');
                if (onRendererReady) onRendererReady(renderer);
            } catch (e) {
                // Expected on some machines, warning only
                console.warn("WebGPU Init failed (falling back to legacy):", e);
                if (onError && e instanceof Error) onError(e);
            }
        };

        if (!rendererRef.current) {
            init();
        }

        let animationFrameId: number;
        let lastTime = 0;

        const renderLoop = (time: number) => {
            const dt = (time - lastTime) / 1000;
            lastTime = time;

            if (rendererRef.current) {
                rendererRef.current.render(dt);
            }
            animationFrameId = requestAnimationFrame(renderLoop);
        };

        animationFrameId = requestAnimationFrame(renderLoop);

        return () => {
            cancelAnimationFrame(animationFrameId);
        };
    }, [fighters]); // Re-init if fighters array *reference* changes (rare)

    return (
        <canvas
            ref={canvasRef}
            width={800}
            height={600}
            className="absolute inset-0 z-0 pointer-events-none"
            style={{ width: '100%', height: '100%' }}
        />
    );
};
