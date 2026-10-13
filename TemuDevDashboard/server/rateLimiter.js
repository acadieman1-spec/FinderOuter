/**
 * rateLimiter.js — per-app_key token bucket matching Temu's default quota of
 * 20 requests/second, plus the counters the dashboard surfaces on the
 * "Rate limit" gauge.
 */

export class TokenBucket {
  constructor({ capacity = 20, refillPerSec = 20, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.last = now();
    this.now = now;
    this.stats = { granted: 0, waited: 0, totalWaitMs: 0, denied: 0, peakPerSec: 0, window: [] };
  }

  #refill() {
    const t = this.now();
    const elapsed = (t - this.last) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
      this.last = t;
    }
  }

  /** Tokens available right now (fractional). */
  available() {
    this.#refill();
    return this.tokens;
  }

  /** Non-blocking acquire. Returns true when a token was taken. */
  tryAcquire() {
    this.#refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.#record();
      this.stats.granted++;
      return true;
    }
    this.stats.denied++;
    return false;
  }

  #record() {
    const sec = Math.floor(this.now() / 1000);
    const w = this.stats.window;
    if (!w.length || w[w.length - 1].sec !== sec) w.push({ sec, n: 1 });
    else w[w.length - 1].n++;
    while (w.length && w[0].sec < sec - 9) w.shift();
    this.stats.peakPerSec = Math.max(this.stats.peakPerSec, w[w.length - 1].n);
  }

  /** Wait until a token is available, then take it. Resolves with waited ms. */
  async acquire({ maxWaitMs = 30_000 } = {}) {
    const start = this.now();
    for (;;) {
      if (this.tryAcquire()) {
        const waited = this.now() - start;
        if (waited > 5) {
          this.stats.waited++;
          this.stats.totalWaitMs += waited;
        }
        return waited;
      }
      const need = (1 - this.tokens) / this.refillPerSec * 1000;
      const sleep = Math.max(5, Math.min(need, 250));
      if (this.now() - start + sleep > maxWaitMs) throw new Error('rate limiter wait exceeded');
      await new Promise((r) => setTimeout(r, sleep));
    }
  }

  setRate(qps) {
    this.capacity = qps;
    this.refillPerSec = qps;
    this.tokens = Math.min(this.tokens, qps);
  }

  snapshot() {
    return {
      capacity: this.capacity,
      refillPerSec: this.refillPerSec,
      tokens: Math.round(this.available() * 100) / 100,
      ...this.stats,
      recentPerSec: this.stats.window.map(({ sec, n }) => ({ sec, n })),
    };
  }
}
