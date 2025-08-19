export interface MetricSummary {
  count: number;
  p50: number;
  p95: number;
}

export class Metrics {
  private latencies: number[] = [];

  record(sent: number, received: number) {
    this.latencies.push(received - sent);
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
