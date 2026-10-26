const MAX_TRACKED_BUCKETS = 10_000;

/** A replica-local token bucket per key; idle keys are evicted to bound memory. */
export class RequestRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  private readonly burst: number;
  private readonly ratePerSecond: number;
  private readonly now: () => number;

  constructor(burst: number, ratePerSecond: number, now: () => number = () => performance.now()) {
    this.burst = burst;
    this.ratePerSecond = ratePerSecond;
    this.now = now;
  }

  /** Consume one request, or return the number of seconds to wait before retrying. */
  consume(key: string): number | undefined {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, updatedAt: now };
    bucket.tokens = Math.min(
      this.burst,
      bucket.tokens + (Math.max(0, now - bucket.updatedAt) / 1000) * this.ratePerSecond,
    );
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      this.remember(key, bucket);
      return Math.max(1, Math.ceil((1 - bucket.tokens) / this.ratePerSecond));
    }
    bucket.tokens -= 1;
    this.remember(key, bucket);
    return undefined;
  }

  private remember(key: string, bucket: { tokens: number; updatedAt: number }): void {
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > MAX_TRACKED_BUCKETS) {
      this.buckets.delete(this.buckets.keys().next().value!);
    }
  }
}
