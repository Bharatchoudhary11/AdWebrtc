import React from 'react';
import { MetricSummary } from '../lib/metrics';
import { deviceId } from '../lib/device';

export default function StatsPanel({ metrics }: { metrics: MetricSummary }) {
  return (
    <div>
      <div>Device: {deviceId}</div>
      <div>Samples: {metrics.count}</div>
      <div>P50: {metrics.p50.toFixed(1)} ms</div>
      <div>P95: {metrics.p95.toFixed(1)} ms</div>
    </div>
  );
}
