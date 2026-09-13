import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { bestMove, type Board, type CellValue } from '@vistactoe/engine';
import type { ClientMessage, ServerMessage, SessionSnapshot } from '@vistactoe/shared';
import { createAnalyzer, encodeGrayToJpeg, synthetic } from '@vistactoe/vision';
import { buildServer } from '@vistactoe/server';
import { mergeConfig } from '@vistactoe/shared';

/**
 * Full-loop e2e: the REAL server (WebSocket, decode, CV, session, minimax)
 * driven by a fake camera that renders the physical page as synthetic frames
 * — exactly what a browser client would send. No camera, network or API key.
 */

let app: FastifyInstance;
let port: number;

beforeAll(async () => {
  const analyzer = await createAnalyzer();
  app = await buildServer({
    analyzer,
    config: {
      app: mergeConfig({ stability: { stillFrames: 3, motionThreshold: 0.02 } }),
      openRouterApiKey: null,
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}, 30_000);

afterAll(async () => {
  await app.close();
});

/** The "physical world": a page whose ink only ever accumulates. */
class FakeCamera {
  page = '.........';
  private frameSeed = 1000;

  constructor(private readonly mode: 'grid' | 'blank' | 'nothing' = 'grid') {}

  draw(cell: number, symbol: 'X' | 'O'): void {
    if (this.page[cell] !== '.') throw new Error(`test drew over ink at ${cell}`);
    this.page = this.page.slice(0, cell) + symbol + this.page.slice(cell + 1);
  }

  async jpeg(): Promise<string> {
    this.frameSeed++;
    const scene =
      this.mode === 'nothing'
        ? synthetic.renderScene({ seed: this.frameSeed })
        : synthetic.renderScene({
            quad: synthetic.defaultQuad(),
            paper: synthetic.renderPaper({ marks: this.page, grid: this.mode === 'grid', seed: 7 }),
            seed: this.frameSeed,
          });
    return (await encodeGrayToJpeg(scene)).toString('base64');
  }
}

class TestClient {
  private readonly ws: WebSocket;
  readonly snapshots: SessionSnapshot[] = [];
  readonly says: { category: string; text: string }[] = [];
  readonly asks: { id: string; cell: number }[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as ServerMessage;
      if (message.type === 'snapshot') this.snapshots.push(message.snapshot);
      if (message.type === 'say') this.says.push({ category: message.category, text: message.text });
      if (message.type === 'ask') this.asks.push({ id: message.ask.id, cell: message.ask.cell });
    });
  }

  static async connect(): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    return new TestClient(ws);
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  latest(): SessionSnapshot | undefined {
    return this.snapshots.at(-1);
  }

  /** Stream camera frames until the predicate holds (the loop is frame-driven). */
  async driveUntil(camera: FakeCamera, predicate: () => boolean, maxFrames = 120): Promise<void> {
    for (let i = 0; i < maxFrames; i++) {
      if (predicate()) return;
      this.send({ type: 'frame', jpegBase64: await camera.jpeg(), capturedAt: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!predicate()) {
      throw new Error(`predicate never satisfied; last phase=${this.latest()?.phase}, page unknown`);
    }
  }

  close(): void {
    this.ws.close();
  }
}

const toBoard = (s: string): Board => [...s].map((c): CellValue => (c === '.' ? null : (c as 'X' | 'O')));

let client: TestClient | null = null;
afterEach(() => {
  client?.close();
  client = null;
});

describe('end-to-end games over a real WebSocket', () => {
  it(
    'walks from an empty desk through setup prompts to a completed draw',
    async () => {
      client = await TestClient.connect();
      const c = client;

      // 1. Nothing on the desk → the agent asks for the paper.
      const nothing = new FakeCamera('nothing');
      await c.driveUntil(nothing, () => c.says.some((s) => s.text.toLowerCase().includes('paper')));

      // 2. Blank page → the agent asks for a grid.
      const blank = new FakeCamera('blank');
      await c.driveUntil(blank, () => c.says.some((s) => s.text.includes('3×3 grid')));

      // 3. Empty grid → game on. Human (X) moves first.
      const camera = new FakeCamera('grid');
      await c.driveUntil(camera, () => c.latest()?.phase === 'human_turn');
      expect(c.latest()!.gameNumber).toBe(1);

      // 4. Play a perfect human — the loop below is exactly the real protocol:
      //    ink first, agent detects, replies; we draw its mark, it verifies.
      for (let turn = 0; turn < 12 && c.latest()!.phase !== 'game_over'; turn++) {
        const snap = c.latest()!;
        if (snap.phase === 'human_turn') {
          camera.draw(bestMove(toBoard(camera.page), 'X').move, 'X');
          await c.driveUntil(camera, () => c.latest()!.phase !== 'human_turn');
        } else if (snap.phase === 'awaiting_agent_mark') {
          camera.draw(snap.pendingAgentCell!, 'O');
          await c.driveUntil(camera, () => c.latest()!.pendingAgentCell !== snap.pendingAgentCell);
        } else {
          throw new Error(`unexpected phase ${snap.phase}`);
        }
      }

      const final = c.latest()!;
      expect(final.phase).toBe('game_over');
      expect(final.result).toEqual({ winner: null, draw: true });
      // The reported final state matches the ink on the page, cell for cell.
      expect(final.board.map((v) => v ?? '.').join('')).toBe(camera.page);
      // The agent announced a move each round.
      expect(c.says.filter((s) => s.category === 'move').length).toBe(4);
      expect(c.says.some((s) => s.category === 'result')).toBe(true);
    },
    120_000,
  );

  it(
    'adopts an agent mark drawn in the wrong cell and finishes the game',
    async () => {
      client = await TestClient.connect();
      const c = client;
      const camera = new FakeCamera('grid');
      await c.driveUntil(camera, () => c.latest()?.phase === 'human_turn');

      // Human opens in the corner; agent will announce B2 (center).
      camera.draw(0, 'X');
      await c.driveUntil(camera, () => c.latest()!.phase === 'awaiting_agent_mark');
      const announced = c.latest()!.pendingAgentCell!;
      expect(announced).toBe(4);

      // The human "mishears" and draws the O in the bottom-right corner.
      camera.draw(8, 'O');
      await c.driveUntil(camera, () => c.says.some((s) => s.category === 'correction'));
      const snap = c.latest()!;
      expect(snap.board[8]).toBe('O'); // ink is truth — the drawn cell stands
      expect(snap.board[4]).toBeNull();
      expect(snap.phase).toBe('human_turn');

      // The game continues normally from the adopted position to completion.
      for (let turn = 0; turn < 12 && c.latest()!.phase !== 'game_over'; turn++) {
        const now = c.latest()!;
        if (now.phase === 'human_turn') {
          camera.draw(bestMove(toBoard(camera.page), 'X').move, 'X');
          await c.driveUntil(camera, () => c.latest()!.phase !== 'human_turn');
        } else {
          camera.draw(now.pendingAgentCell!, 'O');
          await c.driveUntil(camera, () => c.latest()!.pendingAgentCell !== now.pendingAgentCell);
        }
      }
      expect(c.latest()!.phase).toBe('game_over');
      expect(c.latest()!.board.map((v) => v ?? '.').join('')).toBe(camera.page);
    },
    120_000,
  );
});
