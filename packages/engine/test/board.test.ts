import { describe, expect, it } from 'vitest';
import {
  applyMove,
  cellIndex,
  cellName,
  emptyBoard,
  isConsistent,
  isDraw,
  isTerminal,
  legalMoves,
  whoseTurn,
  winner,
  type Board,
  type CellValue,
} from '@vistactoe/engine';

/** Compact builder: 'XX.OO....' -> Board */
function board(s: string): Board {
  return [...s].map((c): CellValue => (c === '.' ? null : (c as 'X' | 'O')));
}

describe('board basics', () => {
  it('starts empty with 9 legal moves', () => {
    const b = emptyBoard();
    expect(b).toHaveLength(9);
    expect(b.every((c) => c === null)).toBe(true);
    expect(legalMoves(b)).toHaveLength(9);
  });

  it('maps cell names: columns A-C, rows 1-3, row-major indices', () => {
    expect(cellName(0)).toBe('A1');
    expect(cellName(2)).toBe('C1');
    expect(cellName(4)).toBe('B2');
    expect(cellName(6)).toBe('A3');
    expect(cellName(8)).toBe('C3');
    for (let i = 0; i < 9; i++) {
      expect(cellIndex(cellName(i))).toBe(i);
    }
    expect(cellIndex('b2')).toBe(4);
    expect(() => cellIndex('D1')).toThrow();
    expect(() => cellIndex('A4')).toThrow();
    expect(() => cellName(9)).toThrow();
  });

  it('applyMove is immutable and rejects occupied cells', () => {
    const b = emptyBoard();
    const b2 = applyMove(b, 4, 'X');
    expect(b[4]).toBeNull();
    expect(b2[4]).toBe('X');
    expect(() => applyMove(b2, 4, 'O')).toThrow(/occupied/);
    expect(() => applyMove(b2, 9, 'O')).toThrow(/range/);
  });
});

describe('winner / draw detection', () => {
  it('detects each row, column and diagonal', () => {
    expect(winner(board('XXX......'))).toBe('X');
    expect(winner(board('...OOO...'))).toBe('O');
    expect(winner(board('......XXX'))).toBe('X');
    expect(winner(board('O..O..O..'))).toBe('O');
    expect(winner(board('.X..X..X.'))).toBe('X');
    expect(winner(board('..O..O..O'))).toBe('O');
    expect(winner(board('X...X...X'))).toBe('X');
    expect(winner(board('..O.O.O..'))).toBe('O');
  });

  it('returns null when nothing is complete', () => {
    expect(winner(emptyBoard())).toBeNull();
    expect(winner(board('XX.OO....'))).toBeNull();
  });

  it('recognises a drawn full board', () => {
    const drawn = board('XOXXOOOXX');
    expect(winner(drawn)).toBeNull();
    expect(isDraw(drawn)).toBe(true);
    expect(isTerminal(drawn)).toBe(true);
    expect(isDraw(board('XX.OO....'))).toBe(false);
  });
});

describe('turn accounting', () => {
  it('derives whose turn from mark counts and first player', () => {
    expect(whoseTurn(emptyBoard(), 'X')).toBe('X');
    expect(whoseTurn(emptyBoard(), 'O')).toBe('O');
    expect(whoseTurn(board('X........'), 'X')).toBe('O');
    expect(whoseTurn(board('X...O....'), 'X')).toBe('X');
  });

  it('flags inconsistent boards', () => {
    expect(isConsistent(emptyBoard(), 'X')).toBe(true);
    expect(isConsistent(board('XX.......'), 'X')).toBe(false); // X moved twice
    expect(isConsistent(board('O........'), 'X')).toBe(false); // O started but X was first
    expect(isConsistent(board('XXXOO....'), 'X')).toBe(true); // X just won
    expect(isConsistent(board('XXXOOO...'), 'X')).toBe(false); // play continued past X's win
  });
});
