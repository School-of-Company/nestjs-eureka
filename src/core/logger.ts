/**
 * A structural logging interface — deliberately not an adapter class.
 * Nest's own `Logger` (and `console`) already satisfy this shape.
 */
export interface EurekaLogger {
  // Property (not method) syntax deliberately — this avoids
  // @typescript-eslint/unbound-method false positives when a mock's
  // `logger.warn` is passed to `expect(...)` in tests, and correctly
  // reflects that these are plain callbacks with no `this` binding.
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}
