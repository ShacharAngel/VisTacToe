import { cellName, type Board, type Player } from '@vistactoe/engine';
import type { CellLabel, CellReading } from '@vistactoe/shared';

export interface ResolveInput {
  observed: readonly CellReading[];
  /** The board as the session has committed it so far. */
  committed: Board;
  phase: 'human_turn' | 'awaiting_agent_mark';
  humanSymbol: Player;
  agentSymbol: Player;
  /** Cell the agent announced, when phase is awaiting_agent_mark. */
  pendingAgentCell: number | null;
  /** Confidence below which a contradicting reading escalates instead of resolving. */
  askThreshold: number;
}

export type Resolution =
  | { kind: 'idle' }
  | { kind: 'ask'; cell: number; observed: CellLabel; expected: CellLabel }
  | { kind: 'human_move'; cell: number }
  | { kind: 'agent_mark'; cell: number; corrected: boolean; alsoHumanMove: number | null }
  | { kind: 'reminder'; text: string }
  | { kind: 'corrupt'; reason: string };

interface Diff {
  cell: number;
  expected: CellLabel;
  observed: CellLabel;
  confidence: number;
}

/**
 * Compare a stable page observation against the committed board and decide the
 * single next thing that happened. Ink is truth: the page can only gain marks,
 * so a mark that mutates or vanishes (at high confidence) means the game is
 * unrecoverable; at low confidence it is treated as a misread and escalated.
 */
export function resolveBoard(input: ResolveInput): Resolution {
  const { observed, committed, phase, humanSymbol, agentSymbol, pendingAgentCell } = input;

  const diffs: Diff[] = [];
  for (let cell = 0; cell < 9; cell++) {
    const reading = observed[cell];
    if (!reading) continue;
    const expected: CellLabel = committed[cell] ?? 'empty';
    if (reading.label !== expected) {
      diffs.push({ cell, expected, observed: reading.label, confidence: reading.confidence });
    }
  }

  if (diffs.length === 0) return { kind: 'idle' };

  // Escalate uncertain contradictions one at a time before acting on anything.
  const uncertain = diffs.find((d) => d.confidence < input.askThreshold);
  if (uncertain) {
    return { kind: 'ask', cell: uncertain.cell, observed: uncertain.observed, expected: uncertain.expected };
  }

  const mutated = diffs.find((d) => d.expected !== 'empty');
  if (mutated) {
    return {
      kind: 'corrupt',
      reason: `${cellName(mutated.cell)} looked like ${mutated.expected} before and now reads ${mutated.observed} — ink cannot change`,
    };
  }

  const newHuman = diffs.filter((d) => d.observed === humanSymbol);
  const newAgent = diffs.filter((d) => d.observed === agentSymbol);

  if (phase === 'human_turn') {
    if (newAgent.length > 0) {
      return { kind: 'corrupt', reason: `a new ${agentSymbol} appeared at ${cellName(newAgent[0]!.cell)} but I did not play` };
    }
    if (newHuman.length > 1) {
      return { kind: 'corrupt', reason: `two new ${humanSymbol} marks appeared at once` };
    }
    return { kind: 'human_move', cell: newHuman[0]!.cell };
  }

  // awaiting_agent_mark: the agent announced pendingAgentCell and is waiting for its ink.
  if (newAgent.length > 1) {
    return { kind: 'corrupt', reason: `two new ${agentSymbol} marks appeared but I only played one move` };
  }
  if (newHuman.length > 1) {
    return { kind: 'corrupt', reason: `two new ${humanSymbol} marks appeared at once` };
  }

  if (newAgent.length === 1) {
    const drawn = newAgent[0]!;
    return {
      kind: 'agent_mark',
      cell: drawn.cell,
      corrected: drawn.cell !== pendingAgentCell,
      // The human may have drawn the agent's mark and immediately played their
      // own before a stable frame landed — accept both, in order.
      alsoHumanMove: newHuman[0]?.cell ?? null,
    };
  }

  // Only a human mark appeared while the agent's move is still un-drawn.
  const announced = pendingAgentCell !== null ? cellName(pendingAgentCell) : '?';
  if (pendingAgentCell !== null && newHuman[0]!.cell === pendingAgentCell) {
    return {
      kind: 'corrupt',
      reason: `${announced} now holds a ${humanSymbol} but I asked for my ${agentSymbol} there`,
    };
  }
  return { kind: 'reminder', text: `Please draw my ${agentSymbol} at ${announced} first — then make your move.` };
}
