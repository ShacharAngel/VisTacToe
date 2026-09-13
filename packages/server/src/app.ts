import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ClientMessage } from '@vistactoe/shared';
import type { Analyzer } from '@vistactoe/vision';
import type { ServerConfig } from './config.js';
import { FeedbackStore } from './feedback/store.js';
import { SessionPipeline, type LogSink } from './pipeline.js';
import { createOpenRouterClient, type VlmClient } from './vlm.js';

const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

export interface BuildOptions {
  analyzer: Analyzer;
  config: ServerConfig;
  logSink?: LogSink;
  /** Injectable for tests; defaults to a real OpenRouter client when the tier is enabled. */
  vlmClient?: VlmClient | null;
  /** Directory for the persisted feedback state (Section 2); omit to disable. */
  feedbackDir?: string | null;
}

export async function buildServer({ analyzer, config, logSink, vlmClient, feedbackDir }: BuildOptions): Promise<FastifyInstance> {
  const store = feedbackDir ? new FeedbackStore(feedbackDir, config.app.confidence.ask) : null;
  const sink: LogSink = (event) => {
    store?.append(event);
    logSink?.(event);
  };
  const vlm =
    vlmClient !== undefined
      ? vlmClient
      : config.app.vlm.enabled && config.openRouterApiKey
        ? createOpenRouterClient({
            apiKey: config.openRouterApiKey,
            models: config.app.vlm.models,
            timeoutMs: config.app.vlm.timeoutMs,
          })
        : null;
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket, { options: { maxPayload: 2 * 1024 * 1024 } });

  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
  }

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/api/config', async () => ({
    humanFirst: config.app.humanFirst,
    humanSymbol: config.app.humanSymbol,
    vlmEnabled: config.app.vlm.enabled,
  }));

  const debugDir = process.env.VISTACTOE_DEBUG ? process.env.VISTACTOE_DEBUG : null;

  app.get('/ws', { websocket: true }, (socket) => {
    // One pipeline (session + watcher) per connected camera client.
    const pipeline = new SessionPipeline(analyzer, config.app, sink, vlm, store, debugDir);
    const send = (messages: import('@vistactoe/shared').ServerMessage[]): void => {
      for (const message of messages) {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      }
    };
    send(pipeline.hello());

    let queue = Promise.resolve();
    socket.on('message', (raw: Buffer) => {
      let parsed: ClientMessage;
      try {
        parsed = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      // Serialize handling, and never let one bad frame reject the queue or
      // crash the process — a dropped frame is fine, a dead server is not.
      queue = queue.then(async () => {
        try {
          switch (parsed.type) {
            case 'frame':
              send(await pipeline.handleFrame(parsed.jpegBase64));
              break;
            case 'answer':
              send(await pipeline.handleAnswer(parsed.askId, parsed.label));
              break;
            case 'control':
              send(await pipeline.handleControl(parsed.action));
              break;
          }
        } catch (err) {
          logSink?.({ type: 'frame_error', message: err instanceof Error ? err.message : String(err) });
        }
      });
    });
  });

  return app;
}
