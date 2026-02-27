import { useState, useCallback } from 'react';
import { Difficulty, GameResult } from '../shared/types';
import { statsService } from '../shared/statsService';
import { usePlayerName } from '../../context/PlayerNameContext';
import { GamePageShell, type StatItem } from '../shared/GamePageShell';
import { Trophy, XCircle, RotateCcw } from 'lucide-react';
import { useGameStore } from './store/gameState';
import { Home } from './components/game/Home';
import { CharacterSelect } from './components/game/CharacterSelect';
import Stage from './components/game/Stage';
import { GameErrorBoundary } from './components/GameErrorBoundary';
import './pofight.css';

type Screen = 'HOME' | 'SELECT' | 'GAME';
type GameMode = 'PvCPU' | 'CPUvCPU';

const GAME_KEY = 'pofight';

const DIFFICULTY_LEVELS: Record<Difficulty, number> = {
  [Difficulty.Easy]: 1,
  [Difficulty.Medium]: 3,
  [Difficulty.Hard]: 5,
};

export default function PoFightPage() {
  const { playerName } = usePlayerName();
  const [screen, setScreen] = useState<Screen>('HOME');
  const [gameMode, setGameMode] = useState<GameMode>('PvCPU');
  const [difficulty, setDifficulty] = useState(Difficulty.Medium);
  const [stats, setStats] = useState(() => statsService.getStats(GAME_KEY, playerName));
  const [lastResult, setLastResult] = useState<GameResult | null>(null);

  const handleSelectMode = (mode: GameMode) => {
    setGameMode(mode);
    setScreen('SELECT');
  };

  const handleStartGame = useCallback(() => {
    // Set AI level in game store before starting
    useGameStore.getState().setCurrentLevel(DIFFICULTY_LEVELS[difficulty]);
    setScreen('GAME');
    setLastResult(null);
  }, [difficulty]);

  const handleGameEnd = useCallback(async (result: 'win' | 'loss') => {
    const gameResult = result === 'win' ? GameResult.Win : GameResult.Loss;
    setLastResult(gameResult);
    const updated = await statsService.recordResult(GAME_KEY, playerName, difficulty, gameResult);
    setStats(updated);
    setScreen('HOME');
  }, [playerName, difficulty]);

  const handleManualResult = async (result: GameResult) => {
    setLastResult(result);
    const updated = await statsService.recordResult(GAME_KEY, playerName, difficulty, result);
    setStats(updated);
  };

  const resetToHome = () => {
    setScreen('HOME');
    setLastResult(null);
  };

  const diffBucket = statsService.getDifficultyBucket(stats, difficulty);

  const statItems: StatItem[] = [
    { value: diffBucket.wins, label: 'W' },
    { value: diffBucket.losses, label: 'L' },
    { value: diffBucket.draws, label: 'D' },
    { value: diffBucket.winStreak, label: 'Str' },
    { value: `${(diffBucket.winRate * 100).toFixed(0)}%`, label: 'Rate' },
  ];

  const statusNode = lastResult === GameResult.Win
    ? <span className="gps-status-badge gps-status-badge--win">Victory!</span>
    : lastResult === GameResult.Loss
      ? <span className="gps-status-badge gps-status-badge--loss">Defeated</span>
      : null;

  return (
    <GamePageShell
      title="PoFight"
      player={playerName}
      status={statusNode}
      controls={
        <>
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as Difficulty)}
          >
            <option value={Difficulty.Easy}>Easy</option>
            <option value={Difficulty.Medium}>Medium</option>
            <option value={Difficulty.Hard}>Hard</option>
          </select>
          {screen === 'GAME' && (
            <>
              <button className="btn-win" onClick={() => handleManualResult(GameResult.Win)}>
                <Trophy size={12} /> Win
              </button>
              <button className="btn-loss" onClick={() => handleManualResult(GameResult.Loss)}>
                <XCircle size={12} /> Loss
              </button>
              <button className="gps-open-link" onClick={resetToHome}>
                <RotateCcw size={12} /> Quit
              </button>
            </>
          )}
        </>
      }
      stats={statItems}
      fullscreen
    >
      <GameErrorBoundary>
        {screen === 'HOME' && (
          <Home onSelectMode={handleSelectMode} />
        )}
        {screen === 'SELECT' && (
          <CharacterSelect onStart={handleStartGame} mode={gameMode} />
        )}
        {screen === 'GAME' && (
          <Stage gameMode={gameMode} onGameEnd={handleGameEnd} />
        )}
      </GameErrorBoundary>
    </GamePageShell>
  );
}
