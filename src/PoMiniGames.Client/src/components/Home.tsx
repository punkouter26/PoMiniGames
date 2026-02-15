import { Link } from 'react-router-dom';
import { CircleDot, Grid3X3, ArrowRight, Gamepad2 } from 'lucide-react';
import './Home.css';

export default function Home() {
  return (
    <div className="home-container">
      <h1 className="home-title">
        <span className="home-title-icon">
          <Gamepad2 size={48} strokeWidth={1.5} />
        </span>
        PoMiniGames
      </h1>
      <p className="home-subtitle">Choose a game to play</p>

      <div className="game-cards">
        <Link to="/connectfive" className="game-card" aria-label="Play Connect Five">
          <div className="game-icon">
            <CircleDot size={48} color="#f44336" />
            <CircleDot size={48} color="#ffeb3b" />
          </div>
          <h2>Connect Five</h2>
          <p>Drop pieces on a 9×9 board. Get 5 in a row to win!</p>
          <span className="play-btn">
            Play <ArrowRight size={18} className="play-btn-icon" />
          </span>
        </Link>

        <Link to="/tictactoe" className="game-card" aria-label="Play Tic Tac Toe">
          <div className="game-icon">
            <CircleDot size={44} stroke="none" fill="#ff5252" />
            <CircleDot size={44} stroke="none" fill="#ffc107" />
          </div>
          <h2>Tic Tac Toe</h2>
          <p>Classic game on a 6×6 board. Get 4 in a row to win!</p>
          <span className="play-btn">
            Play <ArrowRight size={18} className="play-btn-icon" />
          </span>
        </Link>
      </div>
    </div>
  );
}
