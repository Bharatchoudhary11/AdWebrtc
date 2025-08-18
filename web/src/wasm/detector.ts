import * as ort from 'onnxruntime-web'

export class Detector {
  mode: string
  session: ort.InferenceSession | null = null
  ws: WebSocket | null = null
  bytesUp = 0
  bytesDown = 0

  constructor(mode: string) { this.mode = mode }

  async init() {
    if (this.mode === 'wasm') {
      ort.env.wasm.numThreads = 1
      ort.env.wasm.simd = true
      this.session = await ort.InferenceSession.create(
        // Tiny yolov5n exported to onnx (remote URL)
        'https://github.com/ultralytics/yolov5/releases/download/v6.0/yolov5n.onnx',
        { executionProviders: ['wasm'] }
      )
    } else {
      // server websocket
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      this.ws = new WebSocket(`${proto}://${location.hostname}:8000/ws`)
      await new Promise<void>((res) => { this.ws!.onopen = () => res() })
    }
  }

  async detectFromVideo(video: HTMLVideoElement) {
    if (!this.session) return []
    const size = 320
    const canvas = document.createElement('canvas')
    canvas.width = size; canvas.height = size
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0, size, size)
    const input = new Float32Array(size*size*3)
    const data = ctx.getImageData(0,0,size,size).data
    for (let i=0,j=0;i<data.length;i+=4) {
      input[j++] = data[i]/255
      input[j++] = data[i+1]/255
      input[j++] = data[i+2]/255
    }
    const tensor = new ort.Tensor('float32', input, [1,3,size,size])
    const out = await this.session.run({ images: tensor } as any)
    const key = Object.keys(out)[0]
    const preds = out[key] as ort.Tensor

    // preds: [1, N, 85]
    const arr = preds.data as Float32Array
    const N = preds.dims[1]
    const detections:any[] = []
    const confThresh = 0.25
    const iouThresh = 0.45

    function iou(a:number[], b:number[]) {
      const xx1 = Math.max(a[0], b[0])
      const yy1 = Math.max(a[1], b[1])
      const xx2 = Math.min(a[2], b[2])
      const yy2 = Math.min(a[3], b[3])
      const w = Math.max(0, xx2-xx1)
      const h = Math.max(0, yy2-yy1)
      const inter = w*h
      const ua = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter + 1e-9
      return inter/ua
    }

    const boxes:number[][] = []
    const scores:number[] = []
    const classes:number[] = []
    for (let i=0;i<N;i++) {
      const base = i*85
      const cx = arr[base+0], cy = arr[base+1], w = arr[base+2], h = arr[base+3]
      const obj = arr[base+4]
      let bestScore = 0; let bestCls = 0
      for (let c=0;c<80;c++) {
        const s = arr[base+5+c]
        if (s > bestScore) { bestScore = s; bestCls = c }
      }
      const score = obj * bestScore
      if (score < confThresh) continue
      const xmin = Math.max(0, cx - w/2), ymin = Math.max(0, cy - h/2)
      const xmax = Math.min(1, cx + w/2), ymax = Math.min(1, cy + h/2)
      boxes.push([xmin,ymin,xmax,ymax]); scores.push(score); classes.push(bestCls)
    }

    // Greedy NMS
    const order = scores.map((s,i)=>[s,i] as const).sort((a,b)=>b[0]-a[0]).map(x=>x[1])
    const keep:number[] = []
    while (order.length) {
      const i = order.shift()!
      keep.push(i)
      for (let k=order.length-1;k>=0;k--) {
        const j = order[k]
        if (iou(boxes[i], boxes[j]) > iouThresh) order.splice(k,1)
      }
    }

    for (const i of keep) {
      detections.push({ label: String(classes[i]), score: scores[i], xmin: boxes[i][0], ymin: boxes[i][1], xmax: boxes[i][2], ymax: boxes[i][3] })
    }
    return detections
  }

  async detectServer(video: HTMLVideoElement, frame_id: number, capture_ts: number) {
    if (!this.ws) return []
    const size = 320
    const canvas = document.createElement('canvas')
    canvas.width = size; canvas.height = size
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0, size, size)
    const blob:Blob = await new Promise(res => canvas.toBlob(b => res(b!), 'image/jpeg', 0.7))
    const buf = await blob.arrayBuffer()
    const b64 = 'data:image/jpeg;base64,' + btoa(String.fromCharCode(...new Uint8Array(buf)))
    const msg = JSON.stringify({ frame_id, capture_ts, image_b64: b64 })

    // send and wait response
    const p = new Promise<any[]>((resolve) => {
      const handler = (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data)
          if (String(data.frame_id) === String(frame_id)) {
            this.ws!.removeEventListener('message', handler as any)
            this.bytesDown += (ev.data as string).length
            resolve(data.detections || [])
          }
        } catch {}
      }
      this.ws!.addEventListener('message', handler as any)
    })
    this.ws.send(msg)
    this.bytesUp += msg.length
    return await p
  }
}
