import express from 'express'
import { WebSocketServer } from 'ws'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '1mb' }))

// Serve built client
app.use(express.static(path.join(__dirname, 'dist')))

// expose MODE to browser
app.get('/env.js', (req, res) => {
  res.type('application/javascript').send(`window.MODE="${process.env.MODE || 'wasm'}";`)
})

// Inject MODE to window
app.get('/', (req, res, next) => {
  // serve index.html with MODE injected is handled by static; nothing custom here
  next()
})

// Simple metrics aggregator (browser posts E2E samples via /api/bench endpoints if needed)
let metrics = { mode: process.env.MODE || 'wasm', e2e: [], fps: [], kb_up: 0, kb_down: 0, lastDump: 0 }

app.post('/api/bench/reset', (req, res) => {
  metrics = { mode: req.body?.mode || (process.env.MODE||'wasm'), e2e: [], fps: [], kb_up:0, kb_down:0, lastDump: Date.now() }
  res.json({ ok: true })
})
app.post('/api/bench/push', (req, res) => {
  const { e2e, fps, kbps_up, kbps_down } = req.body || {}
  if (typeof e2e === 'number') metrics.e2e.push(e2e)
  if (typeof fps === 'number') metrics.fps.push(fps)
  if (typeof kbps_up === 'number') metrics.kb_up = kbps_up/8
  if (typeof kbps_down === 'number') metrics.kb_down = kbps_down/8
  res.json({ ok: true })
})
app.get('/api/bench/dump', (req, res) => {
  const median = arr => { if (!arr.length) return 0; const s=[...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2 }
  const p95 = arr => { if (!arr.length) return 0; const s=[...arr].sort((a,b)=>a-b); const i=Math.floor(0.95*(s.length-1)); return s[i] }
  const out = {
    mode: metrics.mode,
    median_e2e_ms: Math.round(median(metrics.e2e)),
    p95_e2e_ms: Math.round(p95(metrics.e2e)),
    processed_fps_median: Number(median(metrics.fps).toFixed(1)),
    uplink_kbps: Math.round(metrics.kb_up*8),
    downlink_kbps: Math.round(metrics.kb_down*8),
    ts: Date.now()
  }
  // write to shared/metrics.json
  import('fs').then(fs => {
    fs.writeFileSync('/app/shared/metrics.json', JSON.stringify(out, null, 2))
  })
  res.json({ ok: true, out })
})

// WebSocket signaling: naive room with 2 peers (camera + viewer)
const server = app.listen(3000, () => {
  console.log('Web server listening on http://0.0.0.0:3000')
})
const wss = new WebSocketServer({ server, path: '/signal' })

let peers = []
wss.on('connection', (ws) => {
  peers.push(ws)
  ws.on('close', () => {
    peers = peers.filter(p => p !== ws)
  })
  ws.on('message', (data) => {
    for (const p of peers) if (p !== ws && p.readyState === 1) p.send(data)
  })
})
