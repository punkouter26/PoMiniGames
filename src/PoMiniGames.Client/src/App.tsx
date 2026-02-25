import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './components/Home';
import TicTacToePage from './games/tictactoe/TicTacToePage';
import ConnectFivePage from './games/connectfive/ConnectFivePage';
import VoxelShooterPage from './games/voxelshooter/VoxelShooterPage';
import { PlayerNameProvider } from './context/PlayerNameContext';

export default function App() {
  return (
    <PlayerNameProvider>
    <BrowserRouter>
      <Routes>
        <Route path="voxelshooter" element={<VoxelShooterPage />} />
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="tictactoe" element={<TicTacToePage />} />
          <Route path="connectfive" element={<ConnectFivePage />} />
        </Route>
      </Routes>
    </BrowserRouter>
    </PlayerNameProvider>
  );
}
