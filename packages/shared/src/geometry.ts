/** 2-D point in source-frame pixels. */
export interface Point {
  x: number;
  y: number;
}

/** Corners ordered TL, TR, BR, BL. */
export type Quad = [Point, Point, Point, Point];
