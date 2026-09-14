import type { Observation } from '@vistactoe/shared';
import type { Analyzer } from './acquire.js';
import { classifyCells } from './classify.js';
import type { GrayImage, GridGeometry, Quad } from './types.js';

export interface WatcherConfig {
  /** Consecutive still frames before the board is read. */
  stillFrames: number;
  /** Fraction of changed raw pixels above which the scene counts as moving. */
  motionThreshold: number;
  /** Consecutive paper-less frames before reporting the page as lost (brief occlusions stay "unstable"). */
  pageLostFrames: number;
  /**
   * Once a lost state is announced, a *different* lost state must persist this
   * many consecutive frames before it is announced too. Stops the setup /
   * teardown phase (paper being aligned or removed) from flapping between
   * "show me the page" and "draw a grid" as the quad flickers in and out.
   */
  pageChangeFrames: number;
  /** Ink pixels that must appear/disappear (beyond jitter tolerance) to re-report the board. */
  changedInkPixels: number;
  /** Spatial tolerance in pixels when comparing ink masks (absorbs quad jitter). */
  inkTolerancePx: number;
  /** Consecutive identical classifications required before a board is reported. */
  agreeFrames: number;
}

export const defaultWatcherConfig: WatcherConfig = {
  stillFrames: 4,
  motionThreshold: 0.02,
  pageLostFrames: 12,
  pageChangeFrames: 12, // ~2.4s of a settled new state before re-announcing
  // A real pen mark contributes well over a thousand mask pixels; residual
  // speckle and quad jitter stay in the low hundreds.
  changedInkPixels: 250,
  inkTolerancePx: 5,
  // A single classification pass can misread (a shadow settles into an "X");
  // two independent sensor frames must agree before a board is believed.
  agreeFrames: 2,
};

/** Gray-level delta above which a pixel counts as changed between raw frames. */
const PIXEL_DELTA = 28;

/**
 * Temporal side of perception: gates on motion (a hand in frame), waits for
 * the scene to settle, and reports a classified board only when the ink
 * actually changed since the last report. Expensive work (classification)
 * therefore runs roughly once per move, not per frame.
 */
export class BoardWatcher {
  private readonly config: WatcherConfig;
  private prevFrame: GrayImage | null = null;
  private stillCount = 0;
  private lostCount = 0;
  /** The lost kind we last announced (cleared on recovery), so we never repeat it back-to-back. */
  private lastLostKind: 'no_paper' | 'no_grid' | null = null;
  /** A candidate new lost kind and how long it has persisted, for debouncing state changes. */
  private lostCandidate: { kind: 'no_paper' | 'no_grid'; count: number } | null = null;
  private lastReportedInk: GrayImage | null = null;
  /** Classification awaiting corroboration: label string + how many consecutive frames agreed. */
  private boardCandidate: { key: string; count: number } | null = null;
  /** Freshest rectified view + geometry, for escalation crops (VLM / debugging). */
  lastBoard: { rectified: GrayImage; grid: GridGeometry } | null = null;
  /** Freshest frame-space geometry for client overlays; null while no paper is in view. */
  lastGeometry: { quad: Quad; grid: GridGeometry | null } | null = null;

  constructor(
    private readonly analyzer: Analyzer,
    config?: Partial<WatcherConfig>,
  ) {
    this.config = { ...defaultWatcherConfig, ...config };
  }

  /** Returns an observation worth telling the session about, or null. */
  processFrame(frame: GrayImage): Observation | null {
    const analysis = this.analyzer.analyzeFrame(frame);
    // Honest per-frame data: nulls out during occlusion, no smoothing — the
    // overlay client applies its own grace period.
    this.lastGeometry =
      analysis.kind === 'no_paper'
        ? null
        : { quad: analysis.quad, grid: analysis.kind === 'grid' ? analysis.grid : null };

    if (analysis.kind !== 'grid') {
      this.stillCount = 0;
      this.boardCandidate = null;
      this.prevFrame = frame;
      this.lostCount++;
      // A hand crossing the paper edge breaks the quad for a few frames —
      // that is motion, not a lost page.
      if (this.lostCount < this.config.pageLostFrames) return { kind: 'unstable' };

      // A sustained loss invalidates the ink memory: when the page returns —
      // even the very same paper — the board must re-report so the session
      // can relock instead of waiting forever for an ink change.
      this.lastReportedInk = null;

      const kind = analysis.kind;
      if (this.lastLostKind === null) {
        // First announcement of this lost episode — say it right away.
        this.lastLostKind = kind;
        this.lostCandidate = null;
        return { kind };
      }
      if (kind === this.lastLostKind) {
        this.lostCandidate = null; // still the same state — stay quiet
        return { kind: 'unstable' };
      }
      // A different lost state — only announce once it has settled, so the page
      // being aligned or removed doesn't flap between the two prompts.
      this.lostCandidate =
        this.lostCandidate?.kind === kind ? { kind, count: this.lostCandidate.count + 1 } : { kind, count: 1 };
      if (this.lostCandidate.count < this.config.pageChangeFrames) return { kind: 'unstable' };
      this.lastLostKind = kind;
      this.lostCandidate = null;
      return { kind };
    }
    this.lostCount = 0;
    this.lastLostKind = null; // recovered — a genuine future loss is worth announcing again
    this.lostCandidate = null;
    this.lastBoard = { rectified: analysis.rectified, grid: analysis.grid };

    const moving = this.prevFrame ? diffFraction(frame, this.prevFrame) > this.config.motionThreshold : true;
    this.prevFrame = frame;
    if (moving) {
      this.stillCount = 0;
      this.boardCandidate = null;
      return { kind: 'unstable' };
    }

    this.stillCount++;
    // Classification starts agreeFrames-1 frames before the stillness bar, so
    // the corroborated report lands on the same frame a single read used to.
    if (this.stillCount + this.config.agreeFrames - 1 < this.config.stillFrames) return null;

    const ink = this.analyzer.inkMask(analysis.rectified);
    if (this.lastReportedInk && !this.inkChanged(ink, this.lastReportedInk)) {
      this.boardCandidate = null;
      return null;
    }

    // One pass can misread (noise, a shadow, a hand's last blur): require
    // agreeFrames consecutive identical label sets before believing the board.
    const cells = classifyCells(ink, analysis.grid);
    const key = cells.map((c) => c.label).join(',');
    this.boardCandidate =
      this.boardCandidate?.key === key ? { key, count: this.boardCandidate.count + 1 } : { key, count: 1 };
    if (this.boardCandidate.count < this.config.agreeFrames || this.stillCount < this.config.stillFrames) return null;

    this.boardCandidate = null;
    this.lastReportedInk = ink;
    return { kind: 'board', cells, observedAt: Date.now() };
  }

  /** Symmetric ink comparison with spatial tolerance, so quad jitter of a few pixels stays silent. */
  private inkChanged(a: GrayImage, b: GrayImage): boolean {
    const tolerance = this.config.inkTolerancePx;
    const appeared = inkOutsideDilated(a, b, tolerance);
    if (appeared > this.config.changedInkPixels) return true;
    const disappeared = inkOutsideDilated(b, a, tolerance);
    return appeared + disappeared > this.config.changedInkPixels;
  }
}

function diffFraction(a: GrayImage, b: GrayImage): number {
  let changed = 0;
  const n = Math.min(a.data.length, b.data.length);
  for (let i = 0; i < n; i++) {
    if (Math.abs(a.data[i]! - b.data[i]!) > PIXEL_DELTA) changed++;
  }
  return changed / n;
}

/** Count ink pixels of `img` farther than `tolerance` (city-block) from any ink in `reference`. */
function inkOutsideDilated(img: GrayImage, reference: GrayImage, tolerance: number): number {
  const dist = manhattanDistance(reference);
  let count = 0;
  for (let i = 0; i < img.data.length; i++) {
    if (img.data[i] && dist[i]! > tolerance) count++;
  }
  return count;
}

/** Two-pass city-block distance transform to the nearest ink pixel. */
function manhattanDistance(img: GrayImage): Int32Array {
  const { data, width, height } = img;
  const INF = width + height;
  const dist = new Int32Array(width * height).fill(INF);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (data[i]) {
        dist[i] = 0;
        continue;
      }
      let best = INF;
      if (x > 0) best = Math.min(best, dist[i - 1]! + 1);
      if (y > 0) best = Math.min(best, dist[i - width]! + 1);
      dist[i] = best;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let best = dist[i]!;
      if (x < width - 1) best = Math.min(best, dist[i + 1]! + 1);
      if (y < height - 1) best = Math.min(best, dist[i + width]! + 1);
      dist[i] = best;
    }
  }
  return dist;
}
