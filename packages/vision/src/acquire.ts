import { unitSquareToQuad, applyHomography } from './homography.js';
import { loadOpenCv, type CvModule } from './opencv.js';
import { RECT_SIZE, type FrameAnalysis, type GrayImage, type GridGeometry, type Point, type Quad } from './types.js';

/** Minimum fraction of the frame a paper candidate must cover. */
const MIN_PAPER_AREA = 0.12;
/** A paper's interior must be at least this many gray levels brighter than its surround. */
const MIN_PAPER_CONTRAST = 25;

export interface Analyzer {
  analyzeFrame(frame: GrayImage): FrameAnalysis;
  /** Rectify a frame with a known quad (reused while the grid is locked). */
  rectify(frame: GrayImage, quad: Quad): GrayImage;
  findPaperQuad(frame: GrayImage): Quad | null;
  detectGrid(rectified: GrayImage): GridGeometry | null;
  /** Binarized ink mask (ink = 255) of a rectified board. */
  inkMask(rectified: GrayImage): GrayImage;
}

export async function createAnalyzer(): Promise<Analyzer> {
  const cv = await loadOpenCv();
  return new CvAnalyzer(cv);
}

class CvAnalyzer implements Analyzer {
  constructor(private readonly cv: CvModule) {}

  analyzeFrame(frame: GrayImage): FrameAnalysis {
    const quad = this.findPaperQuad(frame);
    if (!quad) return { kind: 'no_paper' };
    const rectified = this.rectify(frame, quad);
    const grid = this.detectGrid(rectified);
    if (!grid) return { kind: 'no_grid', quad };
    return { kind: 'grid', quad, rectified, grid };
  }

  findPaperQuad(frame: GrayImage): Quad | null {
    const cv = this.cv;
    const src = toMat(cv, frame);
    const blurred = new cv.Mat();
    const thresh = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    try {
      cv.GaussianBlur(src, blurred, new cv.Size(5, 5), 0);
      // Paper is the bright region; Otsu splits it from the background.
      cv.threshold(blurred, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      let bestArea = frame.width * frame.height * MIN_PAPER_AREA;
      let best: Quad | null = null;
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        const area = cv.contourArea(contour);
        if (area < bestArea) {
          contour.delete();
          continue;
        }
        const quad = approxQuad(cv, contour);
        contour.delete();
        if (!quad || isDegenerateQuad(quad)) continue;
        // A real sheet is markedly brighter than the surface around it; this
        // rejects the bright half of a gradient/empty scene, which the extreme-
        // corner fallback would otherwise accept as "paper".
        if (!isBrightPaper(frame, quad)) continue;
        bestArea = area;
        best = quad;
      }
      return best;
    } finally {
      src.delete();
      blurred.delete();
      thresh.delete();
      contours.delete();
      hierarchy.delete();
    }
  }

  rectify(frame: GrayImage, quad: Quad): GrayImage {
    const cv = this.cv;
    const src = toMat(cv, frame);
    const dst = new cv.Mat();
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap((p) => [p.x, p.y]));
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, RECT_SIZE, 0, RECT_SIZE, RECT_SIZE, 0, RECT_SIZE]);
    const transform = cv.getPerspectiveTransform(srcPts, dstPts);
    try {
      cv.warpPerspective(src, dst, transform, new cv.Size(RECT_SIZE, RECT_SIZE), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      return { data: new Uint8Array(dst.data), width: RECT_SIZE, height: RECT_SIZE };
    } finally {
      src.delete();
      dst.delete();
      srcPts.delete();
      dstPts.delete();
      transform.delete();
    }
  }

  detectGrid(rectified: GrayImage): GridGeometry | null {
    const ink = this.inkMask(rectified);
    const extent = inkExtent(ink);
    if (!extent) return null;

    // Hough finds the grid's straight lines at whatever angle they were drawn;
    // projection profiles assumed axis-aligned lines and broke on the tilt and
    // waviness of a real hand-drawn grid.
    const segments = this.houghSegments(ink);
    const vertical = clusterLines(segments, 'vertical', rectified.width, rectified.height);
    const horizontal = clusterLines(segments, 'horizontal', rectified.width, rectified.height);

    const xs = boundariesFromLines(vertical, extent.x0, extent.x1);
    const ys = boundariesFromLines(horizontal, extent.y0, extent.y1);
    if (!xs || !ys) return null;
    return { xs, ys };
  }

  private houghSegments(ink: GrayImage): Segment[] {
    const cv = this.cv;
    const src = toMat(cv, ink);
    const lines = new cv.Mat();
    try {
      // minLineLength excludes X/O strokes (short); maxLineGap bridges the gaps
      // in a wavy hand-drawn stroke so it reads as one line.
      const minLineLength = Math.round(ink.height * 0.28);
      cv.HoughLinesP(src, lines, 1, Math.PI / 180, 45, minLineLength, 30);
      const segments: Segment[] = [];
      // opencv.js packs the segments as a 1×N (×4-channel) Mat, so the count is
      // rows*cols, not rows.
      const count = lines.rows * lines.cols;
      for (let i = 0; i < count; i++) {
        segments.push({
          x1: lines.data32S[i * 4]!,
          y1: lines.data32S[i * 4 + 1]!,
          x2: lines.data32S[i * 4 + 2]!,
          y2: lines.data32S[i * 4 + 3]!,
        });
      }
      return segments;
    } finally {
      src.delete();
      lines.delete();
    }
  }

  /**
   * Adaptive threshold to an ink mask (ink = 255), opened (erode → dilate) so
   * single-pixel sensor speckle disappears while pen strokes survive, then
   * border-cleared.
   */
  inkMask(rectified: GrayImage): GrayImage {
    const cv = this.cv;
    const src = toMat(cv, rectified);
    const bin = new cv.Mat();
    const eroded = new cv.Mat();
    const dilated = new cv.Mat();
    const kernel = cv.Mat.ones(3, 3, cv.CV_8UC1);
    const wideKernel = cv.Mat.ones(5, 5, cv.CV_8UC1);
    try {
      cv.adaptiveThreshold(src, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 35, 12);
      cv.erode(bin, eroded, kernel);
      cv.dilate(eroded, dilated, wideKernel);
      const img = { data: new Uint8Array(dilated.data), width: rectified.width, height: rectified.height };
      clearBorder(img, Math.round(rectified.width * 0.02));
      return img;
    } finally {
      src.delete();
      bin.delete();
      eroded.delete();
      dilated.delete();
      kernel.delete();
      wideKernel.delete();
    }
  }
}

// ---- helpers ---------------------------------------------------------------

function toMat(cv: CvModule, img: GrayImage) {
  return cv.matFromArray(img.height, img.width, cv.CV_8UC1, img.data as unknown as number[]);
}

/**
 * Fit a 4-corner quad to a bright-region contour. Works on the CONVEX HULL,
 * not the raw contour: a hand-drawn grid whose lines run to the paper edge cuts
 * notches into the paper silhouette, which would otherwise make approxPolyDP
 * return >4 vertices (rejected as "no paper") or latch onto a notch corner
 * (mis-rectified board). The hull erases those notches, leaving the true sheet
 * corners. Falls back to the hull's extreme corners when polygon simplification
 * can't land on exactly four.
 */
function approxQuad(cv: CvModule, contour: InstanceType<CvModule['Mat']>): Quad | null {
  const hull = new cv.Mat();
  cv.convexHull(contour, hull, false, true);
  try {
    if (hull.rows < 4) return null;
    const hullPts: Point[] = [];
    for (let i = 0; i < hull.rows; i++) {
      hullPts.push({ x: hull.data32S[i * 2]!, y: hull.data32S[i * 2 + 1]! });
    }

    const perimeter = cv.arcLength(hull, true);
    for (const epsFraction of [0.01, 0.02, 0.03, 0.04, 0.05, 0.07, 0.1]) {
      const approx = new cv.Mat();
      cv.approxPolyDP(hull, approx, perimeter * epsFraction, true);
      const found = approx.rows === 4;
      if (found) {
        const pts: Point[] = [];
        for (let i = 0; i < 4; i++) {
          pts.push({ x: approx.data32S[i * 2]!, y: approx.data32S[i * 2 + 1]! });
        }
        approx.delete();
        return orderQuad(pts);
      }
      approx.delete();
    }
    // Simplification never hit 4 (very rounded or noisy hull) — take the
    // extreme corners of the hull directly.
    return orderQuad(hullPts);
  } finally {
    hull.delete();
  }
}

/**
 * Order/select the TL, TR, BR, BL corners from a convex point set: TL minimizes
 * x+y, BR maximizes it; TR maximizes x−y, BL minimizes it. Works for any number
 * of input points, so it doubles as the extreme-corner fallback.
 */
function orderQuad(pts: Point[]): Quad {
  let tl = pts[0]!;
  let tr = pts[0]!;
  let br = pts[0]!;
  let bl = pts[0]!;
  for (const p of pts) {
    if (p.x + p.y < tl.x + tl.y) tl = p;
    if (p.x + p.y > br.x + br.y) br = p;
    if (p.x - p.y > tr.x - tr.y) tr = p;
    if (p.x - p.y < bl.x - bl.y) bl = p;
  }
  return [tl, tr, br, bl];
}

/**
 * A quad is degenerate when corners coincide or a side collapses — the
 * extreme-corner fallback can produce these on thin/odd contours, and they
 * make the homography solve blow up. Reject them before any warp.
 */
function isDegenerateQuad(quad: Quad): boolean {
  const minSide = 12;
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    if (Math.hypot(a.x - b.x, a.y - b.y) < minSide) return true;
  }
  return false;
}

/**
 * True when the quad interior is clearly brighter than the surface just outside
 * it — the signature of a paper sheet on a table, and absent from a gradient or
 * empty scene where the "quad" is just the bright half of the background.
 */
function isBrightPaper(frame: GrayImage, quad: Quad): boolean {
  let toQuad;
  try {
    toQuad = unitSquareToQuad(quad);
  } catch {
    return false; // degenerate despite the guard — treat as "not paper"
  }
  const inside: Point[] = [];
  for (const v of [0.3, 0.5, 0.7]) {
    for (const u of [0.3, 0.5, 0.7]) inside.push(applyHomography(toQuad, { x: u, y: v }));
  }
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  // Points pushed 30% outward from the centre through each corner and edge midpoint.
  const outside: Point[] = [];
  const ring = [
    quad[0],
    quad[1],
    quad[2],
    quad[3],
    { x: (quad[0].x + quad[1].x) / 2, y: (quad[0].y + quad[1].y) / 2 },
    { x: (quad[1].x + quad[2].x) / 2, y: (quad[1].y + quad[2].y) / 2 },
    { x: (quad[2].x + quad[3].x) / 2, y: (quad[2].y + quad[3].y) / 2 },
    { x: (quad[3].x + quad[0].x) / 2, y: (quad[3].y + quad[0].y) / 2 },
  ];
  for (const p of ring) outside.push({ x: cx + (p.x - cx) * 1.3, y: cy + (p.y - cy) * 1.3 });

  const insideMean = sampleMean(frame, inside);
  const outsideMean = sampleMean(frame, outside);
  if (insideMean === null || outsideMean === null) return false;
  return insideMean - outsideMean >= MIN_PAPER_CONTRAST;
}

/** Mean gray over the in-bounds sample points, or null if too few land inside the frame. */
function sampleMean(frame: GrayImage, points: Point[]): number | null {
  let sum = 0;
  let count = 0;
  for (const p of points) {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
    sum += frame.data[y * frame.width + x]!;
    count++;
  }
  return count >= 3 ? sum / count : null;
}

function clearBorder(img: GrayImage, margin: number): void {
  const { data, width, height } = img;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < margin || y < margin || x >= width - margin || y >= height - margin) {
        data[y * width + x] = 0;
      }
    }
  }
}

interface Extent {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Bounding box of meaningful ink (columns/rows with more than noise-level pixels). */
function inkExtent(ink: GrayImage): Extent | null {
  const { data, width, height } = ink;
  const colCounts = new Array<number>(width).fill(0);
  const rowCounts = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x]) {
        colCounts[x]!++;
        rowCounts[y]!++;
      }
    }
  }
  const noise = 3;
  const x0 = colCounts.findIndex((c) => c > noise);
  const y0 = rowCounts.findIndex((c) => c > noise);
  if (x0 < 0 || y0 < 0) return null;
  const x1 = colCounts.length - 1 - [...colCounts].reverse().findIndex((c) => c > noise);
  const y1 = rowCounts.length - 1 - [...rowCounts].reverse().findIndex((c) => c > noise);
  // Too little ink to be a grid at all.
  if (x1 - x0 < ink.width * 0.2 || y1 - y0 < ink.height * 0.2) return null;
  return { x0, x1, y0, y1 };
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Within 28° of the target orientation counts as that kind of line. */
const ORIENTATION_TOLERANCE = (28 * Math.PI) / 180;

/**
 * Group Hough segments belonging to the same orientation into grid lines and
 * return each line's crossing position at the board center (x for vertical
 * lines, y for horizontal). Working at the center makes the position robust to
 * the line's tilt; clustering absorbs the multiple short segments a wavy
 * hand-drawn stroke produces.
 */
function clusterLines(
  segments: Segment[],
  orientation: 'vertical' | 'horizontal',
  width: number,
  height: number,
): number[] {
  const midX = width / 2;
  const midY = height / 2;
  const mergeTolerance = (orientation === 'vertical' ? width : height) * 0.08;

  interface Line {
    pos: number;
    weight: number;
  }
  const lines: { posSum: number; weight: number }[] = [];

  for (const seg of segments) {
    const dx = seg.x2 - seg.x1;
    const dy = seg.y2 - seg.y1;
    const length = Math.hypot(dx, dy);
    if (length < 1) continue;
    const tilt = orientation === 'vertical' ? Math.atan2(Math.abs(dx), Math.abs(dy)) : Math.atan2(Math.abs(dy), Math.abs(dx));
    if (tilt > ORIENTATION_TOLERANCE) continue; // diagonal (an X stroke) or wrong orientation

    // Crossing position at the board center line.
    let pos: number;
    if (orientation === 'vertical') {
      pos = Math.abs(dy) < 1 ? (seg.x1 + seg.x2) / 2 : seg.x1 + (dx * (midY - seg.y1)) / dy;
    } else {
      pos = Math.abs(dx) < 1 ? (seg.y1 + seg.y2) / 2 : seg.y1 + (dy * (midX - seg.x1)) / dx;
    }

    const existing = lines.find((l) => Math.abs(l.posSum / l.weight - pos) < mergeTolerance);
    if (existing) {
      existing.posSum += pos * length;
      existing.weight += length;
    } else {
      lines.push({ posSum: pos * length, weight: length });
    }
  }

  const resolved: Line[] = lines
    .map((l) => ({ pos: l.posSum / l.weight, weight: l.weight }))
    .filter((l) => l.weight >= (orientation === 'vertical' ? height : width) * 0.3)
    .sort((a, b) => a.pos - b.pos);

  // A 3×3 grid has two interior lines per orientation (four when drawn with a
  // border). Keep the strongest, in position order.
  if (resolved.length < 2) return resolved.map((l) => l.pos);
  const keep = resolved.length > 4 ? [...resolved].sort((a, b) => b.weight - a.weight).slice(0, 4) : resolved;
  return keep.map((l) => l.pos).sort((a, b) => a - b);
}

/**
 * Accepts 2 interior lines (borderless grid — outer boundaries extrapolated
 * from the line spacing) or 4 lines (grid drawn with a border); 3 lines are
 * treated as 2 interior + a stray by keeping the evenly spaced pair.
 */
function boundariesFromLines(lines: number[], lo: number, hi: number): [number, number, number, number] | null {
  if (lines.length === 2) {
    const [a, b] = [lines[0]!, lines[1]!];
    const spacing = b - a;
    if (spacing < 20) return null;
    return [Math.max(lo, a - spacing), a, b, Math.min(hi, b + spacing)];
  }
  if (lines.length === 4) {
    const [l0, l1, l2, l3] = [lines[0]!, lines[1]!, lines[2]!, lines[3]!];
    const inner = l2 - l1;
    if (inner < 20) return null;
    // Sanity: the three cells should be roughly even.
    if (Math.abs(l1 - l0 - inner) > inner * 0.6 || Math.abs(l3 - l2 - inner) > inner * 0.6) return null;
    return [l0, l1, l2, l3];
  }
  return null;
}
