import { BrowserRouter, Routes, Route } from 'react-router-dom';
import GameLayout from './components/GameLayout';
import Home from './components/Home';
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
    <PlayerNameProvider>
      <BrowserRouter>
        <Routes>
          {/* All pages — compact nav */}
          <Route element={<GameLayout />}>
            <Route index element={<Home />} />
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
  );
}
