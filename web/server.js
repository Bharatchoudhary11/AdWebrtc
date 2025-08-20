import express from 'express'
import { WebSocketServer } from 'ws'
import path from 'path'
import http from 'http'
import { fileURLToPath } from 'url'
import getPort, { portNumbers } from 'get-port'
import mime from 'mime'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
app.use(express.json({ limit: '1mb' }))

app.use((req, res, next) => {
  if (req.path.endsWith('.onnx')) {
    // Always use application/octet-stream for .onnx
    res.type('application/octet-stream');
  }
  next();
});

// expose MODE to browser
app.get('/env.js', (req, res) => {
  const mode = process.env.MODE || 'wasm'
  res.type('application/javascript').send(`window.MODE="${mode}";`)
})

// Simple metrics aggregator
let metrics = {
  mode: process.env.MODE || 'wasm',
  e2e: [],
  srv: [],
  net: [],
  fps: [],
  kb_up: { sum: 0, count: 0 },
  kb_down: { sum: 0, count: 0 },
}

const benchStart = (req, res) => {
  metrics = {
    mode: req.body?.mode || process.env.MODE || 'wasm',
    e2e: [],
    srv: [],
    net: [],
    fps: [],
    kb_up: { sum: 0, count: 0 },
    kb_down: { sum: 0, count: 0 },
  }
  res.json({ ok: true })
}

const benchStop = (req, res) => {
  const median = arr => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  const p95 = arr => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const i = Math.floor(0.95 * (s.length - 1));
    return s[i];
  }
  const buildHist = arr => {
    const bins = Array(20).fill(0);
    for (const v of arr) {
      const idx = Math.min(bins.length - 1, Math.floor(v / 50));
      bins[idx]++;
    }
    return bins;
  }
  const avg = m => (m.count ? m.sum / m.count : 0);
  const out = {
    e2e_latency_ms: {
      median: Math.round(median(metrics.e2e)),
      p95: Math.round(p95(metrics.e2e)),
      histogram: buildHist(metrics.e2e),
    },
    server_latency_ms: {
      median: Math.round(median(metrics.srv)),
      p95: Math.round(p95(metrics.srv)),
    },
    network_latency_ms: {
      median: Math.round(median(metrics.net)),
      p95: Math.round(p95(metrics.net)),
    },
    processed_fps: Number(median(metrics.fps).toFixed(1)),
    uplink_kbps: Math.round(avg(metrics.kb_up)),
    downlink_kbps: Math.round(avg(metrics.kb_down)),
  }
  res.json(out)
}

app.post('/bench-start', benchStart)
app.get('/bench-stop', benchStop)
// Compatibility with older scripts
app.post('/api/bench/reset', benchStart)
app.get('/api/bench/dump', benchStop)

app.post('/api/bench/push', (req, res) => {
  const { e2e, fps, kbps_up, kbps_down, server_latency_ms, network_latency_ms } = req.body || {}
  if (typeof e2e === 'number') metrics.e2e.push(e2e)
  if (typeof server_latency_ms === 'number') metrics.srv.push(server_latency_ms)
  if (typeof network_latency_ms === 'number') metrics.net.push(network_latency_ms)
  if (typeof fps === 'number') metrics.fps.push(fps)
  if (typeof kbps_up === 'number') {
    metrics.kb_up.sum += kbps_up
    metrics.kb_up.count++
  }
  if (typeof kbps_down === 'number') {
    metrics.kb_down.sum += kbps_down
    metrics.kb_down.count++
  }
  res.json({ ok: true })
})

// Serve built client after API routes so they aren't shadowed
app.use(express.static(path.join(__dirname, 'dist')))
app.use(express.static(path.join(__dirname, 'public')))

// ----- SINGLE HTTP SERVER + WS on same port -----
const httpServer = http.createServer(app)
const wss = new WebSocketServer({ server: httpServer, path: '/signal' })

let peers = []
wss.on('connection', (ws) => {
  peers.push(ws)
  ws.on('close', () => { peers = peers.filter(p => p !== ws) })
  ws.on('message', (data) => {
    for (const p of peers) if (p !== ws && p.readyState === 1) p.send(data)
  })
})

// ----- Pick a free port (prefer PORT or 3000..3100) -----
const preferred = Number(process.env.PORT) || 3000
const port = await getPort({ port: portNumbers(preferred, preferred + 100) })

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Web server listening on http://0.0.0.0:${port}`)
})

// helpful debug
httpServer.on('error', (err) => {
  console.error('[web] server error:', err)
})

