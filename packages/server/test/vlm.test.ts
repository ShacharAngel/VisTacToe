import { beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig, mergeConfig, type ServerMessage } from '@vistactoe/shared';
import { createAnalyzer, encodeGrayToJpeg, synthetic, type Analyzer } from '@vistactoe/vision';
import { createOpenRouterClient, SessionPipeline, type VlmClient } from '@vistactoe/server';

const CELL = Buffer.from('fake-jpeg');

function okResponse(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createOpenRouterClient', () => {
  it('sends the defended request shape and parses the verdict', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ label: 'X', confidence: 0.92 }));
    const client = createOpenRouterClient({
      apiKey: 'k',
      models: ['google/gemini-3.1-flash-lite', 'openai/gpt-5.6-luna'],
      timeoutMs: 1000,
      fetchImpl,
    });

    const verdict = await client.classifyCell(CELL);
    expect(verdict).toEqual({ label: 'X', confidence: 0.92 });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.models).toEqual(['google/gemini-3.1-flash-lite', 'openai/gpt-5.6-luna']);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.provider).toEqual({ require_parameters: true });
    const image = body.messages[0].content.find((p: { type: string }) => p.type === 'image_url');
    expect(image.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer k' });
  });

  it('returns null on HTTP errors', async () => {
    const client = createOpenRouterClient({
      apiKey: 'k',
      models: ['m'],
      timeoutMs: 1000,
      fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 500 })),
    });
    expect(await client.classifyCell(CELL)).toBeNull();
  });

  it('returns null on malformed content', async () => {
    const client = createOpenRouterClient({
      apiKey: 'k',
      models: ['m'],
      timeoutMs: 1000,
      fetchImpl: vi.fn().mockResolvedValue(okResponse({ label: 'banana', confidence: 2 })),
    });
    expect(await client.classifyCell(CELL)).toBeNull();
  });

  it('times out and degrades to null', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const client = createOpenRouterClient({ apiKey: 'k', models: ['m'], timeoutMs: 50, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.classifyCell(CELL)).toBeNull();
  });
});

describe('pipeline escalation through the VLM tier', () => {
  const { renderPaper, renderScene, defaultQuad } = synthetic;
  let analyzer: Analyzer;

  beforeAll(async () => {
    analyzer = await createAnalyzer();
  }, 30_000);

  async function jpegFrame(marks: string, noiseSeed: number): Promise<string> {
    const scene = renderScene({ quad: defaultQuad(), paper: renderPaper({ marks, seed: 7 }), seed: noiseSeed });
    return (await encodeGrayToJpeg(scene)).toString('base64');
  }

  /** ask threshold of 0.999 forces every mark through the escalation path. */
  function escalatingConfig() {
    return mergeConfig({
      confidence: { ask: 0.999 },
      stability: { ...defaultConfig.stability, stillFrames: 3 },
      vlm: { ...defaultConfig.vlm, enabled: true },
    });
  }

  it('lets a confident VLM verdict answer instead of the human', async () => {
    const vlm: VlmClient = { classifyCell: vi.fn().mockResolvedValue({ label: 'X', confidence: 1 }) };
    const events: { type: string }[] = [];
    const pipeline = new SessionPipeline(analyzer, escalatingConfig(), (e) => events.push(e), vlm);

    for (let seed = 1; seed <= 6; seed++) await pipeline.handleFrame(await jpegFrame('.........', seed));

    let messages: ServerMessage[] = [];
    for (let seed = 10; seed <= 16; seed++) {
      messages = [...messages, ...(await pipeline.handleFrame(await jpegFrame('X........', seed)))];
    }
    // The question never reached the client…
    expect(messages.filter((m) => m.type === 'ask')).toHaveLength(0);
    // …the VLM was consulted and its answer committed the move.
    expect(events.some((e) => e.type === 'vlm_call')).toBe(true);
    expect(events.some((e) => e.type === 'answer' && (e as { source?: string }).source === 'vlm')).toBe(true);
    const last = messages.at(-1);
    expect(last?.type).toBe('snapshot');
    if (last?.type === 'snapshot') expect(last.snapshot.board[0]).toBe('X');
  }, 30_000);

  it('falls through to the human when the VLM shrugs', async () => {
    const vlm: VlmClient = { classifyCell: vi.fn().mockResolvedValue(null) };
    const pipeline = new SessionPipeline(analyzer, escalatingConfig(), () => {}, vlm);

    for (let seed = 1; seed <= 6; seed++) await pipeline.handleFrame(await jpegFrame('.........', seed));

    let asks = 0;
    for (let seed = 10; seed <= 16; seed++) {
      const messages = await pipeline.handleFrame(await jpegFrame('X........', seed));
      asks += messages.filter((m) => m.type === 'ask').length;
    }
    expect(asks).toBeGreaterThan(0);
  }, 30_000);
});
