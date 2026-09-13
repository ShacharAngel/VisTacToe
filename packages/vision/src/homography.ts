import type { Point, Quad } from './types.js';

/** Row-major 3×3 projective transform. */
export type Homography = [number, number, number, number, number, number, number, number, number];

/**
 * Direct linear transform: solve the 8-DOF homography mapping each src point
 * to its dst counterpart. Used by the synthetic renderer and geometry tests —
 * the live pipeline uses OpenCV's getPerspectiveTransform, so the two
 * implementations cross-check each other.
 */
export function homographyFromPoints(src: readonly Point[], dst: readonly Point[]): Homography {
  if (src.length !== 4 || dst.length !== 4) throw new Error('need exactly 4 point pairs');
  // Build the 8×9 system [A | b].
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!;
    const { x: u, y: v } = dst[i]!;
    m.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    m.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) throw new Error('degenerate quad');
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c < 9; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  const h = new Array<number>(8);
  for (let i = 0; i < 8; i++) h[i] = m[i]![8]! / m[i]![i]!;
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

export function applyHomography(h: Homography, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

/** Homography mapping the unit square (0,0)-(1,1) onto the quad. */
export function unitSquareToQuad(quad: Quad): Homography {
  const unit: Point[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  return homographyFromPoints(unit, quad);
}

/** Homography mapping the quad onto the unit square. */
export function quadToUnitSquare(quad: Quad): Homography {
  const unit: Point[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  return homographyFromPoints(quad, unit);
}
