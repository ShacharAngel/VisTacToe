import { describe, expect, it } from 'vitest';
import type { Board, CellValue } from '@vistactoe/engine';
import type { CellReading } from '@vistactoe/shared';
import { resolveBoard, type ResolveInput } from '@vistactoe/server';

function cells(s: string, conf = 0.95, overrides: Record<number, number> = {}): CellReading[] {
  return [...s].map((ch, i) => ({
    label: ch === '.' ? 'empty' : (ch as 'X' | 'O'),
    confidence: overrides[i] ?? conf,
  }));
}

function board(s: string): Board {
  return [...s].map((c): CellValue => (c === '.' ? null : (c as 'X' | 'O')));
}

function input(partial: Partial<ResolveInput>): ResolveInput {
  return {
    observed: cells('.........'),
    committed: board('.........'),
    phase: 'human_turn',
    humanSymbol: 'X',
    agentSymbol: 'O',
    pendingAgentCell: null,
    askThreshold: 0.6,
    ...partial,
  };
}

describe('resolveBoard', () => {
  it('is idle when the page matches the committed board', () => {
    const r = resolveBoard(input({ observed: cells('X...O....'), committed: board('X...O....') }));
    expect(r).toEqual({ kind: 'idle' });
  });

  it('escalates an uncertain contradiction before acting on anything', () => {
    // Two diffs: a confident X at 0 and a shaky O at 8 — ask about 8 first.
    const r = resolveBoard(input({ observed: cells('X.......O', 0.95, { 8: 0.3 }) }));
    expect(r).toEqual({ kind: 'ask', cell: 8, observed: 'O', expected: 'empty' });
  });

  it('treats a confidently mutated mark as corruption', () => {
    const r = resolveBoard(input({ observed: cells('O........'), committed: board('X........') }));
    expect(r.kind).toBe('corrupt');
  });

  it('resolves a single new human mark as the human move', () => {
    const r = resolveBoard(input({ observed: cells('..X......') }));
    expect(r).toEqual({ kind: 'human_move', cell: 2 });
  });

  it('rejects an agent symbol appearing during the human turn', () => {
    expect(resolveBoard(input({ observed: cells('....O....') })).kind).toBe('corrupt');
  });

  it('rejects two simultaneous human marks', () => {
    expect(resolveBoard(input({ observed: cells('X..X.....') })).kind).toBe('corrupt');
  });

  describe('awaiting the agent mark (announced B2 = cell 4)', () => {
    const awaiting = { phase: 'awaiting_agent_mark' as const, committed: board('X........'), pendingAgentCell: 4 };

    it('confirms the mark at the announced cell', () => {
      const r = resolveBoard(input({ ...awaiting, observed: cells('X...O....') }));
      expect(r).toEqual({ kind: 'agent_mark', cell: 4, corrected: false, alsoHumanMove: null });
    });

    it('adopts the mark when drawn in a different empty cell', () => {
      const r = resolveBoard(input({ ...awaiting, observed: cells('X.......O') }));
      expect(r).toEqual({ kind: 'agent_mark', cell: 8, corrected: true, alsoHumanMove: null });
    });

    it('accepts the agent mark plus the next human move in one observation', () => {
      const r = resolveBoard(input({ ...awaiting, observed: cells('X.X.O....') }));
      expect(r).toEqual({ kind: 'agent_mark', cell: 4, corrected: false, alsoHumanMove: 2 });
    });

    it('reminds when only a human mark appeared elsewhere', () => {
      const r = resolveBoard(input({ ...awaiting, observed: cells('X.X......') }));
      expect(r.kind).toBe('reminder');
      expect((r as { text: string }).text).toContain('B2');
    });

    it('flags the human symbol drawn in the announced cell as corruption', () => {
      expect(resolveBoard(input({ ...awaiting, observed: cells('X...X....') })).kind).toBe('corrupt');
    });
  });
});
