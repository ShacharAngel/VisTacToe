import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, mergeConfig, type ServerMessage } from '@vistactoe/shared';
import { createAnalyzer, encodeGrayToJpeg, synthetic, type Analyzer } from '@vistactoe/vision';
import {
  applyCalibration,
  emptyCalibration,
  extractLearning,
  FeedbackStore,
  SessionPipeline,
  summarize,
  updateCalibration,
  type FeedbackEvent,
} from '@vistactoe/server';

const FEATURES_X = { inkFraction: 0.1, holes: 0, ringDeviation: 0.4, centerInk: 0.3, diagDeviation: 0.08, borderFraction: 0.1, xScore: 0.8, oScore: 0.2 };
const FEATURES_O = { inkFraction: 0.1, holes: 1, ringDeviation: 0.08, centerInk: 0.02, diagDeviation: 0.3, borderFraction: 0.1, xScore: 0.2, oScore: 0.9 };

function gameEvents(): FeedbackEvent[] {
  const observed = (labels: string) => ({
    type: 'board_observed',
    cells: [...labels].map((ch) => ({
      label: ch === '.' ? 'empty' : ch,
      confidence: 0.8,
      features: ch === 'X' ? FEATURES_X : ch === 'O' ? FEATURES_O : undefined,
    })),
  });
  return [
    { type: 'game_start', gameNumber: 1, first: 'X' },
    observed('X........'),
    { type: 'human_move', cell: 0, symbol: 'X' },
    { type: 'agent_move', cell: 4 },
    observed('X...O....'),
    { type: 'agent_mark_seen', cell: 4, symbol: 'O', corrected: false },
    { type: 'ask', askId: 'q1', cell: 2, observed: 'X', expected: 'empty' },
    { type: 'answer', askId: 'q1', cell: 2, label: 'X', source: 'human' }, // confirmed → under-confidence
    { type: 'ask', askId: 'q2', cell: 5, observed: 'O', expected: 'empty' },
    { type: 'answer', askId: 'q2', cell: 5, label: 'empty', source: 'human' }, // overturned → misread
    { type: 'vlm_call', askId: 'q1', cell: 2, verdict: null, confidence: null, latencyMs: 900 },
    { type: 'game_end', gameNumber: 1, winner: null, draw: true },
  ];
}

describe('summarize / extractLearning', () => {
  it('computes the metrics that define "smarter"', () => {
    const summary = summarize(gameEvents(), 't0', 't1');
    expect(summary).toMatchObject({
      gameNumber: 1,
      moves: 2,
      asks: 2,
      asksConfirmed: 1,
      misreads: 1,
      vlmCalls: 1,
      draw: true,
    });
  });

  it('extracts only verified handwriting examples', () => {
    const { examples, outcomes } = extractLearning(gameEvents());
    expect(examples).toHaveLength(2); // one confirmed X, one confirmed O
    expect(examples.map((e) => e.label).sort()).toEqual(['O', 'X']);
    expect(outcomes).toEqual({ asksConfirmed: 1, misreads: 1 });
  });
});

describe('calibration learning', () => {
  it('builds running centroids and tunes the ask threshold within bounds', () => {
    let calibration = emptyCalibration();
    const x = { label: 'X' as const, features: { holes: 0, ringDeviation: 0.4, centerInk: 0.3, diagDeviation: 0.1 } };

    calibration = updateCalibration(calibration, [x, x], { asksConfirmed: 2, misreads: 0 }, 0.6);
    expect(calibration.marks.X?.count).toBe(2);
    expect(calibration.thresholds.ask).toBeCloseTo(0.55); // confirmed asks → trust the classifier more

    calibration = updateCalibration(calibration, [], { asksConfirmed: 0, misreads: 1 }, 0.6);
    expect(calibration.thresholds.ask).toBeCloseTo(0.6); // misread → be more careful

    for (let i = 0; i < 20; i++) {
      calibration = updateCalibration(calibration, [], { asksConfirmed: 0, misreads: 1 }, 0.6);
    }
    expect(calibration.thresholds.ask).toBeLessThanOrEqual(0.8); // bounded
    expect(calibration.gamesLearned).toBe(22);
  });

  it('boosts confidence only near a well-attested centroid of the same label', () => {
    let calibration = emptyCalibration();
    const features = { holes: 0, ringDeviation: 0.4, centerInk: 0.3, diagDeviation: 0.1 };
    // Two examples: below MIN_EXAMPLES, no boost yet.
    calibration = updateCalibration(calibration, [{ label: 'X', features }, { label: 'X', features }], { asksConfirmed: 0, misreads: 0 }, 0.6);
    const reading = { label: 'X' as const, confidence: 0.62, features: FEATURES_X };
    expect(applyCalibration([reading], calibration)[0]!.confidence).toBe(0.62);

    calibration = updateCalibration(calibration, [{ label: 'X', features }], { asksConfirmed: 0, misreads: 0 }, 0.6);
    const boosted = applyCalibration([reading], calibration)[0]!;
    expect(boosted.confidence).toBeGreaterThan(0.8);

    // A far-away shape gets no boost; empty never gets touched.
    const weird = { label: 'X' as const, confidence: 0.62, features: { ...FEATURES_X, diagDeviation: 0.9, centerInk: 0.0, holes: 1 } };
    expect(applyCalibration([weird], calibration)[0]!.confidence).toBe(0.62);
    const empty = { label: 'empty' as const, confidence: 0.5 };
    expect(applyCalibration([empty], calibration)[0]!.confidence).toBe(0.5);
  });
});

describe('FeedbackStore persistence', () => {
  it('writes inspectable per-game files and survives a process restart', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vistactoe-'));
    const store = new FeedbackStore(dir, 0.6);
    for (const event of gameEvents()) store.append(event);

    const games = readdirSync(path.join(dir, 'games'));
    expect(games).toHaveLength(1);
    const gameDir = path.join(dir, 'games', games[0]!);
    expect(existsSync(path.join(gameDir, 'events.jsonl'))).toBe(true);
    const summary = JSON.parse(readFileSync(path.join(gameDir, 'summary.json'), 'utf8'));
    expect(summary.asks).toBe(2);
    expect(existsSync(path.join(dir, 'calibration.json'))).toBe(true);

    // "Survives between processes": a brand-new store loads the learned state.
    const reborn = new FeedbackStore(dir, 0.6);
    expect(reborn.calibration.gamesLearned).toBe(1);
    // One misread in the game → threshold went up from the default.
    expect(reborn.askThreshold()).toBeCloseTo(0.65);
  });
});

describe('replay A/B: same frames, calibration off vs on', () => {
  const { renderPaper, renderScene, defaultQuad } = synthetic;
  let analyzer: Analyzer;

  beforeAll(async () => {
    analyzer = await createAnalyzer();
  }, 30_000);

  // This player draws open Os (the pen lifts early) — a real handwriting
  // quirk the classifier is legitimately unsure about until it learns it.
  async function jpeg(marks: string, noiseSeed: number): Promise<string> {
    const scene = renderScene({ quad: defaultQuad(), paper: renderPaper({ marks, seed: 7, oClosure: 0.72 }), seed: noiseSeed });
    return (await encodeGrayToJpeg(scene)).toString('base64');
  }

  /**
   * Plays one deterministic scripted game (identical page/frame sequence every
   * time) and returns how many times the agent had to ask a human. Any ask is
   * answered truthfully from the page. The open Os classify below the ask
   * threshold until the handwriting profile has learned to vouch for them.
   */
  async function playScriptedGame(pipeline: SessionPipeline): Promise<number> {
    let page = '.........';
    let noiseSeed = 100;
    let asks = 0;

    const pump = async (until: (last: ServerMessage[] | null) => boolean): Promise<void> => {
      for (let i = 0; i < 40; i++) {
        const messages = await pipeline.handleFrame(await jpeg(page, ++noiseSeed));
        // Answer any question truthfully from the page, and keep folding in
        // the resulting messages (an answer can advance the game and ask again).
        let pendingAsks = messages.filter((m) => m.type === 'ask');
        while (pendingAsks.length > 0) {
          const produced: ServerMessage[] = [];
          for (const message of pendingAsks) {
            if (message.type !== 'ask') continue;
            asks++;
            const truth = page[message.ask.cell];
            produced.push(...(await pipeline.handleAnswer(message.ask.id, truth === '.' ? 'empty' : (truth as 'X' | 'O'))));
          }
          messages.push(...produced);
          pendingAsks = produced.filter((m) => m.type === 'ask');
        }
        if (until(messages)) return;
      }
      throw new Error('scripted game stalled');
    };

    const phase = (messages: ServerMessage[] | null): string | null => {
      const snap = messages?.filter((m) => m.type === 'snapshot').at(-1);
      return snap?.type === 'snapshot' ? snap.snapshot.phase : null;
    };
    const snapOf = (messages: ServerMessage[] | null) => {
      const snap = messages?.filter((m) => m.type === 'snapshot').at(-1);
      return snap?.type === 'snapshot' ? snap.snapshot : null;
    };

    await pump((m) => phase(m) === 'human_turn');
    let lastSnapshot = null as ReturnType<typeof snapOf>;
    for (let turn = 0; turn < 12; turn++) {
      if (lastSnapshot?.phase === 'game_over') break;
      if (!lastSnapshot || lastSnapshot.phase === 'human_turn') {
        const cell = page.indexOf('.');
        page = page.slice(0, cell) + 'X' + page.slice(cell + 1);
        await pump((m) => {
          const s = snapOf(m);
          if (s && s.phase !== 'human_turn') {
            lastSnapshot = s;
            return true;
          }
          return false;
        });
      } else if (lastSnapshot.phase === 'awaiting_agent_mark') {
        const cell = lastSnapshot.pendingAgentCell!;
        page = page.slice(0, cell) + 'O' + page.slice(cell + 1);
        const previous = cell;
        await pump((m) => {
          const s = snapOf(m);
          if (s && s.pendingAgentCell !== previous) {
            lastSnapshot = s;
            return true;
          }
          return false;
        });
      } else {
        throw new Error(`unexpected phase ${lastSnapshot.phase}`);
      }
    }
    return asks;
  }

  it(
    'the same game needs fewer human interventions once the profile is learned',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'vistactoe-ab-'));
      const config = mergeConfig({
        confidence: { ask: 0.8 },
        stability: { ...defaultConfig.stability, stillFrames: 3 },
      });

      // Game 1: cold store — every mark escalates, the human answers, the store learns.
      const store = new FeedbackStore(dir, config.confidence.ask);
      const cold = new SessionPipeline(analyzer, config, (e) => store.append(e), null, store);
      const asksCold = await playScriptedGame(cold);
      expect(asksCold).toBeGreaterThan(1);
      expect(store.calibration.gamesLearned).toBe(1);

      // Game 2: SAME frames, store warmed by game 1 — the handwriting profile
      // vouches for the marks, so escalations must drop. Deterministic inputs
      // mean the delta is attributable to the learned state, not variance.
      const warm = new SessionPipeline(analyzer, config, (e) => store.append(e), null, store);
      const asksWarm = await playScriptedGame(warm);
      expect(asksWarm).toBeLessThan(asksCold);
    },
    120_000,
  );
});
