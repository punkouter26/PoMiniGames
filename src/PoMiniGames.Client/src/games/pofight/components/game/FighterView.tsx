

import { useEffect, useRef, memo } from 'react';
import { Fighter } from '../../engine/Fighter';
import { FIGHTER_WIDTH, FIGHTER_HEIGHT, WIND_UP_TIME, MAX_CHARGE_TIME } from '../../engine/Constants';

interface FighterViewProps {
    fighter: Fighter;
}

export const FighterView = memo(function FighterView({ fighter }: FighterViewProps) {
    const gRef = useRef<SVGGElement>(null);
    const bodyRef = useRef<SVGGElement>(null);
    const chargeRef = useRef<SVGCircleElement>(null);
    const rightArmRef = useRef<SVGPathElement>(null);
    const rightLegRef = useRef<SVGPathElement>(null);

    useEffect(() => {
        // Subscribe to Position Updates (60FPS) — includes Y for jump
        const unsubX = fighter.x.subscribe((val) => {
            if (gRef.current) {
                gRef.current.style.transform = `translate(${val}px, ${fighter.y.value}px)`;
            }
        });
        const unsubY = fighter.y.subscribe((val) => {
            if (gRef.current) {
                gRef.current.style.transform = `translate(${fighter.x.value}px, ${val}px)`;
            }
        });

        const unsubState = fighter.state.subscribe((state) => {
            if (bodyRef.current) {
                // Dynamic Coloring
                let color = '#3b82f6'; // Blue-500 default
                if (state === 'CHARGING') color = '#fbbf24'; // Amber-400
                if (state === 'ATTACKING') color = '#ef4444'; // Red-500
                if (state === 'BLOCKING') color = '#38bdf8'; // Sky-400
                if (state === 'JUMPING') color = '#a78bfa'; // Violet-400
                if (state === 'OVERHEATED') color = '#78716c'; // Stone-500
                if (state === 'STUNNED') color = '#f97316'; // Orange-500

                if (fighter.id === 'cpu') {
                    if (color === '#3b82f6') color = '#dc2626'; // Red default for CPU
                }

                bodyRef.current.style.color = color;

                // Pose Logic
                const cx = FIGHTER_WIDTH / 2;
                if (state === 'ATTACKING') {
                    const type = fighter.attackType.peek();

                    if (type === 'PUNCH') {
                        // Body-level punch — arm extends forward
                        const armPath = `M ${cx + 15},55 L ${cx + 60},55`;
                        if (rightArmRef.current) rightArmRef.current.setAttribute('d', armPath);
                    } else if (type === 'KICK') {
                        // Body-level kick — leg extends forward
                        const legPath = `M ${cx + 10},110 L ${cx + 60},110`;
                        if (rightLegRef.current) rightLegRef.current.setAttribute('d', legPath);
                    }
                } else {
                    // Reset Poses (guard position)
                    if (rightArmRef.current) rightArmRef.current.setAttribute('d', `M ${cx + 15},55 L ${cx + 30},80 L ${cx + 45},60`);
                    if (rightLegRef.current) rightLegRef.current.setAttribute('d', `M ${cx + 10},110 L ${cx + 25},190`);
                }
            }
        });

        const unsubCharge = fighter.chargeLevel.subscribe((level) => {
            if (chargeRef.current) {
                // Visualize charge as a growing aura behind
                chargeRef.current.setAttribute('r', (level * 60 + 10).toString());
                chargeRef.current.setAttribute('opacity', (level * 0.5).toString());
            }

            // Wind-up animation: pull arm/leg back progressively while charging
            // Visual wind-up completes at WIND_UP_TIME (0.5s), power continues to MAX_CHARGE_TIME (1.0s)
            const currentState = fighter.state.peek();
            if (currentState === 'CHARGING') {
                const type = fighter.attackType.peek();
                const cx = FIGHTER_WIDTH / 2;
                const windUpRatio = WIND_UP_TIME / MAX_CHARGE_TIME; // 0.5
                const windUp = Math.min(level / windUpRatio, 1.0); // reaches 1.0 at 0.5s

                if (type === 'PUNCH' && rightArmRef.current) {
                    // Arm pulls back from guard position to fully cocked behind shoulder
                    const elbowX = cx + 30 - windUp * 40;
                    const elbowY = 80 - windUp * 15;
                    const fistX = cx + 45 - windUp * 70;
                    const fistY = 60 - windUp * 15;
                    rightArmRef.current.setAttribute('d',
                        `M ${cx + 15},55 L ${elbowX},${elbowY} L ${fistX},${fistY}`);
                }

                if (type === 'KICK' && rightLegRef.current) {
                    // Leg chambers: knee bends, foot pulls up and back
                    const kneeX = cx + 17 - windUp * 12;
                    const kneeY = 150;
                    const footX = cx + 25 - windUp * 40;
                    const footY = 190 - windUp * 65;
                    rightLegRef.current.setAttribute('d',
                        `M ${cx + 10},110 L ${kneeX},${kneeY} L ${footX},${footY}`);
                }
            }
        });

        return () => {
            unsubX();
            unsubY();
            unsubState();
            unsubCharge();
        };
    }, [fighter]);

    // Flip CPU or based on facing logic (if implemented in signals later)
    // For now, static facing based on ID
    const scaleX = fighter.id === 'cpu' ? -1 : 1;
    const offsetX = fighter.id === 'cpu' ? FIGHTER_WIDTH : 0;

    return (
        <g 
            ref={gRef}
            data-testid={`fighter-${fighter.id}`}
            style={{ 
                transform: `translate(${fighter.x.value}px, ${fighter.y.value}px)`,
                willChange: 'transform',
            }}
        >
            {/* Dynamic Shadow */}
            <ellipse cx={FIGHTER_WIDTH / 2} cy={FIGHTER_HEIGHT} rx={FIGHTER_WIDTH / 2 + 10} ry={8} fill="rgba(0,0,0,0.4)" filter="blur(4px)" />

            {/* Charge Aura (Behind) */}
            <circle
                ref={chargeRef}
                data-testid={`charge-aura-${fighter.id}`}
                cx={FIGHTER_WIDTH / 2}
                cy={FIGHTER_HEIGHT / 2}
                r="0"
                fill="transparent"
                stroke="currentColor"
                strokeWidth="4"
                opacity="0"
                className="text-yellow-400"
                style={{ filter: 'drop-shadow(0 0 15px currentColor)', willChange: 'r, opacity' }}
            />

            {/* Humanoid Body Group - Pivot simplified center */}
            <g
                ref={bodyRef}
                style={{ color: fighter.id === 'cpu' ? '#dc2626' : '#3b82f6', willChange: 'color' }}
                transform={`translate(${offsetX}, 0) scale(${scaleX}, 1)`}
            >
                {/* Head */}
                <circle cx={FIGHTER_WIDTH / 2} cy={30} r={15} fill="currentColor" />

                {/* Eye (White, visible direction) */}
                <circle cx={FIGHTER_WIDTH / 2 + 8} cy={28} r={3} fill="white" />

                {/* Torso - Tapered V-shape */}
                <path d={`M ${FIGHTER_WIDTH / 2 - 20},50 L ${FIGHTER_WIDTH / 2 + 20},50 L ${FIGHTER_WIDTH / 2 + 10},110 L ${FIGHTER_WIDTH / 2 - 10},110 Z`} fill="currentColor" />

                {/* Arms (Resting Pose) */}
                <path d={`M ${FIGHTER_WIDTH / 2 - 15},55 L ${FIGHTER_WIDTH / 2 - 30},90`} stroke="currentColor" strokeWidth="10" strokeLinecap="round" />
                <path ref={rightArmRef} data-testid={`right-arm-${fighter.id}`} d={`M ${FIGHTER_WIDTH / 2 + 15},55 L ${FIGHTER_WIDTH / 2 + 30},80 L ${FIGHTER_WIDTH / 2 + 45},60`} stroke="currentColor" strokeWidth="10" strokeLinecap="round" /> {/* Guard up slightly */}

                {/* Legs */}
                <path d={`M ${FIGHTER_WIDTH / 2 - 10},110 L ${FIGHTER_WIDTH / 2 - 20},190`} stroke="currentColor" strokeWidth="12" strokeLinecap="round" />
                <path ref={rightLegRef} data-testid={`right-leg-${fighter.id}`} d={`M ${FIGHTER_WIDTH / 2 + 10},110 L ${FIGHTER_WIDTH / 2 + 25},190`} stroke="currentColor" strokeWidth="12" strokeLinecap="round" />

                {/* Belt/Sash */}
                <rect x={FIGHTER_WIDTH / 2 - 12} y={100} width={24} height={6} fill="rgba(0,0,0,0.3)" />

            </g>

            {/* ID Label */}
            <text x={FIGHTER_WIDTH / 2} y={-20} textAnchor="middle" fill="white" className="font-bold text-lg pointer-events-none select-none tracking-widest opacity-50">
                {fighter.id.toUpperCase()}
            </text>
        </g>
    );
});
