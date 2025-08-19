import { InferenceSession, Tensor } from 'onnxruntime-web';
import { Detection } from './overlay';

let session: InferenceSession | null = null;
const size = { width: 320, height: 240 };

async function loadModel() {
  if (!session) {
    session = await InferenceSession.create('/models/yolov5n.onnx');
  }
}

function preprocess(image: ImageBitmap): Tensor {
  const off = new OffscreenCanvas(size.width, size.height);
  const ctx = off.getContext('2d')!;
  ctx.drawImage(image, 0, 0, size.width, size.height);
  const imgData = ctx.getImageData(0, 0, size.width, size.height);
  const data = new Float32Array(size.width * size.height * 3);
  for (let i = 0; i < size.width * size.height; i++) {
    const r = imgData.data[i * 4] / 255;
    const g = imgData.data[i * 4 + 1] / 255;
    const b = imgData.data[i * 4 + 2] / 255;
    data[i] = r;
    data[i + size.width * size.height] = g;
    data[i + size.width * size.height * 2] = b;
  }
  return new Tensor('float32', data, [1, 3, size.height, size.width]);
}

function postprocess(data: Float32Array): Detection[] {
  const dets: Detection[] = [];
  const num = data.length / 85;
  for (let i = 0; i < num; i++) {
    const offset = i * 85;
    const obj = data[offset + 4];
    let best = 0;
    let cls = 0;
    for (let j = 5; j < 85; j++) {
      if (data[offset + j] > best) {
        best = data[offset + j];
        cls = j - 5;
      }
    }
    const score = obj * best;
    if (score < 0.5) continue;
    const cx = data[offset];
    const cy = data[offset + 1];
    const w = data[offset + 2];
    const h = data[offset + 3];
    dets.push({
      x: (cx - w / 2) / size.width,
      y: (cy - h / 2) / size.height,
      w: w / size.width,
      h: h / size.height,
      label: String(cls),
      score
    });
  }
  return dets;
}

async function handleFrame(image: ImageBitmap, ts: number) {
  if (!session) return;
  const input = preprocess(image);
  const output = await session.run({ images: input });
  const out = output[Object.keys(output)[0]] as Tensor;
  const dets = postprocess(out.data as Float32Array);
  (self as any).postMessage({ ts, detections: dets });
}

self.onmessage = async e => {
  const { type, image, ts } = e.data;
  if (type === 'init') {
    await loadModel();
    (self as any).postMessage({ type: 'ready' });
  } else if (type === 'frame') {
    await handleFrame(image, ts);
    image.close();
  }
};

export {};
