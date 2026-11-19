import { expect, test } from 'bun:test';

test('scratch: one deliberately failing test (RFC 0029 D2 check)', () => {
  expect(1).toBe(2);
});
