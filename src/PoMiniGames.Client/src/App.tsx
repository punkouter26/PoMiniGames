import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AuthCallbackPage from './components/AuthCallbackPage';
import GameLayout from './components/GameLayout';
import Home from './components/Home';
import LobbyPage from './components/LobbyPage';
import SinglePlayerPage from './components/SinglePlayerPage';
import MultiplayerPage from './components/MultiplayerPage';
import DemoModePage from './components/DemoModePage';
import { AuthProvider } from './context/AuthContext';
import TicTacToePage from './games/tictactoe/TicTacToePage';
import ConnectFivePage from './games/connectfive/ConnectFivePage';
import VoxelShooterPage from './games/voxelshooter/VoxelShooterPage';
import PoFightPage from './games/pofight/PoFightPage';
import PoDropSquarePage from './games/podropsquare/PoDropSquarePage';
import PoBabyTouchPage from './games/pobabytouch/PoBabyTouchPage';
import PoRaceRagdollPage from './games/poraceragdoll/PoRaceRagdollPage';
import PoSnakeGamePage from './games/posnakegame/PoSnakeGamePage';
import { PlayerNameProvider } from './context/PlayerNameContext';

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
              <Route path="multiplayer" element={<MultiplayerPage />} />
              <Route path="single-player" element={<SinglePlayerPage />} />
              <Route path="demo" element={<DemoModePage />} />
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
