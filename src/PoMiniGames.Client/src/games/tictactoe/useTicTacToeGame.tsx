import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CircleDot, Loader2, Trophy, Users, X } from 'lucide-react';
import { CellValue, Difficulty, GameResult } from '../shared/types';
import { statsService } from '../shared/statsService';
import { useAuth } from '../../context/AuthContext';
import { TicTacToeBoard } from './TicTacToeBoard';
import { TicTacToeAI } from './TicTacToeAI';
import { usePlayerName } from '../../context/PlayerNameContext';
import { type TicTacToeMultiplayerState } from '../shared/apiService';
import { type StatItem } from '../shared/GamePageShell';
import { useTurnBasedMultiplayer } from '../shared/useTurnBasedMultiplayer';

const GAME_KEY = 'tictactoe';
export type PlayMode = 'ai' | 'online' | 'demo';

export function useTicTacToeGame() {
  const [searchParams] = useSearchParams();
  const shouldAutoOnline = searchParams.get('online') === '1';
  const shouldAutoDemo = searchParams.get('demo') === '1';
  const { isAuthenticated, isConfigured, signIn, user } = useAuth();
  const { playerName } = usePlayerName();
  const multiplayer = useTurnBasedMultiplayer(GAME_KEY);
  const [board, setBoard] = useState(() => new TicTacToeBoard());
  const [difficulty, setDifficulty] = useState(Difficulty.Medium);
  const [gameResult, setGameResult] = useState(GameResult.InProgress);
  const [winCells, setWinCells] = useState<[number, number][]>([]);
  const [isAiTurn, setIsAiTurn] = useState(false);
  const [stats, setStats] = useState(() => statsService.getStats(GAME_KEY, playerName));
  const [playMode, setPlayMode] = useState<PlayMode>(
    shouldAutoDemo ? 'demo' : shouldAutoOnline ? 'online' : 'ai',
  );

  const resetGame = useCallback(() => {
    setBoard(new TicTacToeBoard());
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
      let xCount = 0;
      let oCount = 0;
      for (let r = 0; r < TicTacToeBoard.Size; r += 1) {
        for (let c = 0; c < TicTacToeBoard.Size; c += 1) {
          const cell = board.get(r, c);
          if (cell === CellValue.X) xCount += 1;
          if (cell === CellValue.O) oCount += 1;
        }
      }
      const currentToken = xCount <= oCount ? CellValue.X : CellValue.O;
      const [nextRow, nextCol] = TicTacToeAI.getMove(board, currentToken, difficulty);
      const nextBoard = board.place(nextRow, nextCol, currentToken);
      const winCheck = nextBoard.checkWin(currentToken);
      setBoard(nextBoard);
      if (winCheck.won) {
        setGameResult(currentToken === CellValue.X ? GameResult.Win : GameResult.Loss);
        setWinCells(winCheck.cells);
        return;
      }
      if (nextBoard.isFull()) setGameResult(GameResult.Draw);
    }, 225);

    return () => window.clearTimeout(timer);
  }, [board, difficulty, gameResult, playMode]);

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (playMode === 'online') { void multiplayer.submitTurn({ row, col }); return; }
      if (playMode === 'demo') return;
      if (gameResult !== GameResult.InProgress || isAiTurn) return;
      if (board.get(row, col) !== CellValue.None) return;

      let next = board.place(row, col, CellValue.X);

      const playerWin = next.checkWin(CellValue.X);
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
      setTimeout(() => {
        const [ar, ac] = TicTacToeAI.getMove(next, CellValue.O, difficulty);
        next = next.place(ar, ac, CellValue.O);
        const aiWin = next.checkWin(CellValue.O);
        if (aiWin.won) {
          setBoard(next); setGameResult(GameResult.Loss); setWinCells(aiWin.cells); setIsAiTurn(false);
          statsService.recordResult(GAME_KEY, playerName, difficulty, GameResult.Loss).then(setStats);
          return;
        }
        if (next.isFull()) {
          setBoard(next); setGameResult(GameResult.Draw); setIsAiTurn(false);
          statsService.recordResult(GAME_KEY, playerName, difficulty, GameResult.Draw).then(setStats);
          return;
        }
        setBoard(next);
        setIsAiTurn(false);
      }, 200);
    },
    [board, difficulty, gameResult, isAiTurn, multiplayer, playMode, playerName],
  );

  const isWinCell = (r: number, c: number) => winCells.some(([wr, wc]) => wr === r && wc === c);

  // ── Computed values ───────────────────────────────────────────────────────
  const onlineState = multiplayer.match?.state as TicTacToeMultiplayerState | undefined;
  const onlineBoard = onlineState
    ? new TicTacToeBoard(onlineState.board.map(row => row.map(cell => cell as CellValue)))
    : new TicTacToeBoard();
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
        ? { icon: <X size={14} />, text: 'Your turn (X)', className: 'turn' }
        : { icon: <Loader2 size={14} className="thinking-indicator" />, text: `${opponent?.displayName ?? 'Opponent'} is thinking...`, className: 'thinking' };
    }

    if (playMode === 'demo') {
      switch (gameResult) {
        case GameResult.Win:  return { icon: <X size={14} />, text: 'Demo complete: X wins', className: 'win' };
        case GameResult.Loss: return { icon: <CircleDot size={14} />, text: 'Demo complete: O wins', className: 'loss' };
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
        : { icon: <X size={14} />, text: 'Your turn (X)', className: 'turn' };
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
    boardToRender, difficulty, setDifficulty, gameResult, isAiTurn,
    playMode, setPlayMode, resetGame, handleCellClick, isWinCell,
    opponent, isMyTurnOnline, status, statItems, multiplayer,
    isAuthenticated, isConfigured, signIn, playerName,
  };
}
