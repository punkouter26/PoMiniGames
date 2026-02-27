
import { memo } from 'react';
import { Signal } from '../../engine/Signals';
import { useSignal } from '../../hooks/useSignal';

export const HealthBar = memo(function HealthBar({ health, color = 'bg-blue-500' }: { health: Signal<number>, color?: string }) {
    const healthValue = useSignal(health);

    return (
        <div className="w-[400px] h-8 bg-zinc-800 border-2 border-zinc-600 skew-x-[-15deg] overflow-hidden relative shadow-inner">
            <div
                className={`h-full ${color} transition-all duration-100 ease-out`}
                style={{ width: `${Math.max(0, healthValue)}%` }}
            />
            {/* Glint effect */}
            <div className="absolute top-0 left-0 w-full h-1/2 bg-white opacity-10 pointer-events-none" />
        </div>
    );
});

export const PowerBar = memo(function PowerBar({ chargeLevel, label }: { chargeLevel: Signal<number>, label: string }) {
    const charge = useSignal(chargeLevel);

    // Color ramps green→yellow→red as charge increases
    let barColor = 'bg-green-500';
    if (charge > 0.5) barColor = 'bg-yellow-400';
    if (charge >= 0.9) barColor = 'bg-red-500';

    return (
        <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider skew-x-[-15deg]">{label}</span>
            <div
                data-testid={`power-bar-${label.toLowerCase()}`}
                className="w-[200px] h-3 bg-zinc-900 border border-zinc-700 skew-x-[-15deg] overflow-hidden relative"
            >
                <div
                    className={`h-full ${barColor} transition-all duration-75 ease-out`}
                    style={{ width: `${charge * 100}%` }}
                    data-testid={`power-fill-${label.toLowerCase()}`}
                />
            </div>
        </div>
    );
});

import { Fighter } from '../../engine/Fighter';

const PlayerLabel = memo(function PlayerLabel() {
    return (
        <h2 className="text-3xl text-white font-black tracking-widest italic drop-shadow-[0_4px_4px_rgba(0,0,0,0.8)]">
            PLAYER
        </h2>
    );
});

const CpuLabel = memo(function CpuLabel({ level }: { level: string }) {
    return (
        <h2 className="text-3xl text-red-500 font-black tracking-widest italic drop-shadow-[0_4px_4px_rgba(0,0,0,0.8)]">
            CPU <span className="text-lg text-zinc-400 not-italic ml-2">LEVEL {level}</span>
        </h2>
    );
});

export const HUD = memo(function HUD({ player, cpu }: { player: Fighter, cpu: Fighter }) {
    return (
        <div className="absolute top-0 left-0 w-full p-12 flex justify-between pointer-events-none">
            <div className="flex flex-col gap-2 items-start">
                <PlayerLabel />
                <HealthBar health={player.health} color="bg-cyan-500 shadow-[0_0_20px_rgba(6,182,212,0.6)]" />
                <PowerBar chargeLevel={player.chargeLevel} label="Power" />
            </div>

            <div className="flex flex-col gap-2 items-end">
                <CpuLabel level={cpu.id === 'cpu' ? '?' : '1'} />
                <HealthBar health={cpu.health} color="bg-red-600 shadow-[0_0_20px_rgba(220,38,38,0.6)]" />
                <PowerBar chargeLevel={cpu.chargeLevel} label="CPU" />
            </div>
        </div>
    );
});
