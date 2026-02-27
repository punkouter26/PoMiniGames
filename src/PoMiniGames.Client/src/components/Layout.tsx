import { NavLink, Outlet } from 'react-router-dom';
import { Gamepad2 } from 'lucide-react';
import './Layout.css';

export default function Layout() {
  return (
    <div className="page">
      <header className="top-bar">
        <NavLink to="/" className="brand">
          <span className="brand-icon">
            <Gamepad2 size={20} />
          </span>
          PoMiniGames
        </NavLink>
        <nav>
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/connectfive">Connect 5</NavLink>
          <NavLink to="/tictactoe">Tic Tac Toe</NavLink>
          <NavLink to="/voxelshooter">Voxel Shooter</NavLink>
          <NavLink to="/pofight">PoFight</NavLink>
          <NavLink to="/podropsquare">PoDropSquare</NavLink>
          <NavLink to="/pobabytouch">PoBabyTouch</NavLink>
          <NavLink to="/poraceragdoll">PoRaceRagdoll</NavLink>
        </nav>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
