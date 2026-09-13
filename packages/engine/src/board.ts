export type Player = 'X' | 'O';
export type CellValue = Player | null;

/** Nine cells, row-major: index 0 = top-left (A1), 4 = center (B2), 8 = bottom-right (C3). */
export type Board = readonly CellValue[];

export const CELL_COUNT = 9;

const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function emptyBoard(): Board {
  return Array<CellValue>(CELL_COUNT).fill(null);
}

export function other(player: Player): Player {
  return player === 'X' ? 'O' : 'X';
}

/** Columns are letters A-C left to right, rows are 1-3 top to bottom: 0 -> "A1", 4 -> "B2". */
export function cellName(index: number): string {
  assertIndex(index);
  return `${'ABC'.charAt(index % 3)}${Math.floor(index / 3) + 1}`;
}

export function cellIndex(name: string): number {
  const col = 'ABC'.indexOf(name.charAt(0).toUpperCase());
  const row = Number(name.charAt(1)) - 1;
  if (name.length !== 2 || col < 0 || row < 0 || row > 2) {
    throw new Error(`invalid cell name: ${name}`);
  }
  return row * 3 + col;
}

export function legalMoves(board: Board): number[] {
  const moves: number[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    if (board[i] === null) moves.push(i);
  }
  return moves;
}

export function applyMove(board: Board, index: number, player: Player): Board {
  assertIndex(index);
  if (board[index] !== null) {
    throw new Error(`cell ${cellName(index)} is already occupied`);
  }
  const next = [...board];
  next[index] = player;
  return next;
}

export function winner(board: Board): Player | null {
  for (const [a, b, c] of LINES) {
    const v = board[a];
    if (v != null && v === board[b] && v === board[c]) return v;
  }
  return null;
}

export function isFull(board: Board): boolean {
  return board.every((cell) => cell !== null);
}

export function isDraw(board: Board): boolean {
  return winner(board) === null && isFull(board);
}

export function isTerminal(board: Board): boolean {
  return winner(board) !== null || isFull(board);
}

/** Whose turn it is, given who moved first. Assumes a consistent board. */
export function whoseTurn(board: Board, first: Player): Player {
  const counts = markCounts(board);
  return counts[first] > counts[other(first)] ? other(first) : first;
}

export function markCounts(board: Board): Record<Player, number> {
  const counts: Record<Player, number> = { X: 0, O: 0 };
  for (const cell of board) {
    if (cell !== null) counts[cell]++;
  }
  return counts;
}

/**
 * A board is reachable in a legal game iff mark counts are balanced for the
 * given first player and there are not two completed winning sides.
 */
export function isConsistent(board: Board, first: Player): boolean {
  const counts = markCounts(board);
  const second = other(first);
  const diff = counts[first] - counts[second];
  if (diff !== 0 && diff !== 1) return false;
  const w = winner(board);
  // The winner must have made the last move.
  if (w === first && diff !== 1) return false;
  if (w === second && diff !== 0) return false;
  return true;
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= CELL_COUNT) {
    throw new Error(`cell index out of range: ${index}`);
  }
}
