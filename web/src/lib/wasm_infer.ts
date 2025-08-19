import * as ort from 'onnxruntime-web';
import type { InferenceSession, Tensor } from 'onnxruntime-web';
import type { Detection } from './overlay';

// Shared constants
const MODEL_URL = '/models/yolov5n.onnx';
const SIZE = { width: 320, height: 240 } as const;

// ---------------------------------------------------------------------------
// Worker implementation
// ---------------------------------------------------------------------------

// Detect if this code is executing inside a Worker. Vite will bundle this file
// both for the main thread and for the worker itself. When running in the
// worker we don't have a `document` object available.
const IS_WORKER = typeof self !== 'undefined' && (self as any).document === undefined;

if (IS_WORKER) {
  const ctx: DedicatedWorkerGlobalScope = self as any;

  let session: InferenceSession | null = null;

  // Load ONNXRuntime and the model. We explicitly request the WASM backend.
  async function initSession() {
    if (!session) {
      // Ensure wasm backend is used.
      // @ts-ignore - executionProviders is only checked at runtime
      ort.env.wasm.numThreads = 1;
      session = await ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ['wasm']
      });
    }
  }

  function preprocess(image: ImageBitmap | OffscreenCanvas): Tensor {
    const off = new OffscreenCanvas(SIZE.width, SIZE.height);
    const ctx2 = off.getContext('2d')!;
    ctx2.drawImage(image as any, 0, 0, SIZE.width, SIZE.height);
    const img = ctx2.getImageData(0, 0, SIZE.width, SIZE.height).data;
    const data = new Float32Array(SIZE.width * SIZE.height * 3);
    const stride = SIZE.width * SIZE.height;
    for (let i = 0; i < stride; i++) {
      data[i] = img[i * 4] / 255;
      data[i + stride] = img[i * 4 + 1] / 255;
      data[i + stride * 2] = img[i * 4 + 2] / 255;
    }
    return new ort.Tensor('float32', data, [1, 3, SIZE.height, SIZE.width]);
  }

  function postprocess(data: Float32Array): Detection[] {
    const dets: Detection[] = [];
    const count = data.length / 85; // YOLO output shape
    for (let i = 0; i < count; i++) {
      const off = i * 85;
      const obj = data[off + 4];
      let best = 0;
      let cls = 0;
      for (let j = 5; j < 85; j++) {
        const val = data[off + j];
        if (val > best) {
          best = val;
          cls = j - 5;
        }
      }
      const score = obj * best;
      if (score < 0.5) continue;
      const cx = data[off];
      const cy = data[off + 1];
      const w = data[off + 2];
      const h = data[off + 3];
      dets.push({
        x: (cx - w / 2) / SIZE.width,
        y: (cy - h / 2) / SIZE.height,
        w: w / SIZE.width,
        h: h / SIZE.height,
        label: String(cls),
        score
      });
    }
    return dets;
  }

  interface FrameMessage {
    frame_id: number;
    capture_ts: number;
    bitmap: ImageBitmap | OffscreenCanvas;
  }

  let busy = false;
  let queued: FrameMessage | null = null;

  function closeBitmap(bm: ImageBitmap | OffscreenCanvas) {
    if ('close' in bm) (bm as ImageBitmap).close();
  }

  async function run(frame: FrameMessage) {
    await initSession();
    const input = preprocess(frame.bitmap);
    const output = await session!.run({ images: input });
    const out = output[Object.keys(output)[0]] as Tensor;
    const detections = postprocess(out.data as Float32Array);
    const inference_ts = performance.now();
    ctx.postMessage({
      frame_id: frame.frame_id,
      capture_ts: frame.capture_ts,
      inference_ts,
      detections
    });
    closeBitmap(frame.bitmap);
  }

  async function process(frame: FrameMessage) {
    busy = true;
    await run(frame);
    busy = false;
    if (queued) {
      const next = queued;
      queued = null;
      process(next);
    }
  }

  ctx.onmessage = async ev => {
    const data = ev.data;
    if (data.type === 'warmup') {
      await initSession();
      // run one dummy inference to warm caches
      const zero = new Float32Array(SIZE.width * SIZE.height * 3);
      const tensor = new ort.Tensor('float32', zero, [1, 3, SIZE.height, SIZE.width]);
      await session!.run({ images: tensor });
      ctx.postMessage({ type: 'warmup-done' });
    } else if (data.type === 'infer') {
      const frame: FrameMessage = {
        frame_id: data.frame_id,
        capture_ts: data.capture_ts,
        bitmap: data.bitmap
      };
      if (busy) {
        if (queued) closeBitmap(queued.bitmap);
        queued = frame;
      } else {
        process(frame);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Main thread wrapper
// ---------------------------------------------------------------------------

export interface InferenceOutput {
  frame_id: number;
  capture_ts: number;
  inference_ts: number;
  detections: Detection[];
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, (msg: InferenceOutput) => void>();
let warmupResolver: (() => void) | null = null;

function getWorker() {
  if (IS_WORKER) throw new Error('getWorker called inside worker');
  if (!worker) {
    // Spawn a worker using this very module as the entry script. Use an
    // indirection for the constructor so that bundlers don't try to process
    // this worker creation when building the worker itself.
    const WorkerCtor = Worker as { new (url: string | URL, opts: WorkerOptions): Worker };
    worker = new WorkerCtor(import.meta.url, { type: 'module' });
    worker.onmessage = ev => {
      const data = ev.data;
      if (data.type === 'warmup-done') {
        warmupResolver?.();
        warmupResolver = null;
      } else {
        const resolver = pending.get(data.frame_id);
        if (resolver) {
          pending.delete(data.frame_id);
          resolver(data as InferenceOutput);
        }
      }
    };
  }
  return worker;
}

function warmupImpl(): Promise<void> {
  const w = getWorker();
  return new Promise(resolve => {
    warmupResolver = resolve;
    w.postMessage({ type: 'warmup' });
  });
}

function inferImpl(bitmap: ImageBitmap | OffscreenCanvas): Promise<InferenceOutput> {
  const w = getWorker();
  const frame_id = nextId++;
  const capture_ts = performance.now();
  return new Promise(resolve => {
    pending.set(frame_id, resolve);
    w.postMessage(
      { type: 'infer', frame_id, capture_ts, bitmap },
      [bitmap as any]
    );
  });
}

export { warmupImpl as warmup, inferImpl as infer };


