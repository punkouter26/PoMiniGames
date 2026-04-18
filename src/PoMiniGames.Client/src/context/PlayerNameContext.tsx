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

const STORAGE_KEY = 'pomini_player';
const ADJ = ['Swift', 'Bold', 'Brave', 'Cool', 'Fast', 'Wild', 'Sharp', 'Calm', 'Sly', 'Keen'];
const NOUN = ['Fox', 'Bear', 'Wolf', 'Hawk', 'Panda', 'Tiger', 'Lynx', 'Raven', 'Otter', 'Gecko'];

function generateRandomName(): string {
  const adj = ADJ[Math.floor(Math.random() * ADJ.length)]!;
  const noun = NOUN[Math.floor(Math.random() * NOUN.length)]!;
  const num = Math.floor(Math.random() * 99) + 1;
  return `${adj}${noun}${num}`;
}

function readInitialName(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)?.trim();
    if (saved) return saved;
  } catch {
    // Ignore storage read issues and fall back to a generated name.
  }

  const generated = generateRandomName();
  try {
    localStorage.setItem(STORAGE_KEY, generated);
  } catch {
    // Ignore storage write issues.
  }
  return generated;
}

function persistName(name: string) {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Ignore storage write issues.
  }
}

export function PlayerNameProvider({ children }: { children: ReactNode }) {
  const [playerName, setPlayerNameState] = useState(readInitialName);

  const setPlayerName = useCallback((name: string) => {
    const trimmed = name.trim() || 'Player';
    setPlayerNameState(trimmed);
    persistName(trimmed);
  }, []);

  const setPlayerNameFromAuth = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setPlayerNameState(trimmed);
    persistName(trimmed);
  }, []);

  return (
    <PlayerNameContext.Provider value={{ playerName, setPlayerName, setPlayerNameFromAuth }}>
      {children}
    </PlayerNameContext.Provider>
  );
}

export function usePlayerName() {
  return useContext(PlayerNameContext);
}
