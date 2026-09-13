import type { CellLabel, CellReading } from '@vistactoe/shared';
import type { GrayImage, GridGeometry } from './types.js';

/**
 * Classical X/O/empty classifier on a binarized cell crop. No model anywhere:
 * an O is a ring (an enclosed hole, ink at a consistent radius, empty center),
 * an X is two crossing strokes (ink hugging the diagonals, ink at the center,
 * no hole). Confidence is the margin between the two shape scores, so a scrawl
 * that fits neither reads as low-confidence and escalates upstream.
 */

export interface CellFeatures {
  inkFraction: number;
  holes: number;
  ringDeviation: number;
  centerInk: number;
  diagDeviation: number;
  borderFraction: number;
  xScore: number;
  oScore: number;
}

export interface CellClassification extends CellReading {
  features: CellFeatures;
}

/** Fraction of each cell trimmed on every side so grid-line ink stays out. */
export const CELL_INSET = 0.15;
const EMPTY_INK_FRACTION = 0.01;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function classifyCells(ink: GrayImage, grid: GridGeometry): CellClassification[] {
  const cells: CellClassification[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      cells.push(classifyCell(cropCell(ink, grid, row, col)));
    }
  }
  return cells;
}

export function cropCell(ink: GrayImage, grid: GridGeometry, row: number, col: number, inset = CELL_INSET): GrayImage {
  const x0 = grid.xs[col]!;
  const x1 = grid.xs[col + 1]!;
  const y0 = grid.ys[row]!;
  const y1 = grid.ys[row + 1]!;
  const insetX = (x1 - x0) * inset;
  const insetY = (y1 - y0) * inset;
  const left = Math.max(0, Math.round(x0 + insetX));
  const right = Math.min(ink.width, Math.round(x1 - insetX));
  const top = Math.max(0, Math.round(y0 + insetY));
  const bottom = Math.min(ink.height, Math.round(y1 - insetY));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = ink.data[(top + y) * ink.width + (left + x)]!;
    }
  }
  return { data, width, height };
}

export function classifyCell(crop: GrayImage): CellClassification {
  const { data, width, height } = crop;
  const area = width * height;

  let inkCount = 0;
  let bx0 = width;
  let bx1 = -1;
  let by0 = height;
  let by1 = -1;
  let borderInk = 0;
  const borderBand = Math.max(2, Math.round(Math.min(width, height) * 0.12));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!data[y * width + x]) continue;
      inkCount++;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
      if (x < borderBand || y < borderBand || x >= width - borderBand || y >= height - borderBand) borderInk++;
    }
  }
  const inkFraction = inkCount / area;
  const borderFraction = inkCount > 0 ? borderInk / inkCount : 0;

  const emptyFeatures = (partial?: Partial<CellFeatures>): CellFeatures => ({
    inkFraction,
    holes: 0,
    ringDeviation: 0,
    centerInk: 0,
    diagDeviation: 0,
    borderFraction,
    xScore: 0,
    oScore: 0,
    ...partial,
  });

  if (inkFraction < EMPTY_INK_FRACTION) {
    const confidence = clamp01(0.99 - (inkFraction / EMPTY_INK_FRACTION) * 0.45);
    return { label: 'empty', confidence, features: emptyFeatures() };
  }
  // Ink that is almost entirely hugging the crop border is grid-line bleed,
  // not a mark (a real mark lives in the middle of the cell).
  if (borderFraction > 0.85 && inkFraction < 0.05) {
    return { label: 'empty', confidence: 0.7, features: emptyFeatures() };
  }

  const cx = (bx0 + bx1) / 2;
  const cy = (by0 + by1) / 2;
  const halfW = Math.max(1, (bx1 - bx0) / 2);
  const halfH = Math.max(1, (by1 - by0) / 2);

  // Radial statistics around the ink centroid-box center.
  let radiusSum = 0;
  const radii: number[] = [];
  let diagDistSum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!data[y * width + x]) continue;
      // Normalized coordinates in the ink bounding box, [-1, 1].
      const nx = (x - cx) / halfW;
      const ny = (y - cy) / halfH;
      const r = Math.hypot(nx, ny);
      radii.push(r);
      radiusSum += r;
      // Distance to the nearer of the two diagonals (which are y=±x in normalized space).
      diagDistSum += Math.min(Math.abs(nx - ny), Math.abs(nx + ny)) / Math.SQRT2;
    }
  }
  const meanRadius = radiusSum / inkCount;
  let ringDevSum = 0;
  let centerCount = 0;
  for (const r of radii) {
    ringDevSum += Math.abs(r - meanRadius);
    if (r < meanRadius * 0.45) centerCount++;
  }
  const ringDeviation = meanRadius > 0 ? ringDevSum / inkCount / meanRadius : 1;
  const centerInk = centerCount / inkCount;
  const diagDeviation = diagDistSum / inkCount;

  const holes = countEnclosedHoles(crop, Math.max(12, Math.round(area * 0.003)));

  const oScore =
    0.45 * (holes > 0 ? 1 : 0) + 0.3 * clamp01(1 - ringDeviation * 2.5) + 0.25 * clamp01(1 - centerInk * 4);
  const xScore =
    0.45 * clamp01(1 - diagDeviation * 3) + 0.3 * clamp01(centerInk * 4) + 0.25 * (holes === 0 ? 1 : 0);

  const label: CellLabel = oScore >= xScore ? 'O' : 'X';
  let confidence = clamp01(0.5 + Math.abs(oScore - xScore) * 0.9);
  if (inkFraction < 0.025) confidence *= 0.8; // faint mark — trust it less
  confidence = Math.min(confidence, 0.99);

  return {
    label,
    confidence,
    features: emptyFeatures({ holes, ringDeviation, centerInk, diagDeviation, xScore, oScore }),
  };
}

/**
 * Count background regions not reachable from the crop border (flood fill over
 * non-ink pixels): a closed O encloses exactly one.
 */
function countEnclosedHoles(crop: GrayImage, minSize: number): number {
  const { data, width, height } = crop;
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);

  const flood = (start: number): number => {
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let size = 0;
    while (head < tail) {
      const idx = queue[head++]!;
      size++;
      const x = idx % width;
      const y = (idx / width) | 0;
      if (x > 0) tryVisit(idx - 1);
      if (x < width - 1) tryVisit(idx + 1);
      if (y > 0) tryVisit(idx - width);
      if (y < height - 1) tryVisit(idx + width);
    }
    return size;

    function tryVisit(idx: number): void {
      if (!visited[idx] && !data[idx]) {
        visited[idx] = 1;
        queue[tail++] = idx;
      }
    }
  };

  // Everything reachable from the border is outside.
  for (let x = 0; x < width; x++) {
    for (const y of [0, height - 1]) {
      const idx = y * width + x;
      if (!data[idx] && !visited[idx]) flood(idx);
    }
  }
  for (let y = 0; y < height; y++) {
    for (const x of [0, width - 1]) {
      const idx = y * width + x;
      if (!data[idx] && !visited[idx]) flood(idx);
    }
  }

  let holes = 0;
  for (let idx = 0; idx < data.length; idx++) {
    if (!data[idx] && !visited[idx]) {
      if (flood(idx) >= minSize) holes++;
    }
  }
  return holes;
}
