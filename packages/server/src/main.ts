import { createAnalyzer } from '@vistactoe/vision';
import { buildServer } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const analyzer = await createAnalyzer();
const app = await buildServer({
  analyzer,
  config,
  feedbackDir: process.env.VISTACTOE_DATA ?? 'data',
  logSink: (event) => {
    if (event.type !== 'board_observed') console.log('[event]', JSON.stringify(event));
  },
});

await app.listen({ port: config.app.port, host: '0.0.0.0' });
const address = app.server.address();
const port = typeof address === 'object' && address ? address.port : config.app.port;
console.log(`VisTacToe server on http://localhost:${port}`);
console.log(`  VLM tier: ${config.app.vlm.enabled ? `enabled (${config.app.vlm.models.join(' → ')})` : 'disabled'}`);
