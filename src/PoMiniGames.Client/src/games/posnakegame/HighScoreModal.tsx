import { useState, useCallback, useEffect, useMemo } from 'react';
import { submitHighScore, getHighScores, type SnakeHighScore } from './api';

interface HighScoreModalProps {
  score: number;
  snakeLength: number;
  foodEaten: number;
  onClose: () => void;
  onSubmitted: () => void;
}

function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 24 }, (_, i) => ({
        id: i,
        left: `${Math.random() * 100}%`,
        delay: Math.random() * 0.6,
        color: ['#00FF00', '#00FFFF', '#FFFF00', '#FFA500', '#FF6B6B', '#800080'][i % 6],
        size: 6 + Math.random() * 6,
      })),
    [],
  );

  return (
    <div className="psg-confetti-wrap">
      {pieces.map(p => (
        <span
          key={p.id}
          className="psg-confetti-piece"
          style={{
            left: p.left,
            width: p.size,
            height: p.size,
            backgroundColor: p.color,
            animationDelay: `${p.delay}s`,
          }}
        />
      ))}
    </div>
  );
}

export function HighScoreModal({
  score,
  snakeLength,
  foodEaten,
  onClose,
  onSubmitted,
}: HighScoreModalProps) {
  const [initials, setInitials] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rank, setRank] = useState<number | null>(null);

  useEffect(() => {
    getHighScores().then(scores => {
      const pos = scores.filter((s: SnakeHighScore) => s.score > score).length + 1;
      setRank(pos);
    });
  }, [score]);

  const isHighScore = rank !== null && rank <= 10;
  const showConfetti = rank !== null && rank <= 3;

  const handleSubmit = useCallback(async () => {
    if (initials.length === 0) { setError('Please enter your initials'); return; }
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await submitHighScore({ initials, score, gameDuration: 30, snakeLength, foodEaten });
      if (result) onSubmitted();
      else setError('Failed to submit. Please try again.');
    } catch {
      setError('An error occurred. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [initials, score, snakeLength, foodEaten, onSubmitted]);

  return (
    <div className="psg-modal-backdrop">
      <div className="psg-modal">
        {showConfetti && <Confetti />}

        <h2 className="psg-modal-title">Game Over!</h2>

        {rank !== null && (
          <p className="psg-modal-rank">
            {isHighScore ? (
              <span className="psg-modal-rank-badge">🏆 #{rank} on the Leaderboard!</span>
            ) : (
              <span className="psg-modal-rank-plain">Rank #{rank}</span>
            )}
          </p>
        )}

        <div className="psg-stats-grid">
          <div className="psg-stat-box">
            <span className="psg-stat-label">Score</span>
            <span className="psg-stat-value psg-stat-green">{score}</span>
          </div>
          <div className="psg-stat-box">
            <span className="psg-stat-label">Length</span>
            <span className="psg-stat-value psg-stat-cyan">{snakeLength}</span>
          </div>
          <div className="psg-stat-box">
            <span className="psg-stat-label">Food</span>
            <span className="psg-stat-value psg-stat-orange">{foodEaten}</span>
          </div>
        </div>

        <label className="psg-modal-label" htmlFor="psg-initials">Enter your initials:</label>
        <input
          id="psg-initials"
          className="psg-initials-input"
          type="text"
          maxLength={3}
          value={initials}
          onChange={e => setInitials(e.target.value.toUpperCase())}
          placeholder="AAA"
          autoFocus
        />

        {error && <div className="psg-modal-error">{error}</div>}

        <div className="psg-modal-buttons">
          <button className="psg-btn-secondary" onClick={onClose}>Play Again</button>
          <button
            className="psg-btn-primary"
            onClick={handleSubmit}
            disabled={isSubmitting || initials.length === 0}
          >
            {isSubmitting ? 'Saving…' : 'Submit Score'}
          </button>
        </div>
      </div>
    </div>
  );
}
