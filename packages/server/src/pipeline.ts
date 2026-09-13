import type { AppConfig, CellLabel, Effect, ServerMessage } from '@vistactoe/shared';
import {
  BoardWatcher,
  cropCell,
  decodeToGray,
  encodeGrayToJpeg,
  VisionDebugDumper,
  type Analyzer,
} from '@vistactoe/vision';
import type { FeedbackStore } from './feedback/store.js';
import { GameSession } from './session/machine.js';
import type { VlmClient } from './vlm.js';

export type LogSink = (event: { type: string } & Record<string, unknown>) => void;

/**
 * Glues perception to the session for one connected camera: decodes frames,
 * runs the watcher, feeds observations to the session, and turns effects into
 * protocol messages. When the session escalates an uncertain cell, the VLM
 * tier (if configured) gets one shot before the question reaches the human.
 * Frames arriving while one is still processing are dropped — a live loop
 * wants the freshest frame, not a backlog.
 */
export class SessionPipeline {
  private readonly config: AppConfig;
  private readonly session: GameSession;
  private readonly watcher: BoardWatcher;
  private readonly debug: VisionDebugDumper | null;
  private busy = false;

  constructor(
    analyzer: Analyzer,
    config: AppConfig,
    private readonly logSink: LogSink = () => {},
    private readonly vlm: VlmClient | null = null,
    private readonly store: FeedbackStore | null = null,
    debugDir: string | null = null,
  ) {
    // Learned state feeds forward: sessions start with the tuned threshold.
    this.config = store
      ? { ...config, confidence: { ...config.confidence, ask: store.askThreshold() } }
      : config;
    this.session = new GameSession(this.config);
    this.watcher = new BoardWatcher(analyzer, {
      stillFrames: config.stability.stillFrames,
      motionThreshold: config.stability.motionThreshold,
    });
    this.debug = debugDir ? new VisionDebugDumper(analyzer, debugDir) : null;
  }

  async handleFrame(jpegBase64: string): Promise<ServerMessage[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      const frame = await decodeToGray(Buffer.from(jpegBase64, 'base64'));
      if (this.debug) await this.debug.maybeDump(frame);
      let observation = this.watcher.processFrame(frame);
      if (!observation) return [];
      if (observation.kind === 'board') {
        // Raw readings (with features) go to the feedback log; the session
        // sees calibration-boosted confidences.
        this.logSink({ type: 'board_observed', cells: observation.cells });
        if (this.store) {
          observation = { ...observation, cells: this.store.calibrate(observation.cells) };
        }
      }
      const before = this.session.snapshot().phase;
      const effects = this.session.onObservation(observation);
      // Suppress no-op snapshots (unstable frames) to keep the socket quiet.
      if (effects.length === 0 && this.session.snapshot().phase === before) return [];
      return await this.toMessages(effects);
    } finally {
      this.busy = false;
    }
  }

  async handleAnswer(askId: string, label: CellLabel): Promise<ServerMessage[]> {
    return this.toMessages(this.session.onAnswer(askId, label));
  }

  async handleControl(action: 'new_game'): Promise<ServerMessage[]> {
    return this.toMessages(this.session.onControl(action));
  }

  hello(): ServerMessage[] {
    return [{ type: 'snapshot', snapshot: this.session.snapshot() }];
  }

  private async toMessages(effects: Effect[]): Promise<ServerMessage[]> {
    const messages: ServerMessage[] = [];
    for (const effect of effects) {
      switch (effect.kind) {
        case 'say':
          messages.push({ type: 'say', category: effect.category, text: effect.text });
          break;
        case 'log':
          this.logSink(effect.event);
          break;
        case 'ask': {
          const resolved = await this.tryVlm(effect.ask.id, effect.ask.cell);
          if (resolved) {
            // The VLM settled it — recurse into the answer's effects instead
            // of bothering the human.
            messages.push(...(await this.toMessages(this.session.onAnswer(effect.ask.id, resolved, 'vlm'))));
            return messages; // that recursion appended the fresh snapshot
          }
          messages.push({ type: 'ask', ask: effect.ask });
          break;
        }
      }
    }
    messages.push({ type: 'snapshot', snapshot: this.session.snapshot() });
    return messages;
  }

  /** Tier 2: one cell crop, one classification call, degrade silently on any failure. */
  private async tryVlm(askId: string, cell: number): Promise<CellLabel | null> {
    if (!this.vlm || !this.config.vlm.enabled) return null;
    const board = this.watcher.lastBoard;
    if (!board) return null;
    const startedAt = Date.now();
    // A small margin of surrounding context, but nothing that could turn this
    // into a spatial question.
    const crop = cropCell(board.rectified, board.grid, Math.floor(cell / 3), cell % 3, 0.04);
    const verdict = await this.vlm.classifyCell(await encodeGrayToJpeg(crop));
    this.logSink({
      type: 'vlm_call',
      askId,
      cell,
      verdict: verdict?.label ?? null,
      confidence: verdict?.confidence ?? null,
      latencyMs: Date.now() - startedAt,
    });
    if (!verdict || verdict.confidence < this.config.confidence.ask) return null;
    return verdict.label;
  }
}
