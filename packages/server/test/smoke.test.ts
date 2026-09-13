import { expect, it } from 'vitest';
import { SERVER_NAME } from '@vistactoe/server';

it('loads', () => {
  expect(SERVER_NAME).toBe('@vistactoe/server');
});
