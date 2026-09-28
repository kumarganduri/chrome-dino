// Stand-in for chrome://resources/js/assert.js (same contract: throw on falsy).
export function assert(value: unknown, message?: string): asserts value {
  if (!value) {
    throw new Error(message ?? 'Assertion failed');
  }
}

export function assertNotReached(message?: string): never {
  throw new Error(message ?? 'Unreachable code hit');
}
