import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PlayerNameProvider, usePlayerName } from '../../context/PlayerNameContext';

function wrapper({ children }: { children: ReactNode }) {
  return <PlayerNameProvider>{children}</PlayerNameProvider>;
}

describe('PlayerNameContext – initial value', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to "Player" when localStorage has no entry', () => {
    const { result } = renderHook(() => usePlayerName(), { wrapper });
    expect(result.current.playerName).toBe('Player');
  });

  it('loads the saved value from localStorage on first render', () => {
    localStorage.setItem('pomini_player', 'Gamer42');
    const { result } = renderHook(() => usePlayerName(), { wrapper });
    expect(result.current.playerName).toBe('Gamer42');
  });
});

describe('PlayerNameContext – setPlayerName', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('updates the state value', () => {
    const { result } = renderHook(() => usePlayerName(), { wrapper });
    act(() => result.current.setPlayerName('Alice'));
    expect(result.current.playerName).toBe('Alice');
  });

  it('persists the new name to localStorage', () => {
    const { result } = renderHook(() => usePlayerName(), { wrapper });
    act(() => result.current.setPlayerName('Saved'));
    expect(localStorage.getItem('pomini_player')).toBe('Saved');
  });

  it('trims surrounding whitespace', () => {
    const { result } = renderHook(() => usePlayerName(), { wrapper });
    act(() => result.current.setPlayerName('  trimmed  '));
    expect(result.current.playerName).toBe('trimmed');
  });

  it('falls back to "Player" for an empty string', () => {
    const { result } = renderHook(() => usePlayerName(), { wrapper });
    act(() => result.current.setPlayerName('Alice'));
    act(() => result.current.setPlayerName(''));
    expect(result.current.playerName).toBe('Player');
  });

  it('falls back to "Player" for a whitespace-only string', () => {
    const { result } = renderHook(() => usePlayerName(), { wrapper });
    act(() => result.current.setPlayerName('Alice'));
    act(() => result.current.setPlayerName('   '));
    expect(result.current.playerName).toBe('Player');
  });

  it('stores "Player" in localStorage when input is empty', () => {
    const { result } = renderHook(() => usePlayerName(), { wrapper });
    act(() => result.current.setPlayerName(''));
    expect(localStorage.getItem('pomini_player')).toBe('Player');
  });
});
