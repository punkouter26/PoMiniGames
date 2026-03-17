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
          setMatch(snapshot);
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
        if (match?.matchId) {
          const latest = await apiService.getMultiplayerMatch(match.matchId);
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
  }, [gameKey, isAuthenticated, isConfigured, match?.matchId, user?.userId]);

  const joinQueue = async () => {
    setError(null);
    setIsBusy(true);
    try {
      const snapshot = await apiService.joinMultiplayerQueue(gameKey);
      if (!snapshot) {
        setError('Unable to join matchmaking right now.');
        return;
      }

      setMatch(snapshot);
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