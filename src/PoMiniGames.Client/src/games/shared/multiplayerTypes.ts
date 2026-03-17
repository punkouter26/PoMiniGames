export type MultiplayerMatchStatus = 'WaitingForOpponent' | 'InProgress' | 'Completed' | 'Abandoned';

export type MultiplayerTransportMode = 'TurnBased' | 'Realtime';

export interface MultiplayerParticipant {
  userId: string;
  displayName: string;
  seat: number;
  isConnected: boolean;
}

export interface MultiplayerMatchSnapshot {
  matchId: string;
  gameKey: string;
  displayName: string;
  mode: MultiplayerTransportMode;
  status: MultiplayerMatchStatus;
  participants: MultiplayerParticipant[];
  currentTurnUserId: string | null;
  winnerUserId: string | null;
  result: string | null;
  state: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SupportedMultiplayerGame {
  gameKey: string;
  displayName: string;
  mode: MultiplayerTransportMode;
  enabledForQueue: boolean;
}

export interface TicTacToeMultiplayerState {
  board: number[][];
  xUserId: string;
  oUserId: string;
  moveCount: number;
}

export interface ConnectFiveMultiplayerState {
  board: number[][];
  redUserId: string;
  yellowUserId: string;
  moveCount: number;
}

export interface RealtimeInputEnvelope {
  matchId: string;
  fromUserId: string;
  fromDisplayName: string;
  payload: unknown;
  sentAt: string;
}

// ─── Lobby ───────────────────────────────────────────────────────────────────

export interface LobbyPlayer {
  userId: string;
  displayName: string;
  joinedAt: string;
}

export interface LobbySnapshot {
  players: LobbyPlayer[];
  hostUserId: string | null;
}