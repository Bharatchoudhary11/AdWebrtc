export interface MetricSummary {
  count: number;
  p50: number;
  p95: number;
}

export class Metrics {
  private latencies: number[] = [];

  record(sent: number, received: number) {
    const latency = received - sent;
    this.latencies.push(latency);
    // Best-effort push to backend bench aggregator. Ignore failures so normal
    // operation is unaffected if the endpoint is missing (e.g. outside bench
    // runs). Only attempt this when building for production to avoid noisy
    // errors during local development.
    if (import.meta.env.PROD) {
      void fetch('/api/bench/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ e2e: latency })
      }).catch(() => {
        /* no-op */
      });
    }
  }

  summary(): MetricSummary {
    const arr = [...this.latencies].sort((a, b) => a - b);
    const q = (p: number) =>
      arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : 0;
    return {
      count: arr.length,
      p50: q(0.5),
      p95: q(0.95)
    };
  }

  toJSON() {
    return this.summary();
  }
}
