import { createContext, useContext, useState, type ReactNode } from 'react';

interface PlayerNameContextType {
  playerName: string;
  setPlayerName: (name: string) => void;
}

const PlayerNameContext = createContext<PlayerNameContextType>({
  playerName: 'Player',
  setPlayerName: () => {},
});

const ADJ = ['Swift', 'Bold', 'Brave', 'Cool', 'Fast', 'Wild', 'Sharp', 'Calm', 'Sly', 'Keen'];
const NOUN = ['Fox', 'Bear', 'Wolf', 'Hawk', 'Panda', 'Tiger', 'Lynx', 'Raven', 'Otter', 'Gecko'];
function generateRandomName(): string {
  const adj = ADJ[Math.floor(Math.random() * ADJ.length)]!;
  const noun = NOUN[Math.floor(Math.random() * NOUN.length)]!;
  const num = Math.floor(Math.random() * 99) + 1;
  return `${adj}${noun}${num}`;
}

export function PlayerNameProvider({ children }: { children: ReactNode }) {
  const [playerName, setPlayerNameState] = useState(() => {
    const stored = localStorage.getItem('pomini_player');
    if (stored && stored !== 'Player') return stored;
    const name = generateRandomName();
    localStorage.setItem('pomini_player', name);
    return name;
  });

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
