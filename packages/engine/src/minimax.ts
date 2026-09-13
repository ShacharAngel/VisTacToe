import {
  applyMove,
  isFull,
  isTerminal,
  other,
  winner,
  type Board,
  type Player,
} from './board.js';

export interface Evaluation {
  /** Cell index of the best move. */
  move: number;
  /**
   * Score from the mover's perspective. Positive = forced win in (11 - score)
   * plies, negative = forced loss in (11 + score) plies, 0 = draw with best play.
   */
  score: number;
}

/**
 * Ply-count-free move ordering used both for speed and as a deterministic
 * tie-break between equally scored moves: center, corners, edges.
 */
const PREFERENCE = [4, 0, 2, 6, 8, 1, 3, 5, 7] as const;

/** Scores are relative to the node they were computed at, so the cache is depth-independent. */
const memo = new Map<string, number>();

function keyOf(board: Board, toMove: Player): string {
  let key = toMove;
  for (const cell of board) key += cell ?? '.';
  return key;
}

/** Score of `move` for `player` on `board`: terminal shortcuts, else negamax on the child. */
function scoreMove(board: Board, move: number, player: Player): number {
  const child = applyMove(board, move, player);
  if (winner(child) === player) return 10;
  if (isFull(child)) return 0;
  const reply = evaluate(child, other(player));
  // One ply deeper: a win/loss propagates with its magnitude shrunk by 1 and sign flipped.
  return reply > 0 ? -(reply - 1) : reply < 0 ? -(reply + 1) : 0;
}

function evaluate(board: Board, toMove: Player): number {
  const key = keyOf(board, toMove);
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let best = -Infinity;
  for (const move of PREFERENCE) {
    if (board[move] !== null) continue;
    const score = scoreMove(board, move, toMove);
    if (score > best) best = score;
  }
  memo.set(key, best);
  return best;
}

/**
 * Perfect play via exhaustive negamax. Prefers faster wins and slower losses;
 * ties break deterministically toward center, then corners, then edges.
 */
export function bestMove(board: Board, player: Player): Evaluation {
  if (isTerminal(board)) {
    throw new Error('bestMove called on a terminal board');
  }
  let best: Evaluation | null = null;
  for (const move of PREFERENCE) {
    if (board[move] !== null) continue;
    const score = scoreMove(board, move, player);
    if (best === null || score > best.score) best = { move, score };
  }
  // Non-terminal boards always have at least one legal move.
  return best!;
}
