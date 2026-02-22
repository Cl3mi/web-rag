/**
 * Rate Limiter
 *
 * Simple token bucket rate limiter for controlling request rates.
 */

export interface RateLimiterOptions {
  /** Maximum requests per interval */
  maxRequests: number;
  /** Interval in milliseconds */
  intervalMs: number;
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;

  constructor(options: RateLimiterOptions) {
    this.maxTokens = options.maxRequests;
    this.tokens = options.maxRequests;
    this.lastRefill = Date.now();
    this.refillRate = options.maxRequests / options.intervalMs;
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Try to acquire a token
   * @returns true if token acquired, false otherwise
   */
  tryAcquire(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Wait until a token is available
   */
  async acquire(): Promise<void> {
    while (!this.tryAcquire()) {
      // Calculate wait time for next token
      const waitTime = Math.ceil((1 - this.tokens) / this.refillRate);
      await this.sleep(Math.max(waitTime, 10));
    }
  }

  /**
   * Get the time to wait until next token is available
   */
  getWaitTime(): number {
    this.refill();

    if (this.tokens >= 1) return 0;

    return Math.ceil((1 - this.tokens) / this.refillRate);
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Default rate limiter for web scraping (10 requests per second)
export const defaultRateLimiter = new RateLimiter({
  maxRequests: 10,
  intervalMs: 1000,
});

// More aggressive rate limiter (2 requests per second)
export const conservativeRateLimiter = new RateLimiter({
  maxRequests: 2,
  intervalMs: 1000,
});
