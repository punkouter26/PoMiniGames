import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CircleDot, Loader2, Trophy, Users } from 'lucide-react';
import { Difficulty, GameResult, Piece } from '../shared/types';
import { statsService } from '../shared/statsService';
import { usePlayerName } from '../../context/PlayerNameContext';
import { type StatItem } from '../shared/GamePageShell';
import { ConnectFiveBoard } from './ConnectFiveBoard';
import { ConnectFiveAI } from './ConnectFiveAI';

const GAME_KEY = 'connectfive';
export type PlayMode = 'ai' | 'local' | 'demo';

export function useConnectFiveGame() {
  const [searchParams] = useSearchParams();
  const shouldAutoLocal = searchParams.get('local') === '1';
  const shouldAutoDemo = searchParams.get('demo') === '1';
  const { playerName } = usePlayerName();
  const [playMode, setPlayMode] = useState<PlayMode>(shouldAutoDemo ? 'demo' : shouldAutoLocal ? 'local' : 'ai');
  const [board, setBoard] = useState(() => new ConnectFiveBoard());
  const [difficulty, setDifficulty] = useState(Difficulty.Medium);
  const [gameResult, setGameResult] = useState(GameResult.InProgress);
  const [winCells, setWinCells] = useState<[number, number][]>([]);
  const [isAiTurn, setIsAiTurn] = useState(false);
  const [stats, setStats] = useState(() => statsService.getStats(GAME_KEY, playerName));
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);

  type PendingAI = { board: ConnectFiveBoard; playerName: string; difficulty: Difficulty };
  const workerRef = useRef<Worker | null>(null);
  const pendingAiRef = useRef<PendingAI | null>(null);
  const aiTurnStartRef = useRef<number>(0);
  const AI_MIN_THINK_MS = 350;

  useEffect(() => {
    const worker = new Worker(new URL('./connectfive.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<number>) => {
      const pending = pendingAiRef.current;
      if (!pending) return;
      pendingAiRef.current = null;

      const aiCol = e.data;
      const elapsed = performance.now() - aiTurnStartRef.current;
      const remaining = Math.max(0, AI_MIN_THINK_MS - elapsed);

      const applyMove = () => {
        let next = pending.board.drop(aiCol, Piece.Yellow);
        const aiWin = next.checkWin(Piece.Yellow);
        if (aiWin.won) {
          setBoard(next);
          setGameResult(GameResult.Loss);
          setWinCells(aiWin.cells);
          setIsAiTurn(false);
          void statsService.recordResult(GAME_KEY, pending.playerName, pending.difficulty, GameResult.Loss).then(setStats);
          return;
        }
        if (next.isFull()) {
          setBoard(next);
          setGameResult(GameResult.Draw);
          setIsAiTurn(false);
          void statsService.recordResult(GAME_KEY, pending.playerName, pending.difficulty, GameResult.Draw).then(setStats);
          return;
        }
        setBoard(next);
        setIsAiTurn(false);
      };

      if (remaining > 0) {
        window.setTimeout(applyMove, remaining);
      } else {
        applyMove();
      }
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const resetGame = useCallback(() => {
    setBoard(new ConnectFiveBoard());
    setGameResult(GameResult.InProgress);
    setWinCells([]);
    setIsAiTurn(false);
  }, []);

  const getNextLocalPiece = useCallback((currentBoard: ConnectFiveBoard) => {
    let redCount = 0;
    let yellowCount = 0;

    for (let r = 0; r < ConnectFiveBoard.Rows; r += 1) {
      for (let c = 0; c < ConnectFiveBoard.Cols; c += 1) {
        const piece = currentBoard.get(r, c);
        if (piece === Piece.Red) redCount += 1;
        if (piece === Piece.Yellow) yellowCount += 1;
      }
    }

    return redCount <= yellowCount ? Piece.Red : Piece.Yellow;
  }, []);

  useEffect(() => {
    if (shouldAutoDemo) {
      setPlayMode('demo');
      return;
    }
    if (shouldAutoLocal) {
      setPlayMode('local');
      return;
    }
    setPlayMode('ai');
  }, [shouldAutoDemo, shouldAutoLocal]);

  useEffect(() => {
    if (playMode !== 'demo' || gameResult !== GameResult.InProgress) return;

    const timer = window.setTimeout(() => {
      const nextPiece = getNextLocalPiece(board);
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
  }, [board, difficulty, gameResult, getNextLocalPiece, playMode]);

  const handleDrop = useCallback((col: number) => {
    if (playMode === 'demo') return;
    if (gameResult !== GameResult.InProgress || isAiTurn) return;
    if (board.getTargetRow(col) < 0) return;

    const currentPiece = playMode === 'local' ? getNextLocalPiece(board) : Piece.Red;
    let next = board.drop(col, currentPiece);

    const winCheck = next.checkWin(currentPiece);
    if (winCheck.won) {
      const result = currentPiece === Piece.Red ? GameResult.Win : GameResult.Loss;
      setBoard(next);
      setGameResult(result);
      setWinCells(winCheck.cells);
      if (playMode === 'ai') {
        void statsService.recordResult(GAME_KEY, playerName, difficulty, result).then(setStats);
      }
      return;
    }

    if (next.isFull()) {
      setBoard(next);
      setGameResult(GameResult.Draw);
      if (playMode === 'ai') {
        void statsService.recordResult(GAME_KEY, playerName, difficulty, GameResult.Draw).then(setStats);
      }
      return;
    }

    if (playMode === 'local') {
      setBoard(next);
      return;
    }

    setBoard(next);
    setIsAiTurn(true);
    aiTurnStartRef.current = performance.now();
    const cells: Piece[][] = Array.from({ length: ConnectFiveBoard.Rows }, (_, r) =>
      Array.from({ length: ConnectFiveBoard.Cols }, (_, c) => next.get(r, c)),
    );
    pendingAiRef.current = { board: next, playerName, difficulty };
    workerRef.current?.postMessage({ cells, player: Piece.Yellow, difficulty });
  }, [board, difficulty, gameResult, getNextLocalPiece, isAiTurn, playMode, playerName]);

  const isWinCell = (r: number, c: number) => winCells.some(([wr, wc]) => wr === r && wc === c);

  const getStatusContent = () => {
    if (playMode === 'demo') {
      switch (gameResult) {
        case GameResult.Win: return { icon: <CircleDot size={14} color="#f44336" />, text: 'Demo complete: Red wins', className: 'win' };
        case GameResult.Loss: return { icon: <CircleDot size={14} color="#ffeb3b" />, text: 'Demo complete: Yellow wins', className: 'loss' };
        case GameResult.Draw: return { icon: <Users size={14} />, text: 'Demo complete: Draw', className: 'draw' };
        default: return { icon: <Loader2 size={14} className="thinking-indicator" />, text: 'Demo mode: CPUs are playing...', className: 'thinking' };
      }
    }

    if (playMode === 'local') {
      const nextPiece = getNextLocalPiece(board);
      switch (gameResult) {
        case GameResult.Win: return { icon: <Trophy size={14} />, text: 'Red wins!', className: 'win' };
        case GameResult.Loss: return { icon: <CircleDot size={14} />, text: 'Yellow wins!', className: 'loss' };
        case GameResult.Draw: return { icon: <Users size={14} />, text: 'Draw!', className: 'draw' };
        default: return nextPiece === Piece.Red
          ? { icon: <CircleDot size={14} color="#f44336" />, text: 'Red turn', className: 'turn' }
          : { icon: <CircleDot size={14} color="#ffeb3b" />, text: 'Yellow turn', className: 'turn' };
      }
    }

    switch (gameResult) {
      case GameResult.Win: return { icon: <Trophy size={14} />, text: 'You Win!', className: 'win' };
      case GameResult.Loss: return { icon: <CircleDot size={14} />, text: 'AI Wins!', className: 'loss' };
      case GameResult.Draw: return { icon: <Users size={14} />, text: 'Draw!', className: 'draw' };
      default: return isAiTurn
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
    { value: diffBucket.eloRating ?? 1000, label: 'ELO' },
  ];

  return {
    board,
    boardToRender: board,
    difficulty,
    setDifficulty,
    gameResult,
    isAiTurn,
    hoveredCol,
    setHoveredCol,
    playMode,
    setPlayMode,
    resetGame,
    handleDrop,
    isWinCell,
    status,
    statItems,
    playerName,
  };
}
