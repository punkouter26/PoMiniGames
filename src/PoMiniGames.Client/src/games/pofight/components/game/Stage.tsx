

import { useEffect, useState, memo } from 'react';
import { gameLoop } from '../../engine/GameLoop';
import { FightManager } from '../../engine/FightManager';

import { HUD } from './HUD';
import { FighterView } from './FighterView';
import { GAME_WIDTH, GAME_HEIGHT } from '../../engine/Constants';
import { cameraSystem } from '../../engine/CameraSystem';
import { useSignal } from '../../hooks/useSignal';
import { WebGPUCanvas } from './WebGPUCanvas';



const GameCanvas = memo(function GameCanvas({ manager }: { manager: FightManager }) {
    const forceRenderer = new URLSearchParams(window.location.search).get('renderer');
    const [renderer, setRenderer] = useState<'webgpu' | 'legacy'>(
        forceRenderer === 'legacy' ? 'legacy' : 'webgpu'
    );
    const [errorMsg, setErrorMsg] = useState<string | null>(
        forceRenderer === 'legacy' ? 'Forced via query param' : null
    );
    const viewBox = useSignal(cameraSystem.viewBox);

    const handleWebGPUError = (e: Error) => {
        console.warn("WebGPU Error, falling back to Legacy renderer:", e);
        setErrorMsg(e.message);
        setRenderer('legacy');
    };

    if (renderer === 'legacy') {
        return (
            <svg
                viewBox={viewBox}
                className="w-full h-full max-w-[1920px] max-h-[1080px] bg-gradient-to-b from-slate-900 to-slate-800"
                xmlns="http://www.w3.org/2000/svg"
            >
                {/* Fallback SVG Rendering */}
                <line x1="0" y1={GAME_HEIGHT - 100} x2={GAME_WIDTH} y2={GAME_HEIGHT - 100} stroke="#334155" strokeWidth="200" />
                <FighterView fighter={manager.player} />
                <FighterView fighter={manager.cpu} />
                <text x="50%" y="50" textAnchor="middle" fill="white" className="opacity-50">Legacy Renderer (WebGPU: {errorMsg})</text>
            </svg>
        );
    }

    return (
        <div className="w-full h-full max-w-[1920px] max-h-[1080px] bg-gradient-to-b from-slate-900 to-slate-800 relative">
            <WebGPUCanvas
                fighters={[manager.player, manager.cpu]}
                onError={handleWebGPUError}
                onRendererReady={(r) => manager.setRenderer(r)}
            />
            {/* Keep HUD as HTML overlay in parent */}
        </div>
    );
});

const HUDOverlay = memo(function HUDOverlay({ manager }: { manager: FightManager }) {
    return (
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none">
            <HUD player={manager.player} cpu={manager.cpu} />
        </div>
    );
});

export default function Stage({ gameMode = 'PvCPU', onGameEnd }: { gameMode?: 'PvCPU' | 'CPUvCPU'; onGameEnd?: (result: 'win' | 'loss') => void }) {
    const [manager, setManager] = useState<FightManager | null>(null);

    useEffect(() => {
        console.log('Stage: Mount Effect');
        const mgr = new FightManager(gameLoop, gameMode, onGameEnd);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setManager(mgr);

        // Start loop
        gameLoop.start();

        return () => {
            console.log('Stage: Cleanup');
            gameLoop.stop();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!manager) return <div className="text-white">Loading Arena...</div>;

    return (
        <div className="flex items-center justify-center w-full h-full bg-zinc-900 border-4 border-zinc-800 rounded-lg overflow-hidden shadow-2xl relative">
            <GameCanvas manager={manager} />
            <HUDOverlay manager={manager} />
        </div>
    );
}
