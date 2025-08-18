import QRCode from 'qrcode'
import { startSignaling } from './ws-signal'
import { Detector } from './wasm/detector'

const MODE = (typeof window !== 'undefined' ? (window as any).MODE : undefined) || (import.meta.env.MODE || 'wasm')

export function initApp() {
  const app = document.getElementById('app')!
  app.innerHTML = `
    <h1>Real-time WebRTC VLM Multi-Object Detection</h1>
    <div class="row">
      <div class="card">
        <h3>Join</h3>
        <div id="qr"></div>
        <p>Open this page on your laptop. Scan the QR with your phone to join as Camera.</p>
        <div><span class="pill">Mode: ${MODE}</span></div>
        <button id="joinCamera">Open phone view here (debug)</button>
      </div>
      <div class="card">
        <h3>Viewer</h3>
        <video id="remoteVideo" autoplay playsinline muted></video>
        <div class="stack">
          <canvas id="overlay" class="overlay"></canvas>
        </div>
        <pre id="metrics"></pre>
      </div>
    </div>
  `

  // QR
  const url = new URL(location.href)
  url.searchParams.set('role', 'camera')
  QRCode.toCanvas(url.toString(), { width: 220 }, (err, canvas) => {
    if (!err) document.getElementById('qr')!.appendChild(canvas)
  })
  document.getElementById('joinCamera')!.onclick = () => {
    const u = new URL(location.href); u.searchParams.set('role','camera'); location.href = u.toString()
  }

  const role = new URLSearchParams(location.search).get('role') || 'viewer'
  if (role === 'camera') return initCamera(app)
  return initViewer(app)
}

async function initCamera(app: HTMLElement) {
  app.innerHTML = `
    <h2>Phone: Camera Publisher</h2>
    <video id="localVideo" autoplay playsinline muted></video>
    <p>Publishing camera via WebRTC…</p>
    <pre id="log"></pre>
  `
  const logEl = document.getElementById('log')!

  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
  const localVideo = document.getElementById('localVideo') as HTMLVideoElement
  localVideo.srcObject = stream

  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
  for (const track of stream.getTracks()) pc.addTrack(track, stream)

  const dc = pc.createDataChannel('meta')
  const signal = startSignaling(pc)

  pc.onicecandidate = ev => { if (ev.candidate) signal.send({ type: 'ice', candidate: ev.candidate }) }

  pc.createOffer().then(offer => {
    pc.setLocalDescription(offer)
    signal.send({ type: 'offer', sdp: offer.sdp })
  })

  signal.on('answer', async (msg) => {
    await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
  })
  signal.on('ice', async (msg) => {
    try { await pc.addIceCandidate(msg.candidate) } catch {}
  })

  // Send periodic capture_ts via data channel (best-effort sync for metrics)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const vw = 320, vh = 240
  canvas.width = vw; canvas.height = vh

  function tick() {
    if (localVideo.readyState >= 2) {
      ctx.drawImage(localVideo, 0, 0, vw, vh)
      const capture_ts = Date.now()
      const frame_id = Math.floor(Math.random() * 1e9)
      try {
        dc.send(JSON.stringify({ type: 'capture_meta', frame_id, capture_ts }))
      } catch {}
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  dc.onopen = () => logEl.textContent += "\\nDataChannel open"
  dc.onmessage = (ev) => {
    // Could receive 'frame_request' in more advanced alignment
    logEl.textContent = ev.data
  }
}

async function initViewer(app: HTMLElement) {
  const remoteVideo = document.getElementById('remoteVideo') as HTMLVideoElement
  const overlay = document.getElementById('overlay') as HTMLCanvasElement
  const mpre = document.getElementById('metrics') as HTMLPreElement

  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
  const signal = startSignaling(pc)
  pc.onicecandidate = ev => { if (ev.candidate) signal.send({ type: 'ice', candidate: ev.candidate }) }
  pc.ontrack = ev => {
    remoteVideo.srcObject = ev.streams[0]
    remoteVideo.onloadedmetadata = () => {
      overlay.width = remoteVideo.videoWidth
      overlay.height = remoteVideo.videoHeight
    }
  }
  const framesMeta: Map<number, number> = new Map() // frame_id -> capture_ts

  pc.ondatachannel = (ev) => {
    const dc = ev.channel
    dc.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data)
        if (data.type === 'capture_meta') {
          framesMeta.set(data.frame_id, data.capture_ts)
        }
      } catch {}
    }
  }

  // Offer/Answer
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  signal.send({ type: 'offer', sdp: offer.sdp })
  signal.on('answer', async (msg) => {
    await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
  })
  signal.on('ice', async (msg) => {
    try { await pc.addIceCandidate(msg.candidate) } catch {}
  })

  // Inference loop
  const detector = new Detector(MODE)
  await detector.init()
  const ctx = overlay.getContext('2d')!

  const metrics = {
    e2e_samples: [] as number[],
    fps_samples: [] as number[],
    lastFrameTime: performance.now(),
    processedFrames: 0,
    start: Date.now(),
    mode: MODE,
    lastPush: 0
  }

  function drawBoxes(dets: any[]) {
    ctx.clearRect(0, 0, overlay.width, overlay.height)
    ctx.lineWidth = 2
    ctx.font = '14px system-ui'
    dets.forEach(d => {
      const x = d.xmin * overlay.width
      const y = d.ymin * overlay.height
      const w = (d.xmax - d.xmin) * overlay.width
      const h = (d.ymax - d.ymin) * overlay.height
      ctx.strokeRect(x, y, w, h)
      ctx.fillText(`${d.label} ${(d.score*100).toFixed(1)}%`, x+4, y+16)
    })
  }

  async function loop() {
    if (remoteVideo.readyState >= 2) {
      const frame_id = Math.floor(Math.random() * 1e9)
      const capture_ts = framesMeta.get(frame_id) || Date.now() // fallback

      const t0 = performance.now()
      let dets:any = []
      if (MODE === 'wasm') {
        dets = await detector.detectFromVideo(remoteVideo)
      } else {
        dets = await detector.detectServer(remoteVideo, frame_id, capture_ts)
      }
      drawBoxes(dets)

      const t1 = performance.now()
      metrics.processedFrames++
      const dt = t1 - metrics.lastFrameTime
      metrics.lastFrameTime = t1
      const fps = 1000 / dt
      metrics.fps_samples.push(fps)

      // E2E latency (approx; uses capture_ts if available)
      const e2e = Date.now() - capture_ts
      metrics.e2e_samples.push(e2e)

      // Update UI
      const median = (arr:number[]) => {
        if (!arr.length) return 0
        const s = [...arr].sort((a,b)=>a-b); const mid = Math.floor(s.length/2)
        return s.length%2 ? s[mid] : (s[mid-1]+s[mid])/2
      }
      const p95 = (arr:number[]) => {
        if (!arr.length) return 0
        const s = [...arr].sort((a,b)=>a-b)
        const idx = Math.floor(0.95*(s.length-1))
        return s[idx]
      }
      const elapsed = (Date.now() - metrics.start) / 1000
      const kbps_up = (detector.bytesUp / 1024) / elapsed * 8
      const kbps_down = (detector.bytesDown / 1024) / elapsed * 8
      mpre.textContent = JSON.stringify({
        processed_fps: median(metrics.fps_samples).toFixed(1),
        e2e_ms_median: Math.round(median(metrics.e2e_samples)),
        e2e_ms_p95: Math.round(p95(metrics.e2e_samples)),
        kbps_up: Math.round(kbps_up),
        kbps_down: Math.round(kbps_down),
        samples: metrics.e2e_samples.length
      }, null, 2)

      // push to server ~1Hz for bench metrics
      if (Date.now() - metrics.lastPush > 1000) {
        metrics.lastPush = Date.now()
        fetch('/api/bench/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ e2e, fps, kbps_up, kbps_down })
        }).catch(()=>{})
      }
    }
    setTimeout(loop, 70) // ~14 FPS target
  }
  loop()
}
