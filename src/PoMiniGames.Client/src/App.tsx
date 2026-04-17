import { lazy } from 'react';
import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import AuthCallbackPage from './components/AuthCallbackPage';
import DiagPage from './components/DiagPage';
import { GameErrorBoundary } from './components/GameErrorBoundary';
import GameLayout from './components/GameLayout';
import Home from './components/Home';
import LobbyPage from './components/LobbyPage';
import MultiPlayerSelectPage from './components/MultiPlayerSelectPage';
import SinglePlayerPage from './components/SinglePlayerPage';
import { AuthProvider } from './context/AuthContext';
import { PlayerNameProvider } from './context/PlayerNameContext';

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

export default function App() {
  return (
    <AuthProvider>
      <PlayerNameProvider>
        <BrowserRouter>
          <Routes>
            {/* All pages — compact nav */}
            <Route element={<GameLayout />}>
              <Route index element={<Home />} />
              <Route path="auth/callback" element={<AuthCallbackPage />} />
              <Route path="lobby" element={<LobbyPage />} />
              <Route path="multi-player-select" element={<MultiPlayerSelectPage />} />
              <Route path="single-player" element={<SinglePlayerPage />} />
              {/* Legacy routes now redirect into the simplified flow. */}
              <Route path="leaderboard" element={<Navigate to="/" replace />} />
              <Route path="multi-player" element={<Navigate to="/multi-player-select" replace />} />
              <Route path="demo-select" element={<Navigate to="/single-player?mode=demo" replace />} />
              <Route path="multiplayer" element={<Navigate to="/multi-player-select" replace />} />
              <Route path="tictactoe" element={<GameErrorBoundary gameName="Tic Tac Toe"><TicTacToePage /></GameErrorBoundary>} />
                <Route path="connectfive" element={<GameErrorBoundary gameName="Connect Five"><ConnectFivePage /></GameErrorBoundary>} />
                <Route path="voxelshooter" element={<GameErrorBoundary gameName="Voxel Shooter"><VoxelShooterPage /></GameErrorBoundary>} />
                <Route path="pofight" element={<GameErrorBoundary gameName="PoFight"><PoFightPage /></GameErrorBoundary>} />
                <Route path="podropsquare" element={<GameErrorBoundary gameName="PoDropSquare"><PoDropSquarePage /></GameErrorBoundary>} />
                <Route path="pobabytouch" element={<GameErrorBoundary gameName="PoBabyTouch"><PoBabyTouchPage /></GameErrorBoundary>} />
                <Route path="poraceragdoll" element={<GameErrorBoundary gameName="PoRaceRagdoll"><PoRaceRagdollPage /></GameErrorBoundary>} />
                <Route path="posnakegame" element={<GameErrorBoundary gameName="PoSnakeGame"><PoSnakeGamePage /></GameErrorBoundary>} />
                <Route path="diag" element={<DiagPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </PlayerNameProvider>
    </AuthProvider>
  );
}
