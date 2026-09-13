import type { Board, Player } from '@vistactoe/engine';

export type CellLabel = Player | 'empty';

/** One cell as perceived on the page: label plus classifier confidence in [0, 1]. */
export interface CellReading {
  label: CellLabel;
  confidence: number;
}

/**
 * What the perception layer reports to the session per processed frame batch.
 * `board` is only emitted for a locked grid after the scene has been stable —
 * motion gating and lock acquisition live entirely in the vision layer.
 */
export type Observation =
  | { kind: 'no_paper' }
  | { kind: 'no_grid' }
  | { kind: 'unstable' }
  | { kind: 'board'; cells: CellReading[]; observedAt?: number };

export type Phase =
  | 'no_paper'
  | 'no_grid'
  | 'human_turn'
  | 'awaiting_agent_mark'
  | 'awaiting_answer'
  | 'game_over'
  | 'corrupted';

export interface AskPayload {
  id: string;
  cell: number;
  question: string;
  options: CellLabel[];
}

export type SayCategory = 'prompt' | 'move' | 'correction' | 'result' | 'warning' | 'info';

/** Side-effects the session asks the host (server) to perform. */
export type Effect =
  | { kind: 'say'; category: SayCategory; text: string }
  | { kind: 'ask'; ask: AskPayload }
  | { kind: 'log'; event: { type: string } & Record<string, unknown> };

export interface GameResult {
  winner: Player | null;
  draw: boolean;
}

export interface SessionSnapshot {
  phase: Phase;
  board: Board;
  humanSymbol: Player;
  agentSymbol: Player;
  /** Whose move it is; null outside active play. */
  toMove: Player | null;
  /** Cell the agent announced and is waiting to see drawn, if any. */
  pendingAgentCell: number | null;
  pendingAsk: AskPayload | null;
  result: GameResult | null;
  gameNumber: number;
  moveHistory: { player: Player; cell: number }[];
}
