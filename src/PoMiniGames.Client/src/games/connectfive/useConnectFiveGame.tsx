import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CircleDot, Loader2, Trophy, Users } from 'lucide-react';
import { Piece, Difficulty, GameResult } from '../shared/types';
import { statsService } from '../shared/statsService';
import { useAuth } from '../../context/AuthContext';
import { ConnectFiveBoard } from './ConnectFiveBoard';
import { ConnectFiveAI } from './ConnectFiveAI';
import { usePlayerName } from '../../context/PlayerNameContext';
import { type ConnectFiveMultiplayerState } from '../shared/multiplayerTypes';
import { type StatItem } from '../shared/GamePageShell';
import { useTurnBasedMultiplayer } from '../shared/useTurnBasedMultiplayer';

const GAME_KEY = 'connectfive';
export type PlayMode = 'ai' | 'online' | 'demo';

export function useConnectFiveGame() {
  const [searchParams] = useSearchParams();
  const shouldAutoOnline = searchParams.get('online') === '1';
  const shouldAutoDemo = searchParams.get('demo') === '1';
  const { isAuthenticated, isConfigured, signIn, user } = useAuth();
  const { playerName } = usePlayerName();
  const multiplayer = useTurnBasedMultiplayer(GAME_KEY);
  const [board, setBoard] = useState(() => new ConnectFiveBoard());
  const [difficulty, setDifficulty] = useState(Difficulty.Medium);
  const [gameResult, setGameResult] = useState(GameResult.InProgress);
  const [winCells, setWinCells] = useState<[number, number][]>([]);
  const [isAiTurn, setIsAiTurn] = useState(false);
  const [stats, setStats] = useState(() => statsService.getStats(GAME_KEY, playerName));
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);
  const [playMode, setPlayMode] = useState<PlayMode>(
    shouldAutoDemo ? 'demo' : shouldAutoOnline ? 'online' : 'ai',
  );

  // Web worker for AI computation — keeps heavy minimax off the main thread.
  type PendingAI = { board: ConnectFiveBoard; playerName: string; difficulty: Difficulty };
  const workerRef = useRef<Worker | null>(null);
  const pendingAiRef = useRef<PendingAI | null>(null);

  useEffect(() => {
    const worker = new Worker(
      new URL('./connectfive.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (e: MessageEvent<number>) => {
      const pending = pendingAiRef.current;
      if (!pending) return;
      pendingAiRef.current = null;

      const aiCol = e.data;
      let next = pending.board.drop(aiCol, Piece.Yellow);
      const aiWin = next.checkWin(Piece.Yellow);
      if (aiWin.won) {
        setBoard(next); setGameResult(GameResult.Loss); setWinCells(aiWin.cells); setIsAiTurn(false);
        statsService.recordResult(GAME_KEY, pending.playerName, pending.difficulty, GameResult.Loss).then(setStats);
        return;
      }
      if (next.isFull()) {
        setBoard(next); setGameResult(GameResult.Draw); setIsAiTurn(false);
        statsService.recordResult(GAME_KEY, pending.playerName, pending.difficulty, GameResult.Draw).then(setStats);
        return;
      }
      setBoard(next);
      setIsAiTurn(false);
    };
    workerRef.current = worker;
    return () => { worker.terminate(); workerRef.current = null; };
  }, []);

  const resetGame = useCallback(() => {
    setBoard(new ConnectFiveBoard());
    setGameResult(GameResult.InProgress);
    setWinCells([]);
    setIsAiTurn(false);
  }, []);

  useEffect(() => {
    if (shouldAutoDemo) { setPlayMode('demo'); return; }
    if (shouldAutoOnline) { setPlayMode('online'); }
  }, [shouldAutoDemo, shouldAutoOnline]);

  useEffect(() => {
    if (!shouldAutoOnline || shouldAutoDemo || !isConfigured || !isAuthenticated) return;
    if (!multiplayer.isConnected || multiplayer.isBusy || multiplayer.match) return;
    void multiplayer.joinQueue();
  }, [
    shouldAutoOnline, shouldAutoDemo, isConfigured, isAuthenticated,
    multiplayer.isConnected, multiplayer.isBusy, multiplayer.match, multiplayer.joinQueue,
  ]);

  useEffect(() => {
    if (playMode !== 'demo' || gameResult !== GameResult.InProgress) return;

    const timer = window.setTimeout(() => {
      let redCount = 0;
      let yellowCount = 0;
      for (let r = 0; r < ConnectFiveBoard.Rows; r += 1) {
        for (let c = 0; c < ConnectFiveBoard.Cols; c += 1) {
          const piece = board.get(r, c);
          if (piece === Piece.Red) redCount += 1;
          if (piece === Piece.Yellow) yellowCount += 1;
        }
      }
      const nextPiece = redCount <= yellowCount ? Piece.Red : Piece.Yellow;
      const nextCol = ConnectFiveAI.getMove(board, nextPiece, difficulty);
      const nextBoard = board.drop(nextCol, nextPiece);
      const winCheck = nextBoard.checkWin(nextPiece);
      setBoard(nextBoard);
      if (winCheck.won) {
        setGameResult(nextPiece === Piece.Red ? GameResult.Win : GameResult.Loss);
        setWinCells(winCheck.cells);
        return;
      }
      if (nextBoard.isFull()) setGameResult(GameResult.Draw);
    }, 275);

    return () => window.clearTimeout(timer);
  }, [board, difficulty, gameResult, playMode]);

  const handleDrop = useCallback(
    (col: number) => {
      if (playMode === 'online') { void multiplayer.submitTurn({ column: col }); return; }
      if (playMode === 'demo') return;
      if (gameResult !== GameResult.InProgress || isAiTurn) return;
      if (board.getTargetRow(col) < 0) return;

      let next = board.drop(col, Piece.Red);

      const playerWin = next.checkWin(Piece.Red);
      if (playerWin.won) {
        setBoard(next); setGameResult(GameResult.Win); setWinCells(playerWin.cells);
        statsService.recordResult(GAME_KEY, playerName, difficulty, GameResult.Win).then(setStats);
        return;
      }
      if (next.isFull()) {
        setBoard(next); setGameResult(GameResult.Draw);
        statsService.recordResult(GAME_KEY, playerName, difficulty, GameResult.Draw).then(setStats);
        return;
      }

      setBoard(next);
      setIsAiTurn(true);
      // Serialize the board and dispatch to the worker to avoid blocking the main thread.
      const cells: Piece[][] = Array.from({ length: ConnectFiveBoard.Rows }, (_, r) =>
        Array.from({ length: ConnectFiveBoard.Cols }, (_, c) => next.get(r, c)),
      );
      pendingAiRef.current = { board: next, playerName, difficulty };
      workerRef.current?.postMessage({ cells, player: Piece.Yellow, difficulty });
    },
    [board, difficulty, gameResult, isAiTurn, multiplayer, playMode, playerName],
  );

  const isWinCell = (r: number, c: number) => winCells.some(([wr, wc]) => wr === r && wc === c);

  // ── Computed values ───────────────────────────────────────────────────────
  const onlineState = multiplayer.match?.state as ConnectFiveMultiplayerState | undefined;
  const onlineBoard = onlineState
    ? new ConnectFiveBoard(onlineState.board.map(row => row.map(cell => cell as Piece)))
    : new ConnectFiveBoard();
  const boardToRender = playMode === 'online' ? onlineBoard : board;
  const activeUserId = user?.userId ?? null;
  const opponent = multiplayer.match?.participants.find(p => p.userId !== activeUserId) ?? null;
  const isMyTurnOnline = Boolean(
    multiplayer.match?.currentTurnUserId && multiplayer.match.currentTurnUserId === activeUserId,
  );
  const onlineResult = multiplayer.match?.winnerUserId === activeUserId
    ? GameResult.Win
    : multiplayer.match?.winnerUserId
      ? GameResult.Loss
      : multiplayer.match?.status === 'Completed'
        ? GameResult.Draw
        : GameResult.InProgress;

  const getStatusContent = () => {
    if (playMode === 'online') {
      if (!isConfigured) return { icon: <Users size={14} />, text: 'Online sign-in is not available right now', className: 'draw' };
      if (!isAuthenticated) return { icon: <Users size={14} />, text: 'Sign in to play online', className: 'draw' };
      if (!multiplayer.isConnected) return { icon: <Loader2 size={14} className="thinking-indicator" />, text: 'Connecting to multiplayer...', className: 'thinking' };
      if (!multiplayer.match) return { icon: <Users size={14} />, text: 'Find an opponent to start', className: 'turn' };
      if (multiplayer.match.status === 'WaitingForOpponent') return { icon: <Loader2 size={14} className="thinking-indicator" />, text: 'Finding opponent...', className: 'thinking' };
      if (multiplayer.match.status === 'Abandoned') return { icon: <Users size={14} />, text: multiplayer.match.result ?? 'Opponent left the match', className: 'draw' };
      if (multiplayer.match.status === 'Completed') {
        switch (onlineResult) {
          case GameResult.Win:  return { icon: <Trophy size={14} />, text: 'You Win!', className: 'win' };
          case GameResult.Loss: return { icon: <CircleDot size={14} />, text: `${opponent?.displayName ?? 'Opponent'} wins`, className: 'loss' };
          default:              return { icon: <Users size={14} />, text: 'Draw!', className: 'draw' };
        }
      }
      return isMyTurnOnline
        ? (() => {
            // onlineState may be briefly undefined while hydrating after reconnect;
            // fall back to generic text rather than guessing the wrong piece colour.
            if (!onlineState) {
              return { icon: <CircleDot size={14} />, text: 'Your turn', className: 'turn' };
            }
            const isRed = onlineState.redUserId === activeUserId;
            return { icon: <CircleDot size={14} color={isRed ? '#f44336' : '#ffeb3b'} />, text: `Your turn (${isRed ? 'Red' : 'Yellow'})`, className: 'turn' };
          })()
        : { icon: <Loader2 size={14} className="thinking-indicator" />, text: `${opponent?.displayName ?? 'Opponent'} is choosing a column...`, className: 'thinking' };
    }

    if (playMode === 'demo') {
      switch (gameResult) {
        case GameResult.Win:  return { icon: <CircleDot size={14} color="#f44336" />, text: 'Demo complete: Red wins', className: 'win' };
        case GameResult.Loss: return { icon: <CircleDot size={14} color="#ffeb3b" />, text: 'Demo complete: Yellow wins', className: 'loss' };
        case GameResult.Draw: return { icon: <Users size={14} />, text: 'Demo complete: Draw', className: 'draw' };
        default:              return { icon: <Loader2 size={14} className="thinking-indicator" />, text: 'Demo mode: CPUs are playing...', className: 'thinking' };
      }
    }

    switch (gameResult) {
      case GameResult.Win:  return { icon: <Trophy size={14} />, text: 'You Win!', className: 'win' };
      case GameResult.Loss: return { icon: <CircleDot size={14} />, text: 'AI Wins!', className: 'loss' };
      case GameResult.Draw: return { icon: <Users size={14} />, text: 'Draw!', className: 'draw' };
      default:              return isAiTurn
        ? { icon: <Loader2 size={14} className="thinking-indicator" />, text: 'AI thinking...', className: 'thinking' }
        : { icon: <CircleDot size={14} color="#f44336" />, text: 'Your turn (Red)', className: 'turn' };
    }
  };

  const status = getStatusContent();
  const diffBucket = statsService.getDifficultyBucket(stats, difficulty);
  const statItems: StatItem[] = [
    { value: diffBucket.wins, label: 'W' },
    { value: diffBucket.losses, label: 'L' },
    { value: diffBucket.draws, label: 'D' },
    { value: diffBucket.winStreak, label: 'Str' },
    { value: `${(diffBucket.winRate * 100).toFixed(0)}%`, label: 'Rate' },
  ];

  return {
    board, boardToRender, difficulty, setDifficulty, gameResult, isAiTurn,
    hoveredCol, setHoveredCol, playMode, setPlayMode, resetGame, handleDrop,
    isWinCell, opponent, isMyTurnOnline, status, statItems, multiplayer,
    isAuthenticated, isConfigured, signIn, playerName,
  };
}
