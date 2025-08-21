import React from 'react';
import { MetricSummary, LatencySummary } from '../lib/metrics';
import { deviceId } from '../lib/device';

export default function StatsPanel({ metrics }: { metrics: LatencySummary }) {
  const render = (label: string, m: MetricSummary) => (
    <div>
      <div><strong>{label}</strong></div>
      <div>Samples: {m.count}</div>
      <div>P50: {m.p50.toFixed(1)} ms</div>
      <div>P95: {m.p95.toFixed(1)} ms</div>
    </div>
  );

  return (
    <div>
      <div>Device: {deviceId}</div>
      {render('End-to-end', metrics.e2e)}
      {render('Server', metrics.server)}
      {render('Network', metrics.network)}
    </div>
  );
}
