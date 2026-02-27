import { useCallback, useEffect, useRef, useState } from 'react';
import type { Direction } from './GameCanvas';

interface TouchControlsProps {
  onDirection: (direction: Direction) => void;
}

export function TouchControls({ onDirection }: TouchControlsProps) {
  const [activeDir, setActiveDir] = useState<Direction | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleDir = useCallback((dir: Direction) => {
    setActiveDir(dir);
    onDirection(dir);
    setTimeout(() => setActiveDir(null), 120);
  }, [onDirection]);

  useEffect(() => {
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0]!;
      touchStartRef.current = { x: t.clientX, y: t.clientY };
    };
    const onEnd = (e: TouchEvent) => {
      if (!touchStartRef.current) return;
      const t = e.changedTouches[0]!;
      const dx = t.clientX - touchStartRef.current.x;
      const dy = t.clientY - touchStartRef.current.y;
      const min = 30;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > min) {
        handleDir(dx > 0 ? 'right' : 'left');
      } else if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > min) {
        handleDir(dy > 0 ? 'down' : 'up');
      }
      touchStartRef.current = null;
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
    };
  }, [handleDir]);

  const btn = (dir: Direction, label: string, ariaLabel: string) => (
    <button
      className={`psg-dpad-btn${activeDir === dir ? ' psg-active' : ''}`}
      onTouchStart={e => { e.preventDefault(); handleDir(dir); }}
      onMouseDown={() => handleDir(dir)}
      aria-label={ariaLabel}
    >
      {label}
    </button>
  );

  return (
    <div className="psg-dpad">
      <div />
      {btn('up', '▲', 'Up')}
      <div />
      {btn('left', '◀', 'Left')}
      <div />
      {btn('right', '▶', 'Right')}
      <div />
      {btn('down', '▼', 'Down')}
      <div />
    </div>
  );
}
