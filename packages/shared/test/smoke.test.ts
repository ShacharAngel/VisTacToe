import { expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@vistactoe/shared';
import { emptyBoard } from '@vistactoe/engine';

// Also proves cross-workspace TS-source resolution works under Vitest.
it('resolves workspace packages from TS source', () => {
  expect(PROTOCOL_VERSION).toBe(1);
  expect(emptyBoard()).toHaveLength(9);
});
