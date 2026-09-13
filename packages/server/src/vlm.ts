import type { CellLabel } from '@vistactoe/shared';

/**
 * Tier-2 perception: a vision model reads ONE cell crop and answers X/O/empty.
 * Deliberately per-cell — published evaluations show VLMs collapse on grid
 * *spatial indexing* (which cell a mark is in) while staying strong at pure
 * "what is this mark" classification, so we never ask a spatial question.
 * Every failure mode (timeout, refusal, bad JSON, HTTP error) degrades to
 * null, which the caller treats as "fall through to asking the human".
 */

export interface VlmVerdict {
  label: CellLabel;
  confidence: number;
}

export interface VlmClient {
  classifyCell(cellJpeg: Buffer): Promise<VlmVerdict | null>;
}

export interface OpenRouterOptions {
  apiKey: string;
  /** Tried in order by OpenRouter's models[] routing — cross-vendor failover in one request. */
  models: string[];
  timeoutMs: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const PROMPT =
  'This image is a crop of ONE cell of a hand-drawn paper tic-tac-toe board. ' +
  'Classify the pen mark in the cell: "X" for a cross of two strokes, "O" for a drawn circle or oval (even if not fully closed), ' +
  '"empty" if there is no deliberate pen mark (faint smudges, shadows and grid-line slivers count as empty). ' +
  'Respond with JSON only.';

const RESPONSE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'cell_classification',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        label: { type: 'string', enum: ['X', 'O', 'empty'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['label', 'confidence'],
      additionalProperties: false,
    },
  },
} as const;

export function createOpenRouterClient(options: OpenRouterOptions): VlmClient {
  const { apiKey, models, timeoutMs, baseUrl = 'https://openrouter.ai/api/v1', fetchImpl = fetch } = options;

  return {
    async classifyCell(cellJpeg: Buffer): Promise<VlmVerdict | null> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            models,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: PROMPT },
                  {
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${cellJpeg.toString('base64')}` },
                  },
                ],
              },
            ],
            response_format: RESPONSE_SCHEMA,
            // Only route to endpoints that actually enforce the schema.
            provider: { require_parameters: true },
            max_tokens: 200,
            temperature: 0,
          }),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = body.choices?.[0]?.message?.content;
        if (!content) return null;
        const parsed = JSON.parse(content) as { label?: string; confidence?: number };
        if (parsed.label !== 'X' && parsed.label !== 'O' && parsed.label !== 'empty') return null;
        const confidence = typeof parsed.confidence === 'number' ? Math.min(Math.max(parsed.confidence, 0), 1) : 0;
        return { label: parsed.label, confidence };
      } catch {
        return null; // timeout, network, refusal, malformed JSON — all degrade to tier 3
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
