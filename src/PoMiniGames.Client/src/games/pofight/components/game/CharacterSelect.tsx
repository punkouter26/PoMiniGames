
import React from 'react';
import { useGameStore } from '../../store/gameState';

const FIGHTERS = [
    { id: 'player', name: 'Ryu-ish', color: 'bg-blue-500', desc: 'Balanced fighter with fireballs.' },
    { id: 'fighter2', name: 'Ken-ish', color: 'bg-red-500', desc: 'Aggressive fighter with flaming kicks.' },
    { id: 'fighter3', name: 'Chun-ish', color: 'bg-cyan-500', desc: 'Fast kicks and speed.' },
    { id: 'fighter4', name: 'Guile-ish', color: 'bg-green-500', desc: 'Defensive wall.' },
];

export const CharacterSelect = ({ onStart, mode = 'PvCPU' }: { onStart: () => void, mode?: 'PvCPU' | 'CPUvCPU' }) => {
    const { p1FighterId, setP1FighterId, setP2FighterId } = useGameStore();
    const [status, setStatus] = React.useState(mode === 'CPUvCPU' ? 'CPU 1 SELECTING...' : 'SELECT YOUR FIGHTER');

    React.useEffect(() => {
        if (mode === 'CPUvCPU') {
            const pickRandom = () => FIGHTERS[Math.floor(Math.random() * FIGHTERS.length)]!.id;

            // Sequence:
            // 1. Roll P1
            // 2. Lock P1
            // 3. Roll P2
            // 4. Lock P2 -> Start

            let p1Interval: any;
            let p2Interval: any;

            // Start rolling P1
            p1Interval = setInterval(() => setP1FighterId(pickRandom()), 100);

            // After 1s, stop P1, start P2
            setTimeout(() => {
                clearInterval(p1Interval);
                setStatus('CPU 2 SELECTING...');

                p2Interval = setInterval(() => setP2FighterId(pickRandom()), 100);

                // After another 1s, stop P2, Start
                setTimeout(() => {
                    clearInterval(p2Interval);
                    setStatus('READY!');
                    setTimeout(onStart, 500);
                }, 1000);
            }, 1000);

            return () => {
                clearInterval(p1Interval);
                clearInterval(p2Interval);
            };
        } else {
            // Ensure P2 is random/default for PvCPU
            setP2FighterId(FIGHTERS[Math.floor(Math.random() * FIGHTERS.length)]!.id);
        }
    }, [mode, onStart, setP1FighterId, setP2FighterId]);

    const handleSelect = (id: string) => {
        if (mode === 'CPUvCPU') return; // Ignore input
        setP1FighterId(id);
    };

    return (
        <div className="w-full h-full flex flex-col items-center justify-center bg-zinc-900 text-white p-8">
            <h1 className="text-4xl font-black italic mb-8 tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-red-600 animate-pulse">
                {status}
            </h1>

            <div className="grid grid-cols-2 gap-4 w-full max-w-4xl">
                {FIGHTERS.map(f => (
                    <button
                        key={f.id}
                        onClick={() => handleSelect(f.id)} // Use wrapper
                        disabled={mode === 'CPUvCPU'}
                        className={`
                            relative h-40 p-4 border-4 rounded-lg flex flex-col items-center justify-center gap-2 group transition-all duration-200
                            ${p1FighterId === f.id
                                ? 'border-yellow-400 bg-yellow-900/20 scale-105 shadow-[0_0_30px_rgba(250,204,21,0.3)]'
                                : 'border-zinc-700 bg-zinc-800 hover:border-zinc-500 hover:bg-zinc-750 disabled:opacity-50'}
                        `}
                    >
                        <div className={`w-12 h-12 rounded-full ${f.color} shadow-lg mb-2`} />
                        <span className={`text-2xl font-bold uppercase ${p1FighterId === f.id ? 'text-yellow-400' : 'text-zinc-400'}`}>
                            {f.name}
                        </span>
                        <span className="text-sm text-zinc-500 text-center px-4">{f.desc}</span>

                        {p1FighterId === f.id && (
                            <div className="absolute inset-0 border-2 border-yellow-400 opacity-50 animate-pulse rounded-lg pointer-events-none" />
                        )}
                    </button>
                ))}
            </div>

            {mode === 'PvCPU' && (
                <button
                    onClick={onStart}
                    className="mt-12 px-12 py-4 bg-gradient-to-r from-blue-600 to-blue-400 text-2xl font-black italic skew-x-[-12deg] hover:scale-105 hover:rotate-1 transition-transform shadow-lg border-b-4 border-blue-800 active:border-0 active:translate-y-1"
                >
                    FIGHT!
                </button>
            )}
        </div>
    );
};
