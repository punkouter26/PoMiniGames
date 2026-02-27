import type { SnakeHighScore } from './api';

interface HighScoreTableProps {
  scores: SnakeHighScore[];
}

export function HighScoreTable({ scores }: HighScoreTableProps) {
  if (scores.length === 0) {
    return (
      <div className="psg-empty-state">
        <span className="psg-empty-icon">🐍</span>
        <p style={{ fontSize: '1.125rem', fontWeight: 500 }}>No high scores yet</p>
        <p style={{ fontSize: '0.875rem', color: '#64748b' }}>
          Play a round to claim the top spot!
        </p>
      </div>
    );
  }

  return (
    <div className="psg-table-wrap">
      <table className="psg-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Score</th>
            <th className="psg-col-md">Length</th>
            <th className="psg-col-md">Food</th>
            <th className="psg-col-lg">Date</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((s, i) => {
            const rowClass =
              i === 0 ? 'psg-row-gold' :
              i === 1 ? 'psg-row-silver' :
              i === 2 ? 'psg-row-bronze' : '';
            return (
              <tr key={`${s.initials}-${s.score}-${i}`} className={rowClass}>
                <td className="psg-col-rank">
                  {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                </td>
                <td className={i < 3 ? 'psg-col-initials' : 'psg-col-initials-small'}>
                  {s.initials}
                </td>
                <td className={i < 3 ? 'psg-col-score-big' : 'psg-col-score'}>
                  {s.score.toLocaleString()}
                </td>
                <td className="psg-col-muted psg-col-md">{s.snakeLength}</td>
                <td className="psg-col-muted psg-col-md">{s.foodEaten}</td>
                <td className="psg-col-date psg-col-lg">
                  {new Date(s.date).toLocaleDateString()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
