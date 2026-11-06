/** DEX protocol times use seconds; Date.now and React timers use milliseconds. */
export function quoteSecondsRemaining(expiresAtSeconds: number, nowMilliseconds = Date.now()) {
  if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds < 0) throw new Error('Invalid quote timestamp');
  return Math.max(0, Math.ceil((expiresAtSeconds * 1000 - nowMilliseconds) / 1000));
}
