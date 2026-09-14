import { describe, expect, it } from 'vitest';
import { classifyCell, classifyCells, makeGray, synthetic, type GrayImage, type GridGeometry } from '@vistactoe/vision';

const { rng } = synthetic;

/**
 * Build binary ink crops directly (ink = 255 on black), mimicking what the
 * inkMask + cropCell path produces for a single cell.
 */

function stamp(img: GrayImage, cx: number, cy: number, radius: number): void {
  const r2 = radius * radius;
  for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(img.height - 1, Math.ceil(cy + radius)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(img.width - 1, Math.ceil(cx + radius)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) img.data[y * img.width + x] = 255;
    }
  }
}

function stroke(img: GrayImage, x0: number, y0: number, x1: number, y1: number, width: number, wobble: number, random: () => number): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(2, Math.ceil(len * 2));
  const nx = -(y1 - y0) / len;
  const ny = (x1 - x0) / len;
  const phase = random() * Math.PI * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const off = wobble * Math.sin(t * Math.PI * 2 + phase) + (random() - 0.5) * wobble * 0.4;
    stamp(img, x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off, width / 2);
  }
}

function drawnX(seed: number, size = 100): GrayImage {
  const img = makeGray(size, size);
  const random = rng(seed);
  const m = size * 0.2;
  const j = () => (random() - 0.5) * size * 0.08;
  stroke(img, m + j(), m + j(), size - m + j(), size - m + j(), 5, 2, random);
  stroke(img, size - m + j(), m + j(), m + j(), size - m + j(), 5, 2, random);
  return img;
}

function drawnO(seed: number, closure = 1, size = 100): GrayImage {
  const img = makeGray(size, size);
  const random = rng(seed);
  const cx = size / 2 + (random() - 0.5) * size * 0.06;
  const cy = size / 2 + (random() - 0.5) * size * 0.06;
  const radius = size * 0.28;
  const start = random() * Math.PI * 2;
  const steps = 200;
  for (let i = 0; i <= steps * closure; i++) {
    const a = start + (i / steps) * Math.PI * 2;
    const wob = 1.5 * Math.sin(a * 3);
    stamp(img, cx + Math.cos(a) * (radius + wob), cy + Math.sin(a) * (radius * 1.1 + wob), 2.5);
  }
  return img;
}

describe('classifyCell', () => {
  it('classifies hand-drawn Xs across seeds', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const result = classifyCell(drawnX(seed));
      expect(result.label, `seed ${seed}`).toBe('X');
      expect(result.confidence, `seed ${seed}`).toBeGreaterThan(0.6);
      expect(result.features.holes).toBe(0);
    }
  });

  it('classifies closed Os across seeds, with the hole detected', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const result = classifyCell(drawnO(seed));
      expect(result.label, `seed ${seed}`).toBe('O');
      expect(result.confidence, `seed ${seed}`).toBeGreaterThan(0.6);
      expect(result.features.holes).toBe(1);
    }
  });

  it('still reads an unclosed O as O (ring shape rescues it)', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const result = classifyCell(drawnO(seed, 0.8));
      expect(result.label, `seed ${seed}`).toBe('O');
    }
  });

  it('reads an empty cell as empty with high confidence', () => {
    const result = classifyCell(makeGray(100, 100));
    expect(result.label).toBe('empty');
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('treats a few noise speckles as empty', () => {
    const img = makeGray(100, 100);
    const random = rng(9);
    for (let i = 0; i < 12; i++) {
      img.data[Math.floor(random() * img.data.length)] = 255;
    }
    expect(classifyCell(img).label).toBe('empty');
  });

  it('treats border-hugging ink (grid-line bleed) as empty', () => {
    const img = makeGray(100, 100);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 4; x++) img.data[y * 100 + x] = 255; // strip along the left edge
    }
    const result = classifyCell(img);
    expect(result.label).toBe('empty');
  });

  it('gives an ambiguous scrawl low confidence', () => {
    // A single short straight stroke: neither ring nor cross.
    const img = makeGray(100, 100);
    const random = rng(5);
    stroke(img, 30, 50, 70, 55, 5, 1, random);
    const result = classifyCell(img);
    expect(result.confidence).toBeLessThan(0.75);
  });
});

describe('classifyCells (board-level, grid-line bleed)', () => {
  const GRID: GridGeometry = { xs: [60, 220, 380, 540], ys: [60, 220, 380, 540] };

  /** Hash-style grid whose top line's tail curves up into the top-right cell — the real-world phantom-X shape. */
  function boardWithWavyTail(random: () => number): GrayImage {
    const img = makeGray(600, 600);
    stroke(img, 60, 220, 450, 220, 8, 2, random);
    stroke(img, 450, 218, 530, 150, 8, 1, random); // the tail rising into cell 2's interior
    stroke(img, 60, 380, 540, 380, 8, 2, random);
    stroke(img, 220, 60, 220, 540, 8, 2, random);
    stroke(img, 380, 60, 380, 540, 8, 2, random);
    return img;
  }

  it('strips a wavy line tail instead of reading it as a phantom X', () => {
    const cells = classifyCells(boardWithWavyTail(rng(3)), GRID);
    expect(cells.map((c) => c.label)).toEqual(Array.from({ length: 9 }, () => 'empty'));
  });

  it('still reads a clean X in the center cell with the tail stripped around it', () => {
    const random = rng(4);
    const img = boardWithWavyTail(random);
    stroke(img, 250, 250, 350, 350, 6, 2, random);
    stroke(img, 350, 250, 250, 350, 6, 2, random);
    const cells = classifyCells(img, GRID);
    expect(cells[4]!.label).toBe('X');
    expect(cells.filter((_, i) => i !== 4).map((c) => c.label)).toEqual(Array.from({ length: 8 }, () => 'empty'));
  });

  it('does not silently erase a mark drawn touching a grid line', () => {
    const random = rng(5);
    const img = boardWithWavyTail(random);
    // One stroke of the X crosses the top boundary line — the components merge,
    // so the whole mark gets flagged; stripping must back off (too much ink).
    stroke(img, 250, 210, 350, 350, 6, 2, random);
    stroke(img, 350, 250, 250, 350, 6, 2, random);
    const cells = classifyCells(img, GRID);
    expect(cells[4]!.label).not.toBe('empty');
  });
});
