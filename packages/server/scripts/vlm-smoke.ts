/**
 * Live smoke test for the OpenRouter tier (NOT part of CI — costs a fraction
 * of a cent and needs a key):
 *
 *   OPENROUTER_API_KEY=sk-or-... npx tsx packages/server/scripts/vlm-smoke.ts
 *
 * Renders synthetic X / O / empty cells and checks the model reads them.
 */
import { defaultConfig } from '@vistactoe/shared';
import { cropCell, createAnalyzer, encodeGrayToJpeg, synthetic } from '@vistactoe/vision';
import { createOpenRouterClient } from '@vistactoe/server';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('Set OPENROUTER_API_KEY first.');
  process.exit(1);
}

const client = createOpenRouterClient({
  apiKey,
  models: defaultConfig.vlm.models,
  timeoutMs: 10_000,
});

const analyzer = await createAnalyzer();
const cases: { marks: string; cell: number; expected: string }[] = [
  { marks: 'X........', cell: 0, expected: 'X' },
  { marks: '....O....', cell: 4, expected: 'O' },
  { marks: 'X...O....', cell: 8, expected: 'empty' },
];

for (const { marks, cell, expected } of cases) {
  const scene = synthetic.renderScene({
    quad: synthetic.defaultQuad(),
    paper: synthetic.renderPaper({ marks, seed: 11 }),
    seed: 42,
  });
  const analysis = analyzer.analyzeFrame(scene);
  if (analysis.kind !== 'grid') throw new Error(`expected grid, got ${analysis.kind}`);
  const crop = cropCell(analysis.rectified, analysis.grid, Math.floor(cell / 3), cell % 3, 0.04);
  const started = Date.now();
  const verdict = await client.classifyCell(await encodeGrayToJpeg(crop));
  const ms = Date.now() - started;
  const ok = verdict?.label === expected ? '✅' : '❌';
  console.log(`${ok} cell ${cell} (${expected}): got ${verdict?.label ?? 'null'} conf=${verdict?.confidence ?? '-'} in ${ms}ms`);
}
