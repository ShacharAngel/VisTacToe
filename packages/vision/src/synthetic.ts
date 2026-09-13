import { quadToUnitSquare, applyHomography } from './homography.js';
import { makeGray, RECT_SIZE, type GrayImage, type Quad } from './types.js';

/**
 * Deterministic synthetic scenes for tests: a paper sheet under perspective
 * with a hand-drawn-looking 3×3 grid and X/O marks. Everything is seeded so
 * fixtures are reproducible; wobble/jitter mimic a human pen.
 */

export type MarkChar = 'X' | 'O' | '.';

export interface PaperOptions {
  /** 9 chars, row-major, '.' = empty — e.g. 'X...O....'. */
  marks?: string;
  /** Draw the 3×3 grid lines at all. */
  grid?: boolean;
  /** Fraction of the paper the grid spans, centered. */
  gridSpan?: number;
  /** Pen wobble amplitude in pixels at paper scale. */
  wobble?: number;
  penWidth?: number;
  /** How much of the O circle actually gets drawn (1 = closed, <1 = the pen lifts early). */
  oClosure?: number;
  seed?: number;
}

export interface SceneOptions {
  width?: number;
  height?: number;
  /** Paper corners TL,TR,BR,BL in scene coordinates; omit for a paperless scene. */
  quad?: Quad;
  paper?: GrayImage;
  backgroundLevel?: number;
  noiseSigma?: number;
  seed?: number;
}

/** mulberry32 — tiny seeded PRNG, plenty for pen jitter and sensor noise. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stampDisc(img: GrayImage, cx: number, cy: number, radius: number, color: number): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) img.data[y * img.width + x] = color;
    }
  }
}

/** A pen stroke from p0 to p1 with low-frequency wobble perpendicular to it. */
function drawStroke(
  img: GrayImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  wobble: number,
  random: () => number,
  color = 40,
): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(2, Math.ceil(len * 2));
  const nx = -(y1 - y0) / len;
  const ny = (x1 - x0) / len;
  const phase = random() * Math.PI * 2;
  const freq = 1.5 + random() * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const off = wobble * Math.sin(t * Math.PI * freq + phase) + (random() - 0.5) * wobble * 0.4;
    stampDisc(img, x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off, width / 2, color);
  }
}

function drawEllipse(
  img: GrayImage,
  cx: number,
  cy: number,
  radius: number,
  width: number,
  wobble: number,
  random: () => number,
  closure = 1,
  color = 40,
): void {
  const start = random() * Math.PI * 2;
  const sweep = Math.PI * 2 * closure;
  const steps = Math.max(16, Math.ceil(radius * sweep));
  const rx = radius * (0.85 + random() * 0.3);
  const ry = radius * (0.85 + random() * 0.3);
  const phase = random() * Math.PI * 2;
  for (let i = 0; i <= steps; i++) {
    const a = start + (i / steps) * sweep;
    const wob = wobble * 0.6 * Math.sin(a * 3 + phase);
    stampDisc(img, cx + Math.cos(a) * (rx + wob), cy + Math.sin(a) * (ry + wob), width / 2, color);
  }
}

/** Render the flat paper raster (RECT_SIZE² canonical space). */
export function renderPaper(options: PaperOptions = {}): GrayImage {
  const { marks = '.........', grid = true, gridSpan = 0.8, wobble = 2, penWidth = 5, oClosure = 1, seed = 1 } = options;
  const random = rng(seed);
  const size = RECT_SIZE;
  const img = makeGray(size, size, 0);
  // Paper texture: bright with mild speckle.
  for (let i = 0; i < img.data.length; i++) {
    img.data[i] = 238 + Math.floor(random() * 12);
  }

  const span = size * gridSpan;
  const origin = (size - span) / 2;
  const cell = span / 3;

  if (grid) {
    for (const k of [1, 2]) {
      drawStroke(img, origin + cell * k, origin, origin + cell * k, origin + span, penWidth, wobble, random);
      drawStroke(img, origin, origin + cell * k, origin + span, origin + cell * k, penWidth, wobble, random);
    }
  }

  for (let i = 0; i < 9; i++) {
    const mark = (marks[i] ?? '.') as MarkChar;
    if (mark === '.') continue;
    const col = i % 3;
    const row = Math.floor(i / 3);
    const cx = origin + cell * (col + 0.5) + (random() - 0.5) * cell * 0.1;
    const cy = origin + cell * (row + 0.5) + (random() - 0.5) * cell * 0.1;
    const half = cell * 0.28;
    if (mark === 'X') {
      const tilt = () => (random() - 0.5) * half * 0.3;
      drawStroke(img, cx - half + tilt(), cy - half + tilt(), cx + half + tilt(), cy + half + tilt(), penWidth, wobble, random);
      drawStroke(img, cx + half + tilt(), cy - half + tilt(), cx - half + tilt(), cy + half + tilt(), penWidth, wobble, random);
    } else {
      drawEllipse(img, cx, cy, half, penWidth, wobble, random, oClosure);
    }
  }
  return img;
}

/** Ground-truth cell boundary coordinates for a paper rendered with the given span. */
export function paperGridBoundaries(gridSpan = 0.8): { xs: number[]; ys: number[] } {
  const span = RECT_SIZE * gridSpan;
  const origin = (RECT_SIZE - span) / 2;
  const cell = span / 3;
  const lines = [origin, origin + cell, origin + 2 * cell, origin + span];
  return { xs: [...lines], ys: [...lines] };
}

/** Project the paper raster into a camera scene under perspective, plus sensor noise. */
export function renderScene(options: SceneOptions = {}): GrayImage {
  const { width = 640, height = 480, quad, paper, backgroundLevel = 70, noiseSigma = 3, seed = 2 } = options;
  const random = rng(seed);
  const img = makeGray(width, height);
  // Background with a gentle diagonal lighting gradient.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      img.data[y * width + x] = Math.max(0, Math.min(255, backgroundLevel + ((x + y) / (width + height)) * 20));
    }
  }

  if (quad && paper) {
    const toUnit = quadToUnitSquare(quad);
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const u = applyHomography(toUnit, { x, y });
        if (u.x < 0 || u.x >= 1 || u.y < 0 || u.y >= 1) continue;
        const px = Math.min(paper.width - 1, Math.floor(u.x * paper.width));
        const py = Math.min(paper.height - 1, Math.floor(u.y * paper.height));
        img.data[y * width + x] = paper.data[py * paper.width + px]!;
      }
    }
  }

  if (noiseSigma > 0) {
    for (let i = 0; i < img.data.length; i++) {
      // Box-Muller
      const gauss = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
      const v = img.data[i]! + gauss * noiseSigma;
      img.data[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
  return img;
}

/** A convenient, mildly angled default paper placement in a 640×480 scene. */
export function defaultQuad(): Quad {
  return [
    { x: 130, y: 60 },
    { x: 520, y: 80 },
    { x: 545, y: 420 },
    { x: 110, y: 400 },
  ];
}

/** Paint a dark blob (a "hand") over part of the scene, in place. */
export function occlude(img: GrayImage, cx: number, cy: number, radius: number): GrayImage {
  stampDisc(img, cx, cy, radius, 45);
  return img;
}
