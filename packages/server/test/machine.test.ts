import { describe, expect, it } from 'vitest';
import { bestMove, cellName, type Board, type CellValue, type Player } from '@vistactoe/engine';
import type { CellReading, Effect, Observation } from '@vistactoe/shared';
import { GameSession } from '@vistactoe/server';

function cellsOf(s: string, conf = 0.95, overrides: Record<number, number> = {}): CellReading[] {
  return [...s].map((ch, i) => ({
    label: ch === '.' ? 'empty' : (ch as 'X' | 'O'),
    confidence: overrides[i] ?? conf,
  }));
}

const obs = (s: string, conf?: number, overrides?: Record<number, number>): Observation => ({
  kind: 'board',
  cells: cellsOf(s, conf, overrides),
});

const toBoard = (s: string): Board => [...s].map((c): CellValue => (c === '.' ? null : (c as 'X' | 'O')));
const place = (s: string, cell: number, symbol: Player): string => s.slice(0, cell) + symbol + s.slice(cell + 1);

const says = (fx: Effect[]) => fx.filter((e) => e.kind === 'say');
const asks = (fx: Effect[]) => fx.filter((e) => e.kind === 'ask');
const logTypes = (fx: Effect[]) => fx.filter((e) => e.kind === 'log').map((e) => e.event.type);

/** Boot a session to the start of a fresh game (human first by default). */
function freshGame(config?: ConstructorParameters<typeof GameSession>[0]): GameSession {
  const s = new GameSession(config);
  s.onObservation(obs('.........'));
  return s;
}

describe('setup prompts', () => {
  it('prompts once for a missing page, then once for a missing grid', () => {
    const s = new GameSession();
    const first = s.onObservation({ kind: 'no_paper' });
    expect(says(first)).toHaveLength(1);
    expect(s.onObservation({ kind: 'no_paper' })).toHaveLength(0); // no repeat spam
    const grid = s.onObservation({ kind: 'no_grid' });
    expect(says(grid)[0]?.text).toContain('grid');
    expect(s.onObservation({ kind: 'unstable' })).toHaveLength(0);
  });

  it('starts a game when an empty grid appears', () => {
    const s = new GameSession();
    const fx = s.onObservation(obs('.........'));
    expect(logTypes(fx)).toContain('game_start');
    expect(s.snapshot().phase).toBe('human_turn');
    expect(s.snapshot().gameNumber).toBe(1);
  });

  it('announces immediately when configured to move first', () => {
    const s = new GameSession({ humanFirst: false });
    const fx = s.onObservation(obs('.........'));
    const snap = s.snapshot();
    expect(snap.phase).toBe('awaiting_agent_mark');
    expect(snap.pendingAgentCell).toBe(4); // center opening
    expect(says(fx).some((e) => e.text.includes('B2'))).toBe(true);
  });
});

describe('full games', () => {
  it('plays a perfect human to a draw, page-driven end to end', () => {
    const s = freshGame();
    let page = '.........';
    for (let guard = 0; guard < 20; guard++) {
      const snap = s.snapshot();
      if (snap.phase === 'game_over') break;
      if (snap.phase === 'human_turn') {
        page = place(page, bestMove(toBoard(page), 'X').move, 'X');
      } else if (snap.phase === 'awaiting_agent_mark') {
        page = place(page, snap.pendingAgentCell!, 'O');
      } else {
        throw new Error(`unexpected phase ${snap.phase}`);
      }
      s.onObservation(obs(page));
    }
    const snap = s.snapshot();
    expect(snap.phase).toBe('game_over');
    expect(snap.result).toEqual({ winner: null, draw: true });
    expect(snap.board.every((c) => c !== null)).toBe(true);
    expect(snap.moveHistory).toHaveLength(9);
  });

  it('beats a bad human (always plays lowest cell) and reports the win', () => {
    const s = freshGame();
    let page = '.........';
    for (let guard = 0; guard < 20; guard++) {
      const snap = s.snapshot();
      if (snap.phase === 'game_over') break;
      if (snap.phase === 'human_turn') {
        page = place(page, page.indexOf('.'), 'X');
      } else {
        page = place(page, snap.pendingAgentCell!, 'O');
      }
      s.onObservation(obs(page));
    }
    expect(s.snapshot().result?.winner).toBe('O');
  });

  it('starts the next game when a fresh grid appears after game over', () => {
    const s = freshGame();
    let page = '.........';
    while (s.snapshot().phase !== 'game_over') {
      const snap = s.snapshot();
      page =
        snap.phase === 'human_turn'
          ? place(page, page.indexOf('.'), 'X')
          : place(page, snap.pendingAgentCell!, 'O');
      s.onObservation(obs(page));
    }
    s.onObservation(obs(page)); // finished page still in view — stays quiet
    expect(s.snapshot().phase).toBe('game_over');
    const fx = s.onObservation(obs('.........'));
    expect(logTypes(fx)).toContain('game_start');
    expect(s.snapshot().gameNumber).toBe(2);
  });
});

describe('confidence escalation', () => {
  it('asks about a shaky mark and commits it on a confirming answer', () => {
    const s = freshGame();
    const fx = s.onObservation(obs('X........', 0.95, { 0: 0.3 }));
    const ask = asks(fx)[0]?.ask;
    expect(ask).toBeDefined();
    expect(ask?.cell).toBe(0);
    expect(s.snapshot().phase).toBe('awaiting_answer');

    const answered = s.onAnswer(ask!.id, 'X');
    expect(logTypes(answered)).toContain('human_move');
    expect(s.snapshot().phase).toBe('awaiting_agent_mark'); // agent already replied
    expect(s.snapshot().board[0]).toBe('X');
  });

  it('returns to waiting when the answer says the cell is empty', () => {
    const s = freshGame();
    const fx = s.onObservation(obs('X........', 0.95, { 0: 0.3 }));
    const ask = asks(fx)[0]!.ask;
    s.onAnswer(ask.id, 'empty');
    expect(s.snapshot().phase).toBe('human_turn');
    expect(s.snapshot().board[0]).toBeNull();
  });

  it('auto-resolves the question when a later frame is confident', () => {
    const s = freshGame();
    s.onObservation(obs('X........', 0.95, { 0: 0.3 }));
    const fx = s.onObservation(obs('X........')); // ink now legible
    expect(logTypes(fx)).toContain('human_move');
    expect(s.snapshot().phase).toBe('awaiting_agent_mark');
  });

  it('ignores stale answers', () => {
    const s = freshGame();
    expect(s.onAnswer('q99', 'X')).toHaveLength(0);
  });
});

describe('agent mark verification', () => {
  /** Human plays A1; agent replies B2 (center). Returns the session and the page string. */
  function afterAnnounce(): { s: GameSession; page: string } {
    const s = freshGame();
    s.onObservation(obs('X........'));
    expect(s.snapshot().pendingAgentCell).toBe(4);
    return { s, page: 'X........' };
  }

  it('confirms the announced mark and hands the turn back', () => {
    const { s, page } = afterAnnounce();
    const fx = s.onObservation(obs(place(page, 4, 'O')));
    expect(logTypes(fx)).toContain('agent_mark_seen');
    expect(s.snapshot().phase).toBe('human_turn');
  });

  it('adopts a mark drawn in the wrong empty cell, with a spoken correction', () => {
    const { s, page } = afterAnnounce();
    const fx = s.onObservation(obs(place(page, 8, 'O')));
    const correction = says(fx).find((e) => e.category === 'correction');
    expect(correction?.text).toContain(cellName(8));
    expect(s.snapshot().board[8]).toBe('O');
    expect(s.snapshot().board[4]).toBeNull();
    expect(s.snapshot().phase).toBe('human_turn');
  });

  it('accepts agent mark + next human move arriving in one observation', () => {
    const { s, page } = afterAnnounce();
    const both = place(place(page, 4, 'O'), 2, 'X');
    const fx = s.onObservation(obs(both));
    expect(s.snapshot().moveHistory.map((m) => m.cell)).toEqual([0, 4, 2]);
    // Agent immediately announced its next move.
    expect(s.snapshot().phase).toBe('awaiting_agent_mark');
    expect(logTypes(fx)).toContain('agent_move');
  });

  it('reminds (once) when the human plays before drawing the agent mark', () => {
    const { s, page } = afterAnnounce();
    const jumped = place(page, 2, 'X');
    const fx = s.onObservation(obs(jumped));
    expect(says(fx)[0]?.text).toContain('B2');
    expect(s.onObservation(obs(jumped))).toHaveLength(0); // no nagging
    // Once the agent mark lands too, both moves are absorbed.
    s.onObservation(obs(place(jumped, 4, 'O')));
    expect(s.snapshot().moveHistory.map((m) => m.cell)).toEqual([0, 4, 2]);
  });

  it('declares corruption when the human symbol lands in the announced cell', () => {
    const { s, page } = afterAnnounce();
    const fx = s.onObservation(obs(place(page, 4, 'X')));
    expect(s.snapshot().phase).toBe('corrupted');
    expect(says(fx).some((e) => e.category === 'warning')).toBe(true);
    // Recovery: a fresh grid starts a new game.
    const fresh = s.onObservation(obs('.........'));
    expect(logTypes(fresh)).toContain('game_start');
  });
});

describe('ink-is-truth anomalies', () => {
  it('corrupts on two simultaneous confident human marks', () => {
    const s = freshGame();
    s.onObservation(obs('X..X.....'));
    expect(s.snapshot().phase).toBe('corrupted');
  });

  it('corrupts when a committed mark confidently changes symbol', () => {
    const s = freshGame();
    s.onObservation(obs('X........'));        // human A1
    s.onObservation(obs('X...O....'));        // agent B2 drawn
    s.onObservation(obs('O...O....'));        // A1 now reads O?!
    expect(s.snapshot().phase).toBe('corrupted');
  });

  it('asks instead when the changed mark is low-confidence', () => {
    const s = freshGame();
    s.onObservation(obs('X........'));
    s.onObservation(obs('X...O....'));
    const fx = s.onObservation(obs('O...O....', 0.95, { 0: 0.2 }));
    expect(asks(fx)).toHaveLength(1);
    // Answering with the original symbol restores normal play.
    s.onAnswer(asks(fx)[0]!.ask.id, 'X');
    expect(s.snapshot().phase).toBe('human_turn');
  });
});

describe('page loss and resync', () => {
  it('re-locks silently when the page returns unchanged', () => {
    const s = freshGame();
    s.onObservation(obs('X........'));
    s.onObservation(obs('X...O....')); // agent mark confirmed, human turn
    const lost = s.onObservation({ kind: 'no_paper' });
    expect(says(lost)).toHaveLength(1);
    const relock = s.onObservation(obs('X...O....'));
    expect(logTypes(relock)).toContain('relock');
    expect(s.snapshot().phase).toBe('human_turn');
  });

  it('absorbs a mark drawn while the page was out of sight', () => {
    const s = freshGame();
    s.onObservation(obs('X........'));
    s.onObservation(obs('X...O....'));
    s.onObservation({ kind: 'no_paper' });
    s.onObservation(obs('X.X.O....')); // human played while page was away
    expect(s.snapshot().moveHistory.map((m) => m.cell)).toEqual([0, 4, 2]);
    expect(s.snapshot().phase).toBe('awaiting_agent_mark');
  });

  it('adopts a legal in-progress board after a fresh start (process restart story)', () => {
    const s = new GameSession();
    const fx = s.onObservation(obs('X........'));
    expect(logTypes(fx)).toContain('adopt');
    // X already moved, so it is the agent's turn and it announces.
    expect(s.snapshot().phase).toBe('awaiting_agent_mark');
  });

  it('adopts a finished board as a finished game', () => {
    const s = new GameSession();
    s.onObservation(obs('XXXOO....'));
    expect(s.snapshot().phase).toBe('game_over');
    expect(s.snapshot().result?.winner).toBe('X');
  });

  it('rejects an impossible board', () => {
    const s = new GameSession();
    s.onObservation(obs('XX.......')); // X moved twice, no O anywhere
    expect(s.snapshot().phase).toBe('corrupted');
  });
});

describe('controls', () => {
  it('new_game waits for a fresh grid, then starts', () => {
    const s = freshGame();
    s.onObservation(obs('X........'));
    s.onControl('new_game');
    expect(s.snapshot().phase).toBe('game_over');
    s.onObservation(obs('X...O....')); // old page still visible — ignored
    expect(s.snapshot().phase).toBe('game_over');
    s.onObservation(obs('.........'));
    expect(s.snapshot().phase).toBe('human_turn');
    expect(s.snapshot().gameNumber).toBe(2);
  });
});
