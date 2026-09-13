/** 8-bit grayscale image, row-major. */
export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Paper corners ordered TL, TR, BR, BL in source-frame coordinates. */
export type Quad = [Point, Point, Point, Point];

/**
 * Cell boundaries in rectified-board coordinates: xs/ys hold the four
 * boundary lines (outer, inner, inner, outer), so cell (row, col) spans
 * xs[col]..xs[col+1] × ys[row]..ys[row+1].
 */
export interface GridGeometry {
  xs: [number, number, number, number];
  ys: [number, number, number, number];
}

/** Side length of the canonical rectified board image. */
export const RECT_SIZE = 600;

export type FrameAnalysis =
  | { kind: 'no_paper' }
  | { kind: 'no_grid'; quad: Quad }
  | { kind: 'grid'; quad: Quad; rectified: GrayImage; grid: GridGeometry };

export function makeGray(width: number, height: number, fill = 0): GrayImage {
  return { data: new Uint8Array(width * height).fill(fill), width, height };
}
