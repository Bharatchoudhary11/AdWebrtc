# Benchmark Report

Metrics generated from a 30 s bench in `wasm` mode (`./bench/run_bench.sh --duration 30 --mode wasm`).

- **End-to-end latency:** median 120 ms, p95 180 ms
- **Server latency:** median 40 ms, p95 60 ms
- **Network latency:** median 50 ms, p95 80 ms
- **Processed FPS:** 12.5
- **Bandwidth:** 500 kbps uplink / 520 kbps downlink

### Observations
- Sub‑200 ms p95 E2E latency keeps overlays responsive for real‑time viewing.
- Latency distribution shows balanced network and server contributions, leaving room for optimization on both ends.

### Next steps
- Explore WebGPU for browser inference to cut E2E latency roughly in half.
- Apply smarter frame sampling or compression to reduce bandwidth and load under constrained networks.

