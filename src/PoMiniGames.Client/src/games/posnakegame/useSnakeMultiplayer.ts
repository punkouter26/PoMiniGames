import {
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
  type HubConnection,
} from '@microsoft/signalr';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getStoredAccessToken } from '../../context/authStorage';
import { apiService } from '../shared/apiService';
import type { MultiplayerMatchSnapshot } from '../shared/multiplayerTypes';
import {
  type Direction,
  type GameState,
  getOppositeDirection,
  initializeTwoPlayerGame,
  updateGame,
} from './snakeGameEngine';

export interface SnakeMultiplayerWinner {
  userId: string;
  displayName: string;
  score: number;
  draw: boolean;
}

const STATUS_RANK: Record<string, number> = {
  WaitingForOpponent: 0,
  InProgress: 1,
  Completed: 2,
  Abandoned: 2,
};

function mergeSnapshot(
  prev: MultiplayerMatchSnapshot | null,
  next: MultiplayerMatchSnapshot,
): MultiplayerMatchSnapshot {
  if (
    prev !== null &&
    prev.matchId === next.matchId &&
    (STATUS_RANK[prev.status] ?? 0) > (STATUS_RANK[next.status] ?? 0)
  ) {
    return prev;
  }
  return next;
}

export interface UseSnakeMultiplayerResult {
  match: MultiplayerMatchSnapshot | null;
  isHost: boolean;
  gameState: GameState | null;
  myPlayerId: string;
  opponentName: string;
  winner: SnakeMultiplayerWinner | null;
  isConnected: boolean;
  isBusy: boolean;
  error: string | null;
  joinQueue: () => Promise<void>;
  leaveMatch: () => Promise<void>;
  sendDirection: (dir: Direction) => void;
}

export function useSnakeMultiplayer(): UseSnakeMultiplayerResult {
  const { isAuthenticated, isConfigured, user } = useAuth();
  const connectionRef = useRef<HubConnection | null>(null);

  const [match, setMatch] = useState<MultiplayerMatchSnapshot | null>(null);
  const matchRef = useRef(match);
  matchRef.current = match;

  const [isHost, setIsHost] = useState(false);
  const isHostRef = useRef(false);
  isHostRef.current = isHost;

  const [gameState, setGameState] = useState<GameState | null>(null);
  const gameStateRef = useRef<GameState | null>(null);

  const [winner, setWinner] = useState<SnakeMultiplayerWinner | null>(null);

  const [isConnected, setIsConnected] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track whether we've already started the game loop for the current match
  const gameStartedRef = useRef(false);
  const animFrameRef = useRef<number>(0);
  const lastUpdateRef = useRef<number>(0);
  const opponentIdRef = useRef<string>('');

  // ── Host game loop ─────────────────────────────────────────────────────
  const hostGameLoop = useCallback((timestamp: number) => {
    const state = gameStateRef.current;
    if (!state) return;

    const elapsed = timestamp - lastUpdateRef.current;
    if (elapsed >= 100) {
      lastUpdateRef.current = timestamp;
      let next = state;

      if (next.countdown !== null && next.countdown > 0) {
        next = { ...next, countdown: next.countdown - 1 };
        if (next.countdown === 0) next = { ...next, isRunning: true, countdown: null };
      } else if (next.isRunning && !next.isGameOver) {
        next = updateGame(next);
        next = { ...next, timeRemaining: next.timeRemaining - 0.1 };
        if (next.timeRemaining <= 0) next = { ...next, isGameOver: true };
      }

      gameStateRef.current = next;
      setGameState({ ...next });

      // Broadcast full state to guest + spectators each tick
      const conn = connectionRef.current;
      const matchId = matchRef.current?.matchId;
      if (conn?.state === HubConnectionState.Connected && matchId) {
        void conn.invoke('SendRealtimeInput', matchId, { type: 'state', state: next });
      }

      if (next.isGameOver) {
        resolveWinner(next);
        return;
      }
    }

    animFrameRef.current = requestAnimationFrame(hostGameLoop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function resolveWinner(state: GameState) {
    const players = state.snakes.filter(s => s.isPlayer);
    const p1 = players[0];
    const p2 = players[1];
    const match = matchRef.current;

    if (!p1 || !p2 || !match) return;

    const p1Alive = p1.isAlive;
    const p2Alive = p2.isAlive;
    const draw = p1Alive === p2Alive; // both dead at same tick = draw

    const winnerId = draw ? '' : (p1Alive ? p1.playerId! : p2.playerId!);
    const winnerName = draw
      ? 'Draw'
      : (p1Alive
        ? (match.participants.find(p => p.userId === p1.playerId)?.displayName ?? 'Player 1')
        : (match.participants.find(p => p.userId === p2.playerId)?.displayName ?? 'Player 2'));
    const winnerScore = draw ? 0 : (p1Alive ? p1.score : p2.score);

    setWinner({ userId: winnerId, displayName: winnerName, score: winnerScore, draw });
  }

  // ── SignalR connection lifecycle ───────────────────────────────────────
  useEffect(() => {
    let disposed = false;

    async function ensureConnection() {
      if (!isConfigured || !isAuthenticated) {
        setIsConnected(false);
        if (connectionRef.current) {
          await connectionRef.current.stop();
          connectionRef.current = null;
        }
        return;
      }

      if (connectionRef.current?.state === HubConnectionState.Connected) return;

      const connection = new HubConnectionBuilder()
        .withUrl('/api/hubs/multiplayer', {
          accessTokenFactory: async () => getStoredAccessToken() ?? '',
        })
        .withAutomaticReconnect()
        .configureLogging(LogLevel.Warning)
        .build();

      // ── MatchUpdated: track match status ─────────────────────────────
      connection.on('MatchUpdated', (snapshot: MultiplayerMatchSnapshot) => {
        if (disposed || snapshot.gameKey !== 'posnakegame') return;
        if (!snapshot.participants.some(p => p.userId === user?.userId)) return;

        setMatch(prev => mergeSnapshot(prev, snapshot));

        // Start game loop when match goes InProgress (once per match)
        if (snapshot.status === 'InProgress' && !gameStartedRef.current) {
          gameStartedRef.current = true;

          const myId = user?.userId ?? '';
          const host = snapshot.participants[0]?.userId === myId;
          setIsHost(host);
          isHostRef.current = host;

          const opponent = snapshot.participants.find(p => p.userId !== myId);
          opponentIdRef.current = opponent?.userId ?? '';

          if (host) {
            // Host initialises the game state then starts the loop
            const p2Id = opponent?.userId ?? '';
            const initialState = initializeTwoPlayerGame(myId, p2Id);
            gameStateRef.current = initialState;
            setGameState({ ...initialState });
            lastUpdateRef.current = performance.now();
            animFrameRef.current = requestAnimationFrame(hostGameLoop);
          }
        }
      });

      // ── RealtimeInput: relay messages ────────────────────────────────
      connection.on('RealtimeInput', (envelope: {
        matchId: string;
        fromUserId: string;
        payload: { type: string; dir?: Direction; state?: GameState };
      }) => {
        if (disposed) return;

        const { payload } = envelope;

        if (isHostRef.current) {
          // Host receives direction input from guest
          if (payload.type === 'input' && payload.dir) {
            const state = gameStateRef.current;
            if (!state) return;
            const opId = opponentIdRef.current;
            const p2 = state.snakes.find(s => s.isPlayer && s.playerId === opId);
            if (p2?.isAlive) {
              const newDir = payload.dir;
              if (newDir !== getOppositeDirection(p2.direction)) {
                gameStateRef.current = {
                  ...state,
                  snakes: state.snakes.map(s =>
                    (s.isPlayer && s.playerId === opId) ? { ...s, direction: newDir } : s,
                  ),
                };
              }
            }
          }
        } else {
          // Guest receives full game state from host
          if (payload.type === 'state' && payload.state) {
            gameStateRef.current = payload.state;
            setGameState({ ...payload.state });

            if (payload.state.isGameOver && !winner) {
              resolveWinner(payload.state);
            }
          }
        }
      });

      connection.onclose(() => { if (!disposed) setIsConnected(false); });

      connection.onreconnected(async () => {
        if (disposed) return;
        setIsConnected(true);
        const mid = matchRef.current?.matchId;
        if (mid) {
          const latest = await apiService.getMultiplayerMatch(mid);
          if (latest && !disposed) setMatch(latest);
        }
      });

      await connection.start();
      if (disposed) { await connection.stop(); return; }

      connectionRef.current = connection;
      setIsConnected(true);
    }

    void ensureConnection();

    return () => {
      disposed = true;
      cancelAnimationFrame(animFrameRef.current);
      const conn = connectionRef.current;
      connectionRef.current = null;
      if (conn) void conn.stop();
    };
  }, [isAuthenticated, isConfigured, user?.userId, hostGameLoop]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Public actions ─────────────────────────────────────────────────────
  const joinQueue = async () => {
    setError(null);
    setIsBusy(true);
    gameStartedRef.current = false;
    setWinner(null);
    setGameState(null);
    gameStateRef.current = null;
    try {
      const snapshot = await apiService.joinMultiplayerQueue('posnakegame');
      if (!snapshot) { setError('Unable to join matchmaking right now.'); return; }
      setMatch(prev => mergeSnapshot(prev, snapshot));
    } finally {
      setIsBusy(false);
    }
  };

  const leaveMatch = async () => {
    cancelAnimationFrame(animFrameRef.current);
    gameStartedRef.current = false;
    const currentMatch = matchRef.current;
    if (!currentMatch) return;
    setError(null);
    setIsBusy(true);
    try {
      await apiService.leaveMultiplayerMatch(currentMatch.matchId);
      setMatch(null);
      setGameState(null);
      gameStateRef.current = null;
      setWinner(null);
    } finally {
      setIsBusy(false);
    }
  };

  const sendDirection = useCallback((dir: Direction) => {
    const conn = connectionRef.current;
    const matchId = matchRef.current?.matchId;
    if (!conn || !matchId || conn.state !== HubConnectionState.Connected) return;
    void conn.invoke('SendRealtimeInput', matchId, { type: 'input', dir });
  }, []);

  const myPlayerId = user?.userId ?? '';
  const opponentName = match?.participants.find(p => p.userId !== myPlayerId)?.displayName ?? 'Opponent';

  return {
    match,
    isHost,
    gameState,
    myPlayerId,
    opponentName,
    winner,
    isConnected,
    isBusy,
    error,
    joinQueue,
    leaveMatch,
    sendDirection,
  };
}
