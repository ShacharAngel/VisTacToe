import type { Player } from '@vistactoe/engine';
import type { CellReading } from '@vistactoe/shared';
import type { CellFeatures } from '@vistactoe/vision';

/**
 * Persisted learned state ("the agent gets smarter"). Two axes, both measured:
 *  - accuracy: per-player handwriting profiles (feature centroids of THIS
 *    player's confirmed X and O marks) boost classifier confidence for marks
 *    that look like ones we've already verified — fewer escalations;
 *  - interventions: the ask threshold tunes itself from outcomes — asks whose
 *    answers just confirmed the classifier lower it, misreads raise it.
 */

export interface FeatureVector {
  holes: number;
  ringDeviation: number;
  centerInk: number;
  diagDeviation: number;
}

export interface MarkStats {
  count: number;
  mean: FeatureVector;
}

export interface Calibration {
  version: 1;
  thresholds: { ask: number | null };
  marks: { X: MarkStats | null; O: MarkStats | null };
  gamesLearned: number;
  updatedAt: string | null;
}

export function emptyCalibration(): Calibration {
  return { version: 1, thresholds: { ask: null }, marks: { X: null, O: null }, gamesLearned: 0, updatedAt: null };
}

export interface LabeledExample {
  label: Player;
  features: FeatureVector;
}

export interface GameOutcomeStats {
  /** Escalations whose resolution matched the classifier's original guess (under-confidence). */
  asksConfirmed: number;
  /** Escalations whose resolution overturned the classifier (real misreads). */
  misreads: number;
}

const FEATURE_KEYS: (keyof FeatureVector)[] = ['holes', 'ringDeviation', 'centerInk', 'diagDeviation'];
/** Per-feature scale used to normalize distances (holes is 0/1-ish, the rest live around 0-0.5). */
const FEATURE_SCALE: FeatureVector = { holes: 1, ringDeviation: 0.25, centerInk: 0.25, diagDeviation: 0.2 };
const MIN_EXAMPLES = 3;
const ASK_FLOOR = 0.45;
const ASK_CEIL = 0.8;
const ASK_STEP = 0.05;

export function toFeatureVector(features: CellFeatures): FeatureVector {
  return {
    holes: features.holes,
    ringDeviation: features.ringDeviation,
    centerInk: features.centerInk,
    diagDeviation: features.diagDeviation,
  };
}

function distance(a: FeatureVector, b: FeatureVector): number {
  let sum = 0;
  for (const key of FEATURE_KEYS) {
    const d = (a[key] - b[key]) / FEATURE_SCALE[key];
    sum += d * d;
  }
  return Math.sqrt(sum / FEATURE_KEYS.length);
}

/** Fold one game's confirmed marks and escalation outcomes into the calibration. */
export function updateCalibration(
  calibration: Calibration,
  examples: LabeledExample[],
  outcomes: GameOutcomeStats,
  defaultAsk: number,
): Calibration {
  const next: Calibration = structuredClone(calibration);

  for (const { label, features } of examples) {
    const stats = next.marks[label];
    if (!stats) {
      next.marks[label] = { count: 1, mean: { ...features } };
      continue;
    }
    stats.count += 1;
    for (const key of FEATURE_KEYS) {
      stats.mean[key] += (features[key] - stats.mean[key]) / stats.count;
    }
  }

  const currentAsk = next.thresholds.ask ?? defaultAsk;
  if (outcomes.misreads > 0) {
    next.thresholds.ask = Math.min(ASK_CEIL, currentAsk + ASK_STEP);
  } else if (outcomes.asksConfirmed > 0) {
    next.thresholds.ask = Math.max(ASK_FLOOR, currentAsk - ASK_STEP);
  }

  next.gamesLearned += 1;
  next.updatedAt = new Date().toISOString();
  return next;
}

/**
 * Boost a reading's confidence when its features sit close to the confirmed
 * centroid of the same label. Never *reduces* confidence and never touches
 * 'empty' — the profile only vouches for marks it has seen verified before.
 */
export function applyCalibration(cells: CellReading[], calibration: Calibration): CellReading[] {
  return cells.map((cell) => {
    if (cell.label === 'empty') return cell;
    const features = (cell as CellReading & { features?: CellFeatures }).features;
    const stats = calibration.marks[cell.label];
    if (!features || !stats || stats.count < MIN_EXAMPLES) return cell;
    const dist = distance(toFeatureVector(features), stats.mean);
    if (dist >= 1) return cell;
    const boosted = cell.confidence + (0.97 - cell.confidence) * (1 - dist);
    return { ...cell, confidence: Math.max(cell.confidence, Math.min(boosted, 0.97)) };
  });
}
