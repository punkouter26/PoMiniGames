import {
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
  type HubConnection,
} from '@microsoft/signalr';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { getStoredAccessToken } from '../../context/authStorage';
import type { LobbySnapshot } from './multiplayerTypes';

interface UseLobbyResult {
  players: LobbySnapshot['players'];
  hostUserId: string | null;
  isConnected: boolean;
  isBusy: boolean;
  error: string | null;
  startGame: (gameKey: string) => Promise<void>;
}

export function useLobby(): UseLobbyResult {
  const { isAuthenticated, isConfigured } = useAuth();
  const navigate = useNavigate();
  const connectionRef = useRef<HubConnection | null>(null);
  const [players, setPlayers] = useState<LobbySnapshot['players']>([]);
  const [hostUserId, setHostUserId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;

    async function ensureConnection() {
      if (!isConfigured || !isAuthenticated) {
        setIsConnected(false);
        setPlayers([]);
        setHostUserId(null);
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
        .withUrl('/api/hubs/lobby', {
          accessTokenFactory: async () => getStoredAccessToken() ?? '',
        })
        .withAutomaticReconnect()
        .configureLogging(LogLevel.Warning)
        .build();

      connection.on('LobbyUpdated', (snapshot: LobbySnapshot) => {
        if (disposed) return;
        setPlayers(snapshot.players);
        setHostUserId(snapshot.hostUserId);
      });

      connection.on('GameStarting', (data: { gameKey: string }) => {
        if (disposed) return;
        // Navigate to the game page; ?online=1 tells the game component to auto-join matchmaking
        void navigate(`/${data.gameKey}?online=1`);
      });

      connection.onclose(() => {
        if (!disposed) {
          setIsConnected(false);
        }
      });

      connection.onreconnected(() => {
        if (!disposed) {
          setIsConnected(true);
        }
      });

      try {
        // Set ref BEFORE start so cleanup always has a reference to call stop().
        connectionRef.current = connection;
        await connection.start();
        if (disposed) {
          await connection.stop();
          return;
        }
        setIsConnected(true);
      } catch (err) {
        connectionRef.current = null;
        if (!disposed) {
          setError('Failed to connect to the lobby.');
        }
      }
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
  }, [isAuthenticated, isConfigured, navigate]);

  const startGame = useCallback(async (gameKey: string) => {
    const connection = connectionRef.current;
    if (!connection || connection.state !== HubConnectionState.Connected) {
      setError('Not connected to the lobby.');
      return;
    }

    setError(null);
    setIsBusy(true);
    try {
      await connection.invoke('StartGame', gameKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start the game.');
    } finally {
      setIsBusy(false);
    }
  }, []);

  return { players, hostUserId, isConnected, isBusy, error, startGame };
}
