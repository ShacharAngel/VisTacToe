import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAnalyzer, decodeToGray, type Analyzer } from '@vistactoe/vision';

// A real webcam capture: white A4 on a dark table with a tilted, wavy,
// hand-drawn 3×3 grid whose lines run to the paper edges — the exact case that
// broke the original notch-sensitive quad fitter and the projection-profile
// grid detector. Regression guard for the convex-hull + Hough rewrite.
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/real-grid-empty.png');

let analyzer: Analyzer;

beforeAll(async () => {
  analyzer = await createAnalyzer();
}, 30_000);

describe('real captured frame', () => {
  it('locks the paper and the hand-drawn grid', async () => {
    const frame = await decodeToGray(readFileSync(FIXTURE));
    const analysis = analyzer.analyzeFrame(frame);
    expect(analysis.kind).toBe('grid');
    if (analysis.kind !== 'grid') return;

    const { xs, ys } = analysis.grid;
    // Boundaries strictly increasing (ordered, non-degenerate).
    for (let i = 0; i < 3; i++) {
      expect(xs[i + 1]!).toBeGreaterThan(xs[i]!);
      expect(ys[i + 1]!).toBeGreaterThan(ys[i]!);
    }
    // The middle column and row are a meaningful fraction of the board.
    expect(xs[2]! - xs[1]!).toBeGreaterThan(100);
    expect(ys[2]! - ys[1]!).toBeGreaterThan(100);
  });
});
