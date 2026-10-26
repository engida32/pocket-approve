const SWEEP_AT = 1024;

export function createRateLimiter({ now = Date.now } = {}) {
  const buckets = new Map();

  function sweep(at) {
    if (buckets.size < SWEEP_AT) return;
    for (const [key, bucket] of buckets) {
      if (at >= bucket.resetAt) buckets.delete(key);
    }
  }

  function take(key, limit, windowMs) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
      throw new TypeError("limit and windowMs must be positive integers");
    }
    const at = now();
    sweep(at);
    let bucket = buckets.get(key);
    if (!bucket || at >= bucket.resetAt) {
      bucket = { count: 0, resetAt: at + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= limit) return Math.max(1, Math.ceil((bucket.resetAt - at) / 1000));
    bucket.count += 1;
    return 0;
  }
  return { take, size: () => buckets.size };
}
