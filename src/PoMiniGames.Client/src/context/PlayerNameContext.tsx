import { createContext, useContext, useState, type ReactNode } from 'react';

interface PlayerNameContextType {
  playerName: string;
  setPlayerName: (name: string) => void;
}

const PlayerNameContext = createContext<PlayerNameContextType>({
  playerName: 'Player',
  setPlayerName: () => {},
});

export function PlayerNameProvider({ children }: { children: ReactNode }) {
  const [playerName, setPlayerNameState] = useState(
    () => localStorage.getItem('pomini_player') ?? 'Player'
  );

  const setPlayerName = (name: string) => {
    const trimmed = name.trim() || 'Player';
    setPlayerNameState(trimmed);
    localStorage.setItem('pomini_player', trimmed);
  };

  return (
    <PlayerNameContext.Provider value={{ playerName, setPlayerName }}>
      {children}
    </PlayerNameContext.Provider>
  );
}

export function usePlayerName() {
  return useContext(PlayerNameContext);
}
