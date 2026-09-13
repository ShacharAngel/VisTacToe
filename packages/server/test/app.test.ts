import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import type { ServerMessage } from '@vistactoe/shared';
import { createAnalyzer } from '@vistactoe/vision';
import { buildServer, loadConfig } from '@vistactoe/server';

let app: FastifyInstance;
let port: number;

beforeAll(async () => {
  const analyzer = await createAnalyzer();
  app = await buildServer({ analyzer, config: loadConfig({}) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}, 30_000);

afterAll(async () => {
  await app.close();
});

describe('server app', () => {
  it('serves health and public config', async () => {
    const health = await app.inject({ url: '/health' });
    expect(health.json()).toEqual({ status: 'ok' });
    const config = await app.inject({ url: '/api/config' });
    expect(config.json()).toMatchObject({ humanFirst: true, vlmEnabled: false });
  });

  it('greets a websocket client with a snapshot and answers controls', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: ServerMessage[] = [];
    const collected = new Promise<void>((resolve) => {
      socket.on('message', (raw) => {
        messages.push(JSON.parse(String(raw)) as ServerMessage);
        // hello snapshot + (say + snapshot) after the control message
        if (messages.length >= 3) resolve();
      });
    });
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    socket.send(JSON.stringify({ type: 'control', action: 'new_game' }));
    await collected;
    socket.close();

    expect(messages[0]?.type).toBe('snapshot');
    expect(messages.some((m) => m.type === 'say')).toBe(true);
    const last = messages.at(-1);
    expect(last?.type).toBe('snapshot');
    if (last?.type === 'snapshot') expect(last.snapshot.phase).toBe('game_over');
  });
});
