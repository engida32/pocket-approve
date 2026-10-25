export function createRateLimiter({ now = Date.now } = {}) {
  const buckets = new Map();
  function take(key, limit, windowMs) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
      throw new TypeError("limit and windowMs must be positive integers");
    }
    const at = now();
    let bucket = buckets.get(key);
    if (!bucket || at >= bucket.resetAt) {
      bucket = { count: 0, resetAt: at + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= limit) return Math.max(1, Math.ceil((bucket.resetAt - at) / 1000));
    bucket.count += 1;
    return 0;
  }
  return { take };
}
