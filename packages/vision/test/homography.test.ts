import { describe, expect, it } from 'vitest';
import {
  applyHomography,
  projectCellQuads,
  quadToUnitSquare,
  RECT_SIZE,
  synthetic,
  type GridGeometry,
  type Point,
  type Quad,
} from '@vistactoe/vision';

const { defaultQuad } = synthetic;

const fullGrid: GridGeometry = { xs: [0, 200, 400, 600], ys: [0, 200, 400, 600] };

function expectPointClose(actual: Point, expected: Point, tolerance = 1e-6): void {
  expect(Math.hypot(actual.x - expected.x, actual.y - expected.y)).toBeLessThan(tolerance);
}

describe('projectCellQuads', () => {
  it('partitions an axis-aligned rectangle into an even 3×3 grid', () => {
    const quad: Quad = [
      { x: 40, y: 30 },
      { x: 520, y: 30 },
      { x: 520, y: 390 },
      { x: 40, y: 390 },
    ];
    const cells = projectCellQuads(quad, fullGrid);
    expect(cells).toHaveLength(9);
    const w = 480 / 3;
    const h = 360 / 3;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const cell = cells[row * 3 + col]!;
        expectPointClose(cell[0], { x: 40 + col * w, y: 30 + row * h });
        expectPointClose(cell[1], { x: 40 + (col + 1) * w, y: 30 + row * h });
        expectPointClose(cell[2], { x: 40 + (col + 1) * w, y: 30 + (row + 1) * h });
        expectPointClose(cell[3], { x: 40 + col * w, y: 30 + (row + 1) * h });
      }
    }
  });

  it('pins outer corners to the paper quad under perspective', () => {
    const quad = defaultQuad();
    const cells = projectCellQuads(quad, fullGrid);
    expectPointClose(cells[0]![0], quad[0]); // cell A1 TL = paper TL
    expectPointClose(cells[2]![1], quad[1]); // cell C1 TR = paper TR
    expectPointClose(cells[8]![2], quad[2]); // cell C3 BR = paper BR
    expectPointClose(cells[6]![3], quad[3]); // cell A3 BL = paper BL
  });

  it('makes neighboring cells share their seam exactly', () => {
    const cells = projectCellQuads(defaultQuad(), fullGrid);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 2; col++) {
        const left = cells[row * 3 + col]!;
        const right = cells[row * 3 + col + 1]!;
        expectPointClose(left[1], right[0]);
        expectPointClose(left[2], right[3]);
      }
    }
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const top = cells[row * 3 + col]!;
        const bottom = cells[(row + 1) * 3 + col]!;
        expectPointClose(top[3], bottom[0]);
        expectPointClose(top[2], bottom[1]);
      }
    }
  });

  it('round-trips corners back to rectified coordinates for an uneven grid', () => {
    // Uneven boundaries catch row/col or x/y mix-ups an even grid would hide.
    const grid: GridGeometry = { xs: [60, 230, 400, 540], ys: [45, 250, 380, 590] };
    const quad = defaultQuad();
    const inverse = quadToUnitSquare(quad);
    const cells = projectCellQuads(quad, grid);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const cell = cells[row * 3 + col]!;
        const unit = applyHomography(inverse, cell[0]);
        expectPointClose(unit, { x: grid.xs[col]! / RECT_SIZE, y: grid.ys[row]! / RECT_SIZE }, 1e-6);
        const unitBR = applyHomography(inverse, cell[2]);
        expectPointClose(unitBR, { x: grid.xs[col + 1]! / RECT_SIZE, y: grid.ys[row + 1]! / RECT_SIZE }, 1e-6);
      }
    }
  });
});
