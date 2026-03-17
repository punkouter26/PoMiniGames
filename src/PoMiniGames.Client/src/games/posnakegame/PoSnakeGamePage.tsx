import { useState, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { GameCanvas } from './GameCanvas';
import { HighScoreModal } from './HighScoreModal';
import { HighScoreTable } from './HighScoreTable';
import { getHighScores, type SnakeHighScore } from './snakeService';
import './posnakegame.css';

export default function PoSnakeGamePage() {
  const [gameKey, setGameKey] = useState(0);
  const [showModal, setShowModal] = useState(false);
  const [gameResult, setGameResult] = useState<{
    score: number;
    snakeLength: number;
    foodEaten: number;
    gameDuration: number;
  } | null>(null);
  const [scores, setScores] = useState<SnakeHighScore[]>([]);
  const [loadingScores, setLoadingScores] = useState(true);

  useEffect(() => {
    getHighScores().then(s => { setScores(s); setLoadingScores(false); });
  }, []);

  const refreshScores = useCallback(() => {
    getHighScores().then(setScores);
  }, []);

  const handleGameOver = useCallback((score: number, snakeLength: number, foodEaten: number, gameDuration: number) => {
    setGameResult({ score, snakeLength, foodEaten, gameDuration });
    setShowModal(true);
  }, []);

  const handlePlayAgain = useCallback(() => {
    setShowModal(false);
    setGameResult(null);
    setGameKey(k => k + 1);
  }, []);

  const handleScoreSubmitted = useCallback(() => {
    setShowModal(false);
    setGameResult(null);
    setGameKey(k => k + 1);
    refreshScores();
  }, [refreshScores]);

  return (
    <div className="psg-page">
      <div className="psg-page-header">
        <Link to="/" className="psg-home-btn" aria-label="Back to home">←</Link>
        <h1 className="psg-title">Battle Arena 🐍</h1>
        <button className="psg-new-game-btn" onClick={handlePlayAgain}>New Game</button>
      </div>

      <GameCanvas key={gameKey} onGameOver={handleGameOver} />

      <div className="psg-leaderboard">
        <h2 className="psg-leaderboard-title">🏆 Leaderboard</h2>
        {loadingScores ? (
          <div className="psg-loading">
            <span className="psg-spinner" />
            Loading scores…
          </div>
        ) : (
          <HighScoreTable scores={scores} />
        )}
      </div>

      {showModal && gameResult && (
        <HighScoreModal
          score={gameResult.score}
          snakeLength={gameResult.snakeLength}
          foodEaten={gameResult.foodEaten}
          gameDuration={gameResult.gameDuration}
          onClose={handlePlayAgain}
          onSubmitted={handleScoreSubmitted}
        />
      )}
    </div>
  );
}
