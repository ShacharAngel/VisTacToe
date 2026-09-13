import { beforeAll, describe, expect, it } from 'vitest';
import type { Observation } from '@vistactoe/shared';
import { BoardWatcher, createAnalyzer, synthetic, type Analyzer, type GrayImage } from '@vistactoe/vision';

const { renderPaper, renderScene, defaultQuad, occlude } = synthetic;

let analyzer: Analyzer;

beforeAll(async () => {
  analyzer = await createAnalyzer();
}, 30_000);

/** A camera frame of the given board; noiseSeed varies per frame like a real sensor. */
function frame(marks: string, noiseSeed: number): GrayImage {
  return renderScene({ quad: defaultQuad(), paper: renderPaper({ marks, seed: 7 }), seed: noiseSeed });
}

function watcher(overrides?: ConstructorParameters<typeof BoardWatcher>[1]): BoardWatcher {
  return new BoardWatcher(analyzer, { stillFrames: 3, pageLostFrames: 5, ...overrides });
}

function feed(w: BoardWatcher, frames: GrayImage[]): (Observation | null)[] {
  return frames.map((f) => w.processFrame(f));
}

function labels(obs: Observation | null): string {
  if (obs?.kind !== 'board') throw new Error(`expected board observation, got ${obs?.kind}`);
  return obs.cells.map((c) => (c.label === 'empty' ? '.' : c.label)).join('');
}

describe('BoardWatcher', () => {
  it('settles on a stable empty grid and reports it exactly once', () => {
    const w = watcher();
    const results = feed(w, [1, 2, 3, 4, 5, 6, 7].map((s) => frame('.........', s)));
    const boards = results.filter((r) => r?.kind === 'board');
    expect(boards).toHaveLength(1);
    expect(labels(boards[0]!)).toBe('.........');
    // Later identical frames stay quiet.
    expect(results.slice(4).every((r) => r === null)).toBe(true);
  });

  it('holds while a hand covers the board, then reports the new mark', () => {
    const w = watcher();
    feed(w, [1, 2, 3, 4].map((s) => frame('.........', s)));

    // Hand comes in over the center of the paper for a few frames.
    for (let s = 10; s < 14; s++) {
      const f = occlude(frame('.........', s), 320, 240, 90);
      expect(w.processFrame(f)?.kind ?? 'quiet').toMatch(/unstable|quiet/);
    }
    // Hand leaves; an X is now in the top-left cell. Needs stillFrames to settle.
    const after = feed(w, [20, 21, 22, 23].map((s) => frame('X........', s)));
    const board = after.find((r) => r?.kind === 'board');
    expect(board).toBeDefined();
    expect(labels(board!)).toBe('X........');
  });

  it('reads a full mid-game board correctly with confidence', () => {
    const w = watcher();
    const results = feed(w, [1, 2, 3, 4].map((s) => frame('XOX.OX.O.', s)));
    const board = results.find((r) => r?.kind === 'board');
    expect(labels(board!)).toBe('XOX.OX.O.');
    if (board?.kind === 'board') {
      for (const cell of board.cells) {
        expect(cell.confidence).toBeGreaterThan(0.55);
      }
    }
  });

  it('treats a brief paper loss as instability, not a lost page', () => {
    const w = watcher();
    feed(w, [1, 2, 3, 4].map((s) => frame('.........', s)));
    // Three paperless frames — hand blocking the view entirely.
    const results = feed(w, [30, 31, 32].map((s) => renderScene({ seed: s })));
    expect(results.every((r) => r?.kind === 'unstable')).toBe(true);
  });

  it('reports a lost page after a sustained absence, exactly once (no per-frame spam)', () => {
    const w = watcher({ pageLostFrames: 4 });
    feed(w, [1, 2, 3, 4].map((s) => frame('.........', s)));
    // Ten paperless frames: the page-lost prompt must fire a single time.
    const results = feed(w, Array.from({ length: 10 }, (_, i) => renderScene({ seed: 40 + i })));
    const lost = results.filter((r) => r?.kind === 'no_paper');
    expect(lost).toHaveLength(1);
    expect(results.filter((r) => r?.kind === 'no_grid')).toHaveLength(0);
  });

  it('reports no_grid for a sustained blank page', () => {
    const w = watcher({ pageLostFrames: 4 });
    const blank = (s: number) => renderScene({ quad: defaultQuad(), paper: renderPaper({ grid: false, seed: 3 }), seed: s });
    const results = feed(w, [50, 51, 52, 53, 54].map(blank));
    expect(results.some((r) => r?.kind === 'no_grid')).toBe(true);
  });

  it('does not spam prompts while the page is being aligned (quad flickering in and out)', () => {
    const w = watcher({ pageLostFrames: 6, pageChangeFrames: 12 });
    const blank = (s: number) => renderScene({ quad: defaultQuad(), paper: renderPaper({ grid: false, seed: 3 }), seed: s });
    const gone = (s: number) => renderScene({ seed: s });

    // Fumbling: page out, page in (no grid), page out, … as it's positioned,
    // never settling into either state long enough to be a real change.
    const results: (Observation | null)[] = [];
    for (let i = 0; i < 40; i++) {
      results.push(w.processFrame(i % 4 < 2 ? gone(200 + i) : blank(200 + i)));
    }
    // The debounce means at most the single initial announcement gets through.
    const prompts = results.filter((r) => r?.kind === 'no_paper' || r?.kind === 'no_grid');
    expect(prompts.length).toBeLessThanOrEqual(1);
  });

  it('announces a settled state change (paper put down, still no grid) once', () => {
    const w = watcher({ pageLostFrames: 4, pageChangeFrames: 4 });
    const gone = (s: number) => renderScene({ seed: s });
    const blank = (s: number) => renderScene({ quad: defaultQuad(), paper: renderPaper({ grid: false, seed: 3 }), seed: s });

    // Page absent for a while → "no paper", then the blank sheet settles → "no grid".
    const away = feed(w, Array.from({ length: 6 }, (_, i) => gone(300 + i)));
    const settled = feed(w, Array.from({ length: 8 }, (_, i) => blank(320 + i)));
    expect(away.filter((r) => r?.kind === 'no_paper')).toHaveLength(1);
    expect(settled.filter((r) => r?.kind === 'no_grid')).toHaveLength(1);
  });
});
