import * as ort from 'onnxruntime-web';
import type { InferenceSession, Tensor } from 'onnxruntime-web';
import type { Detection } from './overlay';

// ---------------------------------------------------------------------------
// Shared constants and helpers
// ---------------------------------------------------------------------------

/**
 * Location of the tiny quantised model used for inference.
 *
 * Use a URL relative to this script so the model can be fetched correctly
 * whether the application is hosted at the domain root or under a sub-path.
 */
const MODEL_URL = new URL(/* @vite-ignore */ '../models/yolov5n.onnx', import.meta.url).toString();

/** Dimensions expected by the model. */
const SIZE = { width: 320, height: 240 } as const;

// ---------------------------------------------------------------------------
// Worker implementation
// ---------------------------------------------------------------------------

// Detect if this code is executing inside a Worker. Vite bundles this file twice:
// once for the main thread and once for the worker. In the worker we don't have
// a `document` object available.
const IS_WORKER = typeof self !== 'undefined' &&
  (self as any).document === undefined;

if (IS_WORKER) {
  const ctx: DedicatedWorkerGlobalScope = self as any;

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  let session: InferenceSession | null = null;

  /** Lazily create the ONNXRuntime session using the WASM backend. */
  async function getSession(): Promise<InferenceSession> {
    if (!session) {
      // Force WASM backend.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - the env object is only checked at runtime.
      ort.env.wasm.numThreads = 1;
      try {
        const response = await fetch(MODEL_URL);
        if (!response.ok) {
          throw new Error(`Model fetch failed with ${response.status} ${response.statusText}`);
        }
        const buffer = await response.arrayBuffer();
        if (!buffer.byteLength) {
          throw new Error(`Model at ${MODEL_URL} is empty`);
        }
        session = await ort.InferenceSession.create(buffer, {
          executionProviders: ['wasm']
        });
      } catch (err) {
        console.error('Failed to initialize ONNX model', err);
        throw err;
      }
    }
    return session;
  }

  // -------------------------------------------------------------------------
  // Pre/post processing helpers
  // -------------------------------------------------------------------------

  /** Convert an ImageBitmap/OffscreenCanvas to the model input tensor. */
  function preprocess(src: ImageBitmap | OffscreenCanvas): Tensor {
    const canvas = new OffscreenCanvas(SIZE.width, SIZE.height);
    const c = canvas.getContext('2d')!;
    c.drawImage(src as any, 0, 0, SIZE.width, SIZE.height);
    const rgba = c.getImageData(0, 0, SIZE.width, SIZE.height).data;

    const pixelCount = SIZE.width * SIZE.height;
    const data = new Float32Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
      data[i] = rgba[i * 4] / 255; // R
      data[i + pixelCount] = rgba[i * 4 + 1] / 255; // G
      data[i + pixelCount * 2] = rgba[i * 4 + 2] / 255; // B
    }
    return new ort.Tensor('float32', data, [1, 3, SIZE.height, SIZE.width]);
  }

  /** Convert YOLO model output to normalized Detection objects. */
  function postprocess(raw: Float32Array): Detection[] {
    const stride = 85; // YOLOv5 output layout
    const results: Detection[] = [];
    for (let i = 0; i < raw.length; i += stride) {
      const obj = raw[i + 4];
      let bestCls = 0;
      let bestScore = 0;
      for (let j = 5; j < stride; j++) {
        const v = raw[i + j];
        if (v > bestScore) {
          bestScore = v;
          bestCls = j - 5;
        }
      }
      const score = obj * bestScore;
      if (score < 0.5) continue;
      const cx = raw[i];
      const cy = raw[i + 1];
      const w = raw[i + 2];
      const h = raw[i + 3];
      results.push({
        x: (cx - w / 2) / SIZE.width,
        y: (cy - h / 2) / SIZE.height,
        w: w / SIZE.width,
        h: h / SIZE.height,
        label: String(bestCls),
        score
      });
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Worker protocol
  // -------------------------------------------------------------------------

  interface InferMessage {
    type: 'infer';
    frame_id: number;
    capture_ts: number;
    bitmap: ImageBitmap | OffscreenCanvas;
  }
  interface WarmupMessage { type: 'warmup'; }
  type WorkerRequest = InferMessage | WarmupMessage;

  let busy = false;
  let queued: InferMessage | null = null; // single-slot queue

  function closeBitmap(b: ImageBitmap | OffscreenCanvas) {
    if ('close' in b) (b as ImageBitmap).close();
  }

  async function handleInference(msg: InferMessage) {
    const sess = await getSession();
    const input = preprocess(msg.bitmap);
    const outputs = await sess.run({ [sess.inputNames[0]]: input });
    const tensor = outputs[sess.outputNames[0]] as Tensor;
    const detections = postprocess(tensor.data as Float32Array);
    const inference_ts = performance.now();
    ctx.postMessage({
      frame_id: msg.frame_id,
      capture_ts: msg.capture_ts,
      inference_ts,
      detections
    });
    closeBitmap(msg.bitmap);
  }

  async function process(msg: InferMessage) {
    busy = true;
    await handleInference(msg);
    busy = false;
    if (queued) {
      const next = queued;
      queued = null;
      process(next);
    }
  }

  ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
    const data = ev.data;
    if (data.type === 'warmup') {
      const sess = await getSession();
      // Run a dummy inference to warm up caches
      const zero = new Float32Array(SIZE.width * SIZE.height * 3);
      const tensor = new ort.Tensor('float32', zero, [1, 3, SIZE.height, SIZE.width]);
      await sess.run({ [sess.inputNames[0]]: tensor });
      ctx.postMessage({ type: 'warmup-done' });
    } else {
      const msg = data;
      if (busy) {
        if (queued) closeBitmap(queued.bitmap);
        queued = msg; // replace queued frame
      } else {
        process(msg);
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
let nextFrameId = 0;
const pending = new Map<number, (msg: InferenceOutput) => void>();
let warmupResolver: (() => void) | null = null;

function getWorker(): Worker {
  if (IS_WORKER) throw new Error('getWorker called inside worker');
  if (!worker) {
    // Indirection so bundlers don't evaluate worker creation for worker build.
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
  const frame_id = nextFrameId++;
  const capture_ts = performance.now();
  return new Promise(resolve => {
    pending.set(frame_id, resolve);
    w.postMessage({ type: 'infer', frame_id, capture_ts, bitmap }, [bitmap as any]);
  });
}

export { warmupImpl as warmup, inferImpl as infer };


