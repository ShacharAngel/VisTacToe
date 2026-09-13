import { expect, it } from 'vitest';
import { VISION_PIPELINE } from '@vistactoe/vision';

it('loads', () => {
  expect(VISION_PIPELINE).toBe('classical');
});
