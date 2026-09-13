import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Player } from '@vistactoe/engine';
import type { CellFeatures } from '@vistactoe/vision';
import {
  applyCalibration,
  emptyCalibration,
  toFeatureVector,
  updateCalibration,
  type Calibration,
  type GameOutcomeStats,
  type LabeledExample,
} from './calibration.js';

export type FeedbackEvent = { type: string } & Record<string, unknown>;

export interface GameSummary {
  gameNumber: number;
  startedAt: string;
  endedAt: string;
  winner: Player | null;
  draw: boolean;
  moves: number;
  asks: number;
  asksConfirmed: number;
  misreads: number;
  vlmCalls: number;
  corrections: number;
  corrupts: number;
}

interface ObservedCell {
  label: string;
  features?: CellFeatures;
}

/**
 * The inspectable, process-surviving state Section 2 requires. Plain files:
 *   data/games/<id>/events.jsonl  — every event of one game, one JSON per line
 *   data/games/<id>/summary.json  — the metrics that define "smarter"
 *   data/calibration.json         — the learned state applied to future games
 */
export class FeedbackStore {
  calibration: Calibration;
  private gameDir: string | null = null;
  private gameEvents: FeedbackEvent[] = [];
  private gameStartedAt: string | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly defaultAskThreshold: number,
  ) {
    mkdirSync(path.join(dataDir, 'games'), { recursive: true });
    this.calibration = this.loadCalibration();
  }

  /** Applies learned confidence boosts to a fresh observation. */
  calibrate<T extends { label: string; confidence: number }>(cells: T[]): T[] {
    return applyCalibration(cells as never, this.calibration) as T[];
  }

  /** The (possibly tuned) escalation threshold future sessions should use. */
  askThreshold(): number {
    return this.calibration.thresholds.ask ?? this.defaultAskThreshold;
  }

  append(event: FeedbackEvent): void {
    const stamped = { at: new Date().toISOString(), ...event };
    if (event.type === 'game_start' || (!this.gameDir && event.type !== 'game_end')) {
      if (event.type === 'game_start' || !this.gameDir) this.openGame(stamped.at);
    }
    if (!this.gameDir) return;
    this.gameEvents.push(stamped);
    appendFileSync(path.join(this.gameDir, 'events.jsonl'), JSON.stringify(stamped) + '\n');
    if (event.type === 'game_end') this.closeGame(stamped.at);
  }

  private openGame(at: string): void {
    const id = `${at.replace(/[:.]/g, '-')}`;
    this.gameDir = path.join(this.dataDir, 'games', id);
    mkdirSync(this.gameDir, { recursive: true });
    this.gameEvents = [];
    this.gameStartedAt = at;
  }

  private closeGame(at: string): void {
    if (!this.gameDir) return;
    const summary = summarize(this.gameEvents, this.gameStartedAt ?? at, at);
    writeFileSync(path.join(this.gameDir, 'summary.json'), JSON.stringify(summary, null, 2));

    const { examples, outcomes } = extractLearning(this.gameEvents);
    this.calibration = updateCalibration(this.calibration, examples, outcomes, this.defaultAskThreshold);
    writeFileSync(path.join(this.dataDir, 'calibration.json'), JSON.stringify(this.calibration, null, 2));

    this.gameDir = null;
    this.gameEvents = [];
    this.gameStartedAt = null;
  }

  private loadCalibration(): Calibration {
    const file = path.join(this.dataDir, 'calibration.json');
    if (!existsSync(file)) return emptyCalibration();
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Calibration;
    } catch {
      return emptyCalibration();
    }
  }
}

export function summarize(events: FeedbackEvent[], startedAt: string, endedAt: string): GameSummary {
  const summary: GameSummary = {
    gameNumber: 0,
    startedAt,
    endedAt,
    winner: null,
    draw: false,
    moves: 0,
    asks: 0,
    asksConfirmed: 0,
    misreads: 0,
    vlmCalls: 0,
    corrections: 0,
    corrupts: 0,
  };
  const askObserved = new Map<string, string>();
  for (const event of events) {
    switch (event.type) {
      case 'game_start':
        summary.gameNumber = (event.gameNumber as number) ?? 0;
        break;
      case 'human_move':
      case 'agent_mark_seen':
        summary.moves += 1;
        break;
      case 'ask':
        summary.asks += 1;
        askObserved.set(event.askId as string, event.observed as string);
        break;
      case 'answer': {
        const observed = askObserved.get(event.askId as string);
        if (observed !== undefined) {
          if (observed === event.label) summary.asksConfirmed += 1;
          else summary.misreads += 1;
        }
        break;
      }
      case 'vlm_call':
        summary.vlmCalls += 1;
        break;
      case 'correction':
        summary.corrections += 1;
        break;
      case 'corrupt':
        summary.corrupts += 1;
        break;
      case 'game_end':
        summary.winner = (event.winner as Player | null) ?? null;
        summary.draw = Boolean(event.draw);
        break;
    }
  }
  return summary;
}

/** Confirmed (features, label) pairs plus escalation outcomes for the learner. */
export function extractLearning(events: FeedbackEvent[]): {
  examples: LabeledExample[];
  outcomes: GameOutcomeStats;
} {
  const examples: LabeledExample[] = [];
  const outcomes: GameOutcomeStats = { asksConfirmed: 0, misreads: 0 };
  let lastObserved: ObservedCell[] | null = null;
  const askObserved = new Map<string, string>();

  for (const event of events) {
    switch (event.type) {
      case 'board_observed':
        lastObserved = event.cells as ObservedCell[];
        break;
      case 'human_move':
      case 'agent_mark_seen': {
        const cell = event.cell as number;
        const symbol = event.symbol as Player | undefined;
        const observed = lastObserved?.[cell];
        // Only learn when the committed symbol matches what perception saw —
        // that is a verified example of this player's handwriting.
        if (symbol && observed?.features && observed.label === symbol) {
          examples.push({ label: symbol, features: toFeatureVector(observed.features) });
        }
        break;
      }
      case 'ask':
        askObserved.set(event.askId as string, event.observed as string);
        break;
      case 'answer': {
        const observed = askObserved.get(event.askId as string);
        if (observed === undefined) break;
        if (observed === event.label) outcomes.asksConfirmed += 1;
        else outcomes.misreads += 1;
        break;
      }
    }
  }
  return { examples, outcomes };
}
