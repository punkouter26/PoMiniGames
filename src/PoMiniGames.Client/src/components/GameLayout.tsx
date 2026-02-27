import { useState, useCallback } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Gamepad2, Menu, X } from 'lucide-react';
import './GameLayout.css';

const NAV_LINKS = [
  { to: '/', label: 'Home', end: true },
  { to: '/connectfive', label: 'Connect 5' },
  { to: '/tictactoe', label: 'Tic Tac Toe' },
  { to: '/voxelshooter', label: 'Voxel Shooter' },
  { to: '/pofight', label: 'PoFight' },
  { to: '/podropsquare', label: 'PoDropSquare' },
  { to: '/pobabytouch', label: 'PoBabyTouch' },
  { to: '/poraceragdoll', label: 'PoRaceRagdoll' },
];

export default function GameLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  return (
    <div className="gl-page">
      <header className="gl-top-bar">
        <NavLink to="/" className="gl-brand" onClick={closeMenu}>
          <span className="gl-brand-icon">
            <Gamepad2 size={16} />
          </span>
          <span className="gl-brand-text">PoMiniGames</span>
        </NavLink>

        {/* Desktop nav — hidden on mobile */}
        <nav className="gl-nav-desktop">
          {NAV_LINKS.map(({ to, label, end }) => (
            <NavLink key={to} to={to} end={end ?? false}>
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Mobile hamburger */}
        <button
          className="gl-hamburger"
          onClick={() => setMenuOpen(o => !o)}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
        >
          {menuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </header>

      {/* Mobile slide-down drawer */}
      {menuOpen && (
        <div className="gl-drawer-backdrop" onClick={closeMenu}>
          <nav className="gl-drawer" onClick={e => e.stopPropagation()}>
            {NAV_LINKS.map(({ to, label, end }) => (
              <NavLink key={to} to={to} end={end ?? false} onClick={closeMenu}>
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      )}

      <main className="gl-content">
        <Outlet />
      </main>
    </div>
  );
}
