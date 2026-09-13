import { beforeAll, describe, expect, it } from 'vitest';
import {
  createAnalyzer,
  RECT_SIZE,
  synthetic,
  type Analyzer,
  type FrameAnalysis,
  type Quad,
} from '@vistactoe/vision';

const { renderPaper, renderScene, defaultQuad, paperGridBoundaries } = synthetic;

let analyzer: Analyzer;

beforeAll(async () => {
  analyzer = await createAnalyzer();
}, 30_000);

function gridScene(marks = '.........', quad: Quad = defaultQuad(), gridSpan = 0.8, seed = 1): ReturnType<typeof renderScene> {
  const paper = renderPaper({ marks, gridSpan, seed });
  return renderScene({ quad, paper, seed: seed + 100 });
}

function expectQuadClose(actual: Quad, expected: Quad, tolerance = 8): void {
  for (let i = 0; i < 4; i++) {
    expect(Math.hypot(actual[i]!.x - expected[i]!.x, actual[i]!.y - expected[i]!.y)).toBeLessThan(tolerance);
  }
}

describe('paper detection', () => {
  it('reports no paper on an empty scene', () => {
    const frame = renderScene({});
    expect(analyzer.analyzeFrame(frame).kind).toBe('no_paper');
  });

  it('finds a blank page but no grid, with accurate corners', () => {
    const quad = defaultQuad();
    const frame = renderScene({ quad, paper: renderPaper({ grid: false }) });
    const result = analyzer.analyzeFrame(frame);
    expect(result.kind).toBe('no_grid');
    expectQuadClose((result as Extract<FrameAnalysis, { kind: 'no_grid' }>).quad, quad);
  });

  it('never throws on pathological frames (degenerate shapes must not crash the pipeline)', () => {
    // A high-contrast thin bright strip is the kind of odd contour whose quad
    // fit can collapse; analyzeFrame must degrade to no_paper, not throw.
    const strip = renderScene({});
    for (let y = 0; y < strip.height; y++) {
      for (let x = 300; x < 306; x++) strip.data[y * strip.width + x] = 255;
    }
    expect(() => analyzer.analyzeFrame(strip)).not.toThrow();

    const noise = renderScene({ noiseSigma: 90 });
    expect(() => analyzer.analyzeFrame(noise)).not.toThrow();
  });
});

describe('grid detection', () => {
  it('locates an empty grid and its cell boundaries', () => {
    const result = analyzer.analyzeFrame(gridScene());
    expect(result.kind).toBe('grid');
    const { grid } = result as Extract<FrameAnalysis, { kind: 'grid' }>;
    const truth = paperGridBoundaries(0.8);
    // Interior lines must land close to ground truth (rectified space).
    expect(Math.abs(grid.xs[1] - truth.xs[1]!)).toBeLessThan(12);
    expect(Math.abs(grid.xs[2] - truth.xs[2]!)).toBeLessThan(12);
    expect(Math.abs(grid.ys[1] - truth.ys[1]!)).toBeLessThan(12);
    expect(Math.abs(grid.ys[2] - truth.ys[2]!)).toBeLessThan(12);
    // Outer boundaries are extrapolated: near the grid edges, within a cell's slack.
    expect(Math.abs(grid.xs[0] - truth.xs[0]!)).toBeLessThan(40);
    expect(Math.abs(grid.xs[3] - truth.xs[3]!)).toBeLessThan(40);
  });

  it('still finds the grid when marks are on the board', () => {
    const result = analyzer.analyzeFrame(gridScene('XOX.OX.O.'));
    expect(result.kind).toBe('grid');
  });

  it('survives a strong perspective angle', () => {
    const angled: Quad = [
      { x: 200, y: 90 },
      { x: 560, y: 40 },
      { x: 600, y: 430 },
      { x: 150, y: 380 },
    ];
    const result = analyzer.analyzeFrame(gridScene('X...O....', angled));
    expect(result.kind).toBe('grid');
  });

  it('finds a smaller grid that does not fill the page', () => {
    const result = analyzer.analyzeFrame(gridScene('.........', defaultQuad(), 0.55));
    expect(result.kind).toBe('grid');
  });

  it('does not hallucinate a grid from marks alone', () => {
    // Marks on a gridless page must not read as a grid.
    const paper = renderPaper({ grid: false, marks: 'X...O....' });
    const frame = renderScene({ quad: defaultQuad(), paper });
    expect(analyzer.analyzeFrame(frame).kind).toBe('no_grid');
  });

  it('is deterministic for a fixed seed', () => {
    const a = analyzer.analyzeFrame(gridScene('X........'));
    const b = analyzer.analyzeFrame(gridScene('X........'));
    expect(a).toEqual(b);
  });
});

describe('rectification geometry', () => {
  it('maps the paper into the full canonical square', () => {
    const quad = defaultQuad();
    const frame = renderScene({ quad, paper: renderPaper({}) });
    const analysis = analyzer.analyzeFrame(frame);
    expect(analysis.kind).toBe('grid');
    const { rectified } = analysis as Extract<FrameAnalysis, { kind: 'grid' }>;
    expect(rectified.width).toBe(RECT_SIZE);
    expect(rectified.height).toBe(RECT_SIZE);
    // Rectified center should be bright paper, corners too (paper fills the warp).
    const at = (x: number, y: number) => rectified.data[y * RECT_SIZE + x]!;
    expect(at(RECT_SIZE / 2, RECT_SIZE / 2)).toBeGreaterThan(180);
    expect(at(20, 20)).toBeGreaterThan(150);
    expect(at(RECT_SIZE - 20, RECT_SIZE - 20)).toBeGreaterThan(150);
  });
});
