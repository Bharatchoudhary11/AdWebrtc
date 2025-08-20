import { deviceId } from './device';

export interface MetricSummary {
  count: number;
  p50: number;
  p95: number;
}

export class Metrics {
  private e2e: number[] = [];
  private server: number[] = [];
  private network: number[] = [];

  record(sent: number, received: number, extra?: { server?: number; network?: number }) {
    const latency = received - sent;
    this.e2e.push(latency);
    if (typeof extra?.server === 'number') this.server.push(extra.server);
    if (typeof extra?.network === 'number') this.network.push(extra.network);
    // Best-effort push to backend bench aggregator. Ignore failures so normal
    // operation is unaffected if the endpoint is missing (e.g. outside bench
    // runs). Only attempt this when building for production to avoid noisy
    // errors during local development.
    if (import.meta.env.PROD) {
      const payload: Record<string, number | string> = {
        device_id: deviceId,
        e2e: latency,
      };
      if (typeof extra?.server === 'number') payload.server_latency_ms = extra.server;
      if (typeof extra?.network === 'number') payload.network_latency_ms = extra.network;
      void fetch('/api/bench/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => {
        /* no-op */
      });
    }
  }

  summary(): MetricSummary {
    const arr = [...this.e2e].sort((a, b) => a - b);
    const q = (p: number) =>
      arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : 0;
    return {
      count: arr.length,
      p50: q(0.5),
      p95: q(0.95)
    };
  }

  toJSON() {
    const summarize = (arr: number[]): MetricSummary => {
      const s = [...arr].sort((a, b) => a - b);
      const q = (p: number) =>
        s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : 0;
      return { count: s.length, p50: q(0.5), p95: q(0.95) };
    };
    return {
      e2e_latency_ms: summarize(this.e2e),
      server_latency_ms: summarize(this.server),
      network_latency_ms: summarize(this.network),
    };
  }
}
