import { Link } from 'react-router-dom';
import { CircleDot, ArrowRight, Gamepad2, Crosshair, User, Swords, Square, Baby, Car } from 'lucide-react';
import { usePlayerName } from '../context/PlayerNameContext';
import HomeHighScores from './HomeHighScores';
import './Home.css';

export default function Home() {
  const { playerName, setPlayerName } = usePlayerName();

  return (
    <div className="home-container">
      <h1 className="home-title">
        <span className="home-title-icon">
          <Gamepad2 size={48} strokeWidth={1.5} />
        </span>
        PoMiniGames
      </h1>
      <p className="home-subtitle">Choose a game to play</p>

      <div className="home-player-row">
        <label className="home-player-label" htmlFor="home-player-name">
          <User size={16} />
          Player Name
        </label>
        <input
          id="home-player-name"
          className="home-player-input"
          value={playerName}
          onChange={(e) => setPlayerName(e.target.value)}
          placeholder="Enter your name"
          aria-label="Player name"
        />
      </div>

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

        <Link to="/voxelshooter" className="game-card" aria-label="Play Voxel Shooter">
          <div className="game-icon">
            <Crosshair size={48} color="#00D9FF" />
          </div>
          <h2>Voxel Shooter</h2>
          <p>Shoot voxel enemies. Survive 100 seconds to win!</p>
          <span className="play-btn">
            Play <ArrowRight size={18} className="play-btn-icon" />
          </span>
        </Link>
        <Link to="/pofight" className="game-card" aria-label="Play PoFight">
          <div className="game-icon">
            <Swords size={48} color="#00D9FF" />
          </div>
          <h2>PoFight</h2>
          <p>Battle in PoFight and keep your stats synced with PoMiniGames.</p>
          <span className="play-btn">
            Play <ArrowRight size={18} className="play-btn-icon" />
          </span>
        </Link>

        <Link to="/podropsquare" className="game-card" aria-label="Play PoDropSquare">
          <div className="game-icon">
            <Square size={48} color="#00D9FF" />
          </div>
          <h2>PoDropSquare</h2>
          <p>Launch PoDropSquare from the hub and track your outcomes here.</p>
          <span className="play-btn">
            Play <ArrowRight size={18} className="play-btn-icon" />
          </span>
        </Link>

        <Link to="/pobabytouch" className="game-card" aria-label="Play PoBabyTouch">
          <div className="game-icon">
            <Baby size={48} color="#00D9FF" />
          </div>
          <h2>PoBabyTouch</h2>
          <p>Open PoBabyTouch in the unified hub and record your game results.</p>
          <span className="play-btn">
            Play <ArrowRight size={18} className="play-btn-icon" />
          </span>
        </Link>

        <Link to="/poraceragdoll" className="game-card" aria-label="Play PoRaceRagdoll">
          <div className="game-icon">
            <Car size={48} color="#00D9FF" />
          </div>
          <h2>PoRaceRagdoll</h2>
          <p>Race with ragdoll physics and keep shared stats in PoMiniGames.</p>
          <span className="play-btn">
            Play <ArrowRight size={18} className="play-btn-icon" />
          </span>
        </Link>
      </div>

      <HomeHighScores />
    </div>
  );
}


