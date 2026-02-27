import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { initVoxelShooter } from './voxelshooter';
import { GamePageShell } from '../shared/GamePageShell';
import './VoxelShooterPage.css';

export default function VoxelShooterPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const cleanup = initVoxelShooter(canvas, container, () => {
      navigate('/');
    });

    return cleanup;
  }, [navigate]);

  return (
    <GamePageShell title="Voxel Shooter" fullscreen>
      <div className="voxel-page-container" ref={containerRef}>
        <canvas ref={canvasRef} className="voxel-canvas" />
      </div>
    </GamePageShell>
  );
}
