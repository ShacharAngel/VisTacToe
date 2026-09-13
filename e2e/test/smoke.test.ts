import { expect, it } from 'vitest';
import { SERVER_NAME } from '@vistactoe/server';

// Full-loop e2e (synthetic frame sequences over a real WebSocket) lands in Step 8.
it('loads the server package', () => {
  expect(SERVER_NAME).toBe('@vistactoe/server');
});
