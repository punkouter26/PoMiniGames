/// <reference lib="webworker" />
import { ConnectFiveBoard } from './ConnectFiveBoard';
import { ConnectFiveAI } from './ConnectFiveAI';
import type { Piece, Difficulty } from '../shared/types';

export interface WorkerRequest {
  cells: Piece[][];
  player: Piece;
  difficulty: Difficulty;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { cells, player, difficulty } = e.data;
  const board = new ConnectFiveBoard(cells);
  const col = ConnectFiveAI.getMove(board, player, difficulty);
  self.postMessage(col);
};
