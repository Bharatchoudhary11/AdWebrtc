import express from 'express'
import { WebSocketServer } from 'ws'
import path from 'path'
import http from 'http'
import https from 'https'
import fs from 'fs'
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
  const serverUrl = process.env.SERVER_URL || ''
  const lines = [`window.MODE="${mode}";`]
  if (serverUrl) lines.push(`window.SERVER_URL="${serverUrl}";`)
  res.type('application/javascript').send(lines.join('\n'))
})

// Simple metrics aggregator keyed by device ID
let metricsMode = process.env.MODE || 'wasm'
let metricsByDevice = {}

const initMetrics = () => ({
  mode: metricsMode,
  e2e: [],
  srv: [],
  net: [],
  fps: [],
  kb_up: { sum: 0, count: 0 },
  kb_down: { sum: 0, count: 0 },
})

const benchStart = (req, res) => {
  metricsMode = req.body?.mode || process.env.MODE || 'wasm'
  metricsByDevice = {}
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
  const summarize = (m) => ({
    e2e_latency_ms: {
      median: Math.round(median(m.e2e)),
      p95: Math.round(p95(m.e2e)),
      histogram: buildHist(m.e2e),
    },
    server_latency_ms: {
      median: Math.round(median(m.srv)),
      p95: Math.round(p95(m.srv)),
    },
    network_latency_ms: {
      median: Math.round(median(m.net)),
      p95: Math.round(p95(m.net)),
    },
    processed_fps: Number(median(m.fps).toFixed(1)),
    uplink_kbps: Math.round(avg(m.kb_up)),
    downlink_kbps: Math.round(avg(m.kb_down)),
    mode: m.mode,
  })
  const out = {}
  for (const [id, m] of Object.entries(metricsByDevice)) {
    out[id] = summarize(m)
  }
  res.json(out)
}

app.post('/bench-start', benchStart)
app.get('/bench-stop', benchStop)
// Compatibility with older scripts
app.post('/api/bench/reset', benchStart)
app.get('/api/bench/dump', benchStop)

// ---------------------------------------------------------------------------
// Simple credential issuance helpers
// ---------------------------------------------------------------------------

/**
 * Persist issued credentials in-memory so the UI can query them after the
 * initial POST succeeds. This keeps the implementation lightweight while still
 * allowing the front-end to surface previously issued credentials.
 */
const issuedCredentials = new Map()

const generateCredentialId = () =>
  `cred_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

const sanitizeClaims = (claims) => {
  if (!claims || typeof claims !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(claims)) {
    if (typeof value === 'object') {
      out[key] = sanitizeClaims(value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

app.post('/api/credentials', (req, res) => {
  const { subject, claims, issuer } = req.body || {}

  if (typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ error: 'subject is required' })
  }

  const issuedAt = new Date().toISOString()
  const id = generateCredentialId()

  const credential = {
    id,
    issuer: issuer || 'https://localhost:4000',
    subject: subject.trim(),
    issuedAt,
    claims: sanitizeClaims(claims),
  }

  issuedCredentials.set(id, credential)

  return res.status(201).json({ credential })
})

app.get('/api/credentials', (_req, res) => {
  const credentials = Array.from(issuedCredentials.values())
  res.json({ credentials })
})

app.get('/api/credentials/:id', (req, res) => {
  const credential = issuedCredentials.get(req.params.id)
  if (!credential) {
    return res.status(404).json({ error: 'Credential not found' })
  }
  res.json({ credential })
})

app.post('/api/bench/push', (req, res) => {
  const { device_id, e2e, fps, kbps_up, kbps_down, server_latency_ms, network_latency_ms } = req.body || {}
  const id = device_id || req.headers['user-agent'] || 'unknown'
  if (!metricsByDevice[id]) metricsByDevice[id] = initMetrics()
  const m = metricsByDevice[id]
  if (typeof e2e === 'number') m.e2e.push(e2e)
  if (typeof server_latency_ms === 'number') m.srv.push(server_latency_ms)
  if (typeof network_latency_ms === 'number') m.net.push(network_latency_ms)
  if (typeof fps === 'number') m.fps.push(fps)
  if (typeof kbps_up === 'number') {
    m.kb_up.sum += kbps_up
    m.kb_up.count++
  }
  if (typeof kbps_down === 'number') {
    m.kb_down.sum += kbps_down
    m.kb_down.count++
  }
  res.json({ ok: true })
})

// Serve built client after API routes so they aren't shadowed
app.use(express.static(path.join(__dirname, 'dist')))
app.use(express.static(path.join(__dirname, 'public')))

// ----- SINGLE HTTP/HTTPS SERVER + WS on same port -----
// Allow serving over HTTPS when SSL cert/key are provided. Browsers block
// camera/mic access on plain HTTP for non-localhost origins, so enabling HTTPS
// lets phones join via IP without getUserMedia failures.
let httpServer
if (process.env.HTTPS === 'true') {
  const keyPath = process.env.SSL_KEY || path.join(__dirname, 'cert', 'key.pem')
  const certPath = process.env.SSL_CERT || path.join(__dirname, 'cert', 'cert.pem')
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  }
  httpServer = https.createServer(options, app)
} else {
  httpServer = http.createServer(app)
}
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
  const proto = process.env.HTTPS === 'true' ? 'https' : 'http'
  console.log(`Web server listening on ${proto}://0.0.0.0:${port}`)
})

// helpful debug
httpServer.on('error', (err) => {
  console.error('[web] server error:', err)
})

