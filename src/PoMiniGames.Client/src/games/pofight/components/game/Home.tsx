import { memo } from 'react';

interface HomeProps {
    onSelectMode: (mode: 'PvCPU' | 'CPUvCPU') => void;
}

export const Home = memo(function Home({ onSelectMode }: HomeProps) {
    return (
        <div className="w-full h-full flex flex-col items-center justify-center bg-zinc-900 text-white p-8">
            <h1 className="text-6xl font-black italic mb-16 tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-red-600 drop-shadow-[0_0_15px_rgba(250,204,21,0.5)]">
                PO FIGHT
            </h1>

            <div className="flex flex-col gap-6 w-full max-w-md">
                <button
                    onClick={() => onSelectMode('PvCPU')}
                    className="group relative px-8 py-6 bg-zinc-800 border-l-8 border-blue-500 hover:bg-zinc-700 transition-all hover:scale-105 hover:pl-10 text-left overflow-hidden"
                >
                    <div className="absolute inset-0 bg-blue-500/10 translate-x-[-100%] group-hover:translate-x-0 transition-transform duration-300" />
                    <span className="text-3xl font-black italic relative z-10">1 PLAYER</span>
                    <p className="text-zinc-400 text-sm mt-1 relative z-10">Fight against the CPU</p>
                </button>

                <button
                    onClick={() => onSelectMode('CPUvCPU')}
                    className="group relative px-8 py-6 bg-zinc-800 border-l-8 border-red-500 hover:bg-zinc-700 transition-all hover:scale-105 hover:pl-10 text-left overflow-hidden"
                >
                    <div className="absolute inset-0 bg-red-500/10 translate-x-[-100%] group-hover:translate-x-0 transition-transform duration-300" />
                    <span className="text-3xl font-black italic relative z-10">CPU vs CPU</span>
                    <p className="text-zinc-400 text-sm mt-1 relative z-10">Watch AI fight perfectly</p>
                </button>
            </div>

            <div className="mt-16 text-zinc-600 font-mono text-xs">
                v0.2.0 • WebGPU Enabled
            </div>
        </div>
    );
});
