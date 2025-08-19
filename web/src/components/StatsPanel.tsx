import React from 'react';
import { MetricSummary } from '../lib/metrics';

export default function StatsPanel({ metrics }: { metrics: MetricSummary }) {
  return (
    <div>
      <div>Samples: {metrics.count}</div>
      <div>P50: {metrics.p50.toFixed(1)} ms</div>
      <div>P95: {metrics.p95.toFixed(1)} ms</div>
    </div>
  );
}
