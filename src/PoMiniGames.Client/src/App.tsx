import { lazy, useEffect } from 'react';
import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import AuthCallbackPage from './components/AuthCallbackPage';
import GameLayout from './components/GameLayout';
import Home from './components/Home';
import LobbyPage from './components/LobbyPage';
import SinglePlayerPage from './components/SinglePlayerPage';
import { AuthProvider, useAuth } from './context/AuthContext';
import { PlayerNameProvider, usePlayerName } from './context/PlayerNameContext';

// Code-split each game so users only download the chunk(s) they actually play.
// Heavy vendors (three, rapier, cannon-es) are further separated via manualChunks in vite.config.ts.
const TicTacToePage = lazy(() => import('./games/tictactoe/TicTacToePage'));
const ConnectFivePage = lazy(() => import('./games/connectfive/ConnectFivePage'));
const VoxelShooterPage = lazy(() => import('./games/voxelshooter/VoxelShooterPage'));
const PoFightPage = lazy(() => import('./games/pofight/PoFightPage'));
const PoDropSquarePage = lazy(() => import('./games/podropsquare/PoDropSquarePage'));
const PoBabyTouchPage = lazy(() => import('./games/pobabytouch/PoBabyTouchPage'));
const PoRaceRagdollPage = lazy(() => import('./games/poraceragdoll/PoRaceRagdollPage'));
const PoSnakeGamePage = lazy(() => import('./games/posnakegame/PoSnakeGamePage'));

/** Sync Microsoft OAuth display name / email into the player name slot. */
function AuthNameSync() {
  const { user } = useAuth();
  const { setPlayerName } = usePlayerName();
  useEffect(() => {
    if (user?.email || user?.displayName) {
      setPlayerName(user.email ?? user.displayName);
    }
  }, [user, setPlayerName]);
  return null;
}

export default function App() {
  return (
    <AuthProvider>
      <PlayerNameProvider>
        <BrowserRouter>
          <AuthNameSync />
          <Routes>
            {/* All pages — compact nav */}
            <Route element={<GameLayout />}>
              <Route index element={<Home />} />
              <Route path="auth/callback" element={<AuthCallbackPage />} />
              <Route path="lobby" element={<LobbyPage />} />
              {/* /multiplayer consolidated into /lobby */}
              <Route path="multiplayer" element={<Navigate to="/lobby" replace />} />
              <Route path="single-player" element={<SinglePlayerPage />} />
              <Route path="tictactoe" element={<TicTacToePage />} />
                <Route path="connectfive" element={<ConnectFivePage />} />
                <Route path="voxelshooter" element={<VoxelShooterPage />} />
                <Route path="pofight" element={<PoFightPage />} />
                <Route path="podropsquare" element={<PoDropSquarePage />} />
                <Route path="pobabytouch" element={<PoBabyTouchPage />} />
                <Route path="poraceragdoll" element={<PoRaceRagdollPage />} />
                <Route path="posnakegame" element={<PoSnakeGamePage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </PlayerNameProvider>
    </AuthProvider>
  );
}
