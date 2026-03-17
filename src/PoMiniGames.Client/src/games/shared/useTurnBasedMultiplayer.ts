import {
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
  type HubConnection,
} from '@microsoft/signalr';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getStoredAccessToken } from '../../context/authStorage';
import { apiService } from './apiService';
import type { MultiplayerMatchSnapshot } from './multiplayerTypes';

/**
 * Match statuses ranked by progression.  A snapshot for the same matchId should
 * never downgrade to a lower rank (e.g. InProgress → WaitingForOpponent), which
 * can happen when the SignalR MatchUpdated event beats the joinQueue HTTP response.
 */
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
    // Keep the higher-ranked snapshot; ignore stale downgrade.
    return prev;
  }
  return next;
}

interface UseTurnBasedMultiplayerResult {
  match: MultiplayerMatchSnapshot | null;
  isBusy: boolean;
  isConnected: boolean;
  error: string | null;
  joinQueue: () => Promise<void>;
  leaveMatch: () => Promise<void>;
  submitTurn: (action: Record<string, number>) => Promise<void>;
}

export function useTurnBasedMultiplayer(gameKey: string): UseTurnBasedMultiplayerResult {
  const { isAuthenticated, isConfigured, user } = useAuth();
  const connectionRef = useRef<HubConnection | null>(null);
  const [match, setMatch] = useState<MultiplayerMatchSnapshot | null>(null);
  const matchRef = useRef(match);
  matchRef.current = match;
  const [isBusy, setIsBusy] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      if (connectionRef.current?.state === HubConnectionState.Connected) {
        return;
      }

      const connection = new HubConnectionBuilder()
        .withUrl('/api/hubs/multiplayer', {
          accessTokenFactory: async () => getStoredAccessToken() ?? '',
        })
        .withAutomaticReconnect()
        .configureLogging(LogLevel.Warning)
        .build();

      connection.on('MatchUpdated', (snapshot: MultiplayerMatchSnapshot) => {
        if (disposed || snapshot.gameKey !== gameKey) {
          return;
        }

        if (snapshot.participants.some(participant => participant.userId === user?.userId)) {
          console.log('[MU] MatchUpdated:', snapshot.status, 'currentTurn:', snapshot.currentTurnUserId, 'user:', user?.userId);
          setMatch(prev => mergeSnapshot(prev, snapshot));
        }
      });

      connection.onclose(() => {
        if (!disposed) {
          setIsConnected(false);
        }
      });

      connection.onreconnected(async () => {
        if (disposed) return;
        setIsConnected(true);
        const currentMatchId = matchRef.current?.matchId;
        if (currentMatchId) {
          const latest = await apiService.getMultiplayerMatch(currentMatchId);
          if (latest && !disposed) {
            setMatch(latest);
          }
        }
      });

      await connection.start();
      if (disposed) {
        await connection.stop();
        return;
      }

      connectionRef.current = connection;
      setIsConnected(true);
    }

    void ensureConnection();

    return () => {
      disposed = true;
      const connection = connectionRef.current;
      connectionRef.current = null;
      if (connection) {
        void connection.stop();
      }
    };
  }, [gameKey, isAuthenticated, isConfigured, user?.userId]);

  const joinQueue = async () => {
    setError(null);
    setIsBusy(true);
    try {
      const snapshot = await apiService.joinMultiplayerQueue(gameKey);
      if (!snapshot) {
        setError('Unable to join matchmaking right now.');
        return;
      }

      setMatch(prev => mergeSnapshot(prev, snapshot));
      console.log('[JQ] joinQueue result:', snapshot.status, 'isBusy will → false');
    } finally {
      setIsBusy(false);
    }
  };

  const leaveMatch = async () => {
    if (!match) {
      return;
    }

    setError(null);
    setIsBusy(true);
    try {
      await apiService.leaveMultiplayerMatch(match.matchId);
      setMatch(null);
    } finally {
      setIsBusy(false);
    }
  };

  const submitTurn = async (action: Record<string, number>) => {
    if (!match) {
      return;
    }

    setError(null);
    setIsBusy(true);
    try {
      const snapshot = await apiService.submitTurn(match.matchId, action);
      if (!snapshot) {
        setError('That move could not be applied.');
        return;
      }

      setMatch(snapshot);
    } finally {
      setIsBusy(false);
    }
  };

  return {
    match,
    isBusy,
    isConnected,
    error,
    joinQueue,
    leaveMatch,
    submitTurn,
  };
}