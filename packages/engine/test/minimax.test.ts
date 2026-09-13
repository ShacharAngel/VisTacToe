import { describe, expect, it } from 'vitest';
import {
  applyMove,
  bestMove,
  emptyBoard,
  isFull,
  legalMoves,
  other,
  winner,
  type Board,
  type CellValue,
  type Player,
} from '@vistactoe/engine';

function board(s: string): Board {
  return [...s].map((c): CellValue => (c === '.' ? null : (c as 'X' | 'O')));
}

describe('tactical basics', () => {
  it('takes an immediate win', () => {
    // X X . / O O . / . . .  — X to move must complete the top row.
    expect(bestMove(board('XX.OO....'), 'X').move).toBe(2);
  });

  it('prefers winning over blocking', () => {
    // O O . / X X . / . . .  — X completes its own row instead of blocking.
    expect(bestMove(board('OO.XX....'), 'X').move).toBe(5);
  });

  it('blocks an immediate threat', () => {
    // X X . / . O . / . . .  — O must block at C1.
    expect(bestMove(board('XX..O....'), 'O').move).toBe(2);
  });

  it('defends the opposite-corner trap without losing', () => {
    // X . . / . O . / . . X  — O must play an edge; a corner reply loses to a fork.
    const { move, score } = bestMove(board('X...O...X'), 'O');
    expect([1, 3, 5, 7]).toContain(move);
    expect(score).toBe(0); // draw with best play, not a loss
  });

  it('opens in the center (deterministic tie-break)', () => {
    expect(bestMove(emptyBoard(), 'X').move).toBe(4);
  });

  it('rejects terminal boards', () => {
    expect(() => bestMove(board('XXXOO....'), 'O')).toThrow(/terminal/);
  });
});

describe('perfect play guarantees', () => {
  it('perfect vs perfect is always a draw', () => {
    for (const first of ['X', 'O'] as const) {
      let b = emptyBoard();
      let toMove: Player = first;
      while (winner(b) === null && !isFull(b)) {
        b = applyMove(b, bestMove(b, toMove).move, toMove);
        toMove = other(toMove);
      }
      expect(winner(b)).toBeNull();
      expect(isFull(b)).toBe(true);
    }
  });

  // Exhaustive sweep: the human tries every legal move at every turn while the
  // agent answers with bestMove. The agent must never lose a single line.
  function sweep(agent: Player, first: Player): { games: number; losses: number; wins: number } {
    const stats = { games: 0, losses: 0, wins: 0 };
    const human = other(agent);
    const walk = (b: Board, toMove: Player): void => {
      const w = winner(b);
      if (w !== null || isFull(b)) {
        stats.games++;
        if (w === human) stats.losses++;
        if (w === agent) stats.wins++;
        return;
      }
      if (toMove === agent) {
        walk(applyMove(b, bestMove(b, agent).move, agent), human);
      } else {
        for (const m of legalMoves(b)) walk(applyMove(b, m, human), agent);
      }
    };
    walk(emptyBoard(), first);
    return stats;
  }

  it('never loses as X (moving first) against any human line', () => {
    const stats = sweep('X', 'X');
    expect(stats.losses).toBe(0);
    expect(stats.games).toBeGreaterThan(50); // dozens of distinct terminal lines were actually explored
    expect(stats.wins).toBeGreaterThan(0); // punishes at least some mistakes
  });

  it('never loses as O (moving second) against any human line', () => {
    const stats = sweep('O', 'X');
    expect(stats.losses).toBe(0);
    expect(stats.games).toBeGreaterThan(50); // dozens of distinct terminal lines were actually explored
    expect(stats.wins).toBeGreaterThan(0);
  });
});
