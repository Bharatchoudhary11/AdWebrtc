import express from 'express'
import { WebSocketServer } from 'ws'
import path from 'path'
import http from 'http'
import { fileURLToPath } from 'url'
import getPort, { portNumbers } from 'get-port'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
app.use(express.json({ limit: '1mb' }))

// Serve built client
app.use(express.static(path.join(__dirname, 'dist')))

// Serve static files from public/
app.use(express.static('public'))

// expose MODE to browser
app.get('/env.js', (req, res) => {
  const mode = process.env.MODE || 'wasm'
  res.type('application/javascript').send(`window.MODE="${mode}";`)
})

// Simple metrics aggregator
let metrics = { mode: process.env.MODE || 'wasm', e2e: [], fps: [], kb_up: 0, kb_down: 0, lastDump: 0 }

app.post('/api/bench/reset', (req, res) => {
  metrics = { mode: req.body?.mode || (process.env.MODE || 'wasm'), e2e: [], fps: [], kb_up: 0, kb_down: 0, lastDump: Date.now() }
  res.json({ ok: true })
})
app.post('/api/bench/push', (req, res) => {
  const { e2e, fps, kbps_up, kbps_down } = req.body || {}
  if (typeof e2e === 'number') metrics.e2e.push(e2e)
  if (typeof fps === 'number') metrics.fps.push(fps)
  if (typeof kbps_up === 'number') metrics.kb_up = kbps_up / 8
  if (typeof kbps_down === 'number') metrics.kb_down = kbps_down / 8
  res.json({ ok: true })
})
app.get('/api/bench/dump', async (req, res) => {
  const median = arr => { if (!arr.length) return 0; const s = [...arr].sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2 }
  const p95 = arr => { if (!arr.length) return 0; const s = [...arr].sort((a,b)=>a-b); const i = Math.floor(0.95*(s.length-1)); return s[i] }
  const out = {
    mode: metrics.mode,
    median_e2e_ms: Math.round(median(metrics.e2e)),
    p95_e2e_ms: Math.round(p95(metrics.e2e)),
    processed_fps_median: Number(median(metrics.fps).toFixed(1)),
    uplink_kbps: Math.round(metrics.kb_up * 8),
    downlink_kbps: Math.round(metrics.kb_down * 8),
    ts: Date.now()
  }
  const fs = await import('fs')
  try {
    // fall back to local path if /app/bench/ isn’t mounted
    const target = fs.existsSync('/app/bench') ? '/app/bench/metrics.json' : path.join(__dirname, 'metrics.json')
    fs.writeFileSync(target, JSON.stringify(out, null, 2))
  } catch (e) {
    console.error('Failed to write metrics:', e)
  }
  res.json({ ok: true, out })
})

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
