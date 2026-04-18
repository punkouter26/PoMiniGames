import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CircleDot, Loader2, Trophy, Users, X } from 'lucide-react';
import { CellValue, Difficulty, GameResult } from '../shared/types';
import { statsService } from '../shared/statsService';
import { TicTacToeBoard } from './TicTacToeBoard';
import { TicTacToeAI } from './TicTacToeAI';
import { usePlayerName } from '../../context/PlayerNameContext';
import { type StatItem } from '../shared/GamePageShell';

const GAME_KEY = 'tictactoe';
export type PlayMode = 'ai' | 'local' | 'demo';

export function useTicTacToeGame() {
  const [searchParams] = useSearchParams();
  const shouldAutoLocal = searchParams.get('local') === '1';
  const shouldAutoDemo = searchParams.get('demo') === '1';
  const { playerName } = usePlayerName();
  const [playMode, setPlayMode] = useState<PlayMode>(shouldAutoDemo ? 'demo' : shouldAutoLocal ? 'local' : 'ai');
  const [board, setBoard] = useState(() => new TicTacToeBoard());
  const [difficulty, setDifficulty] = useState(Difficulty.Medium);
  const [gameResult, setGameResult] = useState(GameResult.InProgress);
  const [winCells, setWinCells] = useState<[number, number][]>([]);
  const [isAiTurn, setIsAiTurn] = useState(false);
  const [stats, setStats] = useState(() => statsService.getStats(GAME_KEY, playerName));

  const resetGame = useCallback(() => {
    setBoard(new TicTacToeBoard());
    setGameResult(GameResult.InProgress);
    setWinCells([]);
    setIsAiTurn(false);
  }, []);

  const getNextLocalToken = useCallback((currentBoard: TicTacToeBoard) => {
    let xCount = 0;
    let oCount = 0;

    for (let r = 0; r < TicTacToeBoard.Size; r += 1) {
      for (let c = 0; c < TicTacToeBoard.Size; c += 1) {
        const cell = currentBoard.get(r, c);
        if (cell === CellValue.X) xCount += 1;
        if (cell === CellValue.O) oCount += 1;
      }
    }

    return xCount <= oCount ? CellValue.X : CellValue.O;
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
      const currentToken = getNextLocalToken(board);
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
  }, [board, difficulty, gameResult, getNextLocalToken, playMode]);

  const handleCellClick = useCallback((row: number, col: number) => {
    if (playMode === 'demo') return;
    if (gameResult !== GameResult.InProgress || isAiTurn) return;
    if (board.get(row, col) !== CellValue.None) return;

    const currentToken = playMode === 'local' ? getNextLocalToken(board) : CellValue.X;
    let next = board.place(row, col, currentToken);

    const winCheck = next.checkWin(currentToken);
    if (winCheck.won) {
      const result = currentToken === CellValue.X ? GameResult.Win : GameResult.Loss;
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
    window.setTimeout(() => {
      const [ar, ac] = TicTacToeAI.getMove(next, CellValue.O, difficulty);
      next = next.place(ar, ac, CellValue.O);
      const aiWin = next.checkWin(CellValue.O);
      if (aiWin.won) {
        setBoard(next);
        setGameResult(GameResult.Loss);
        setWinCells(aiWin.cells);
        setIsAiTurn(false);
        void statsService.recordResult(GAME_KEY, playerName, difficulty, GameResult.Loss).then(setStats);
        return;
      }
      if (next.isFull()) {
        setBoard(next);
        setGameResult(GameResult.Draw);
        setIsAiTurn(false);
        void statsService.recordResult(GAME_KEY, playerName, difficulty, GameResult.Draw).then(setStats);
        return;
      }
      setBoard(next);
      setIsAiTurn(false);
    }, 200);
  }, [board, difficulty, gameResult, getNextLocalToken, isAiTurn, playMode, playerName]);

  const isWinCell = (r: number, c: number) => winCells.some(([wr, wc]) => wr === r && wc === c);

  const getStatusContent = () => {
    if (playMode === 'demo') {
      switch (gameResult) {
        case GameResult.Win: return { icon: <X size={14} />, text: 'Demo complete: X wins', className: 'win' };
        case GameResult.Loss: return { icon: <CircleDot size={14} />, text: 'Demo complete: O wins', className: 'loss' };
        case GameResult.Draw: return { icon: <Users size={14} />, text: 'Demo complete: Draw', className: 'draw' };
        default: return { icon: <Loader2 size={14} className="thinking-indicator" />, text: 'Demo mode: CPUs are playing...', className: 'thinking' };
      }
    }

    if (playMode === 'local') {
      const nextToken = getNextLocalToken(board);
      switch (gameResult) {
        case GameResult.Win: return { icon: <Trophy size={14} />, text: 'Player X wins!', className: 'win' };
        case GameResult.Loss: return { icon: <CircleDot size={14} />, text: 'Player O wins!', className: 'loss' };
        case GameResult.Draw: return { icon: <Users size={14} />, text: 'Draw!', className: 'draw' };
        default: return nextToken === CellValue.X
          ? { icon: <X size={14} />, text: 'Player X turn', className: 'turn' }
          : { icon: <CircleDot size={14} />, text: 'Player O turn', className: 'turn' };
      }
    }

    switch (gameResult) {
      case GameResult.Win: return { icon: <Trophy size={14} />, text: 'You Win!', className: 'win' };
      case GameResult.Loss: return { icon: <CircleDot size={14} />, text: 'AI Wins!', className: 'loss' };
      case GameResult.Draw: return { icon: <Users size={14} />, text: 'Draw!', className: 'draw' };
      default: return isAiTurn
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
    { value: diffBucket.eloRating ?? 1000, label: 'ELO' },
  ];

  return {
    boardToRender: board,
    difficulty,
    setDifficulty,
    gameResult,
    isAiTurn,
    playMode,
    setPlayMode,
    resetGame,
    handleCellClick,
    isWinCell,
    status,
    statItems,
    playerName,
  };
}
