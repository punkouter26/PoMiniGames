import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface PlayerNameContextType {
  playerName: string;
  setPlayerName: (name: string) => void;
  setPlayerNameFromAuth: (name: string) => void;
}

const PlayerNameContext = createContext<PlayerNameContextType>({
  playerName: 'Player',
  setPlayerName: () => {},
  setPlayerNameFromAuth: () => {},
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
  // Fresh random name every session — no persistence per design (casual/anon play)
  const [playerName, setPlayerNameState] = useState(() => generateRandomName());

  const setPlayerName = useCallback((name: string) => {
    const trimmed = name.trim() || 'Player';
    setPlayerNameState(trimmed);
  }, []);

  // No-op kept for API compatibility — auth name sync removed
  const setPlayerNameFromAuth = useCallback((_name: string) => {}, []);

  return (
    <PlayerNameContext.Provider value={{ playerName, setPlayerName, setPlayerNameFromAuth }}>
      {children}
    </PlayerNameContext.Provider>
  );
}

export function usePlayerName() {
  return useContext(PlayerNameContext);
}
