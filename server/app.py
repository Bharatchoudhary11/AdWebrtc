from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import numpy as np
import onnxruntime as ort
from PIL import Image
import io, base64, time, json, os

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load labels
with open("labels_coco80.txt", "r", encoding="utf-8") as f:
    LABELS = [x.strip() for x in f.readlines()]

MODEL_URL = os.environ.get("MODEL_URL", "https://github.com/ultralytics/yolov5/releases/download/v6.0/yolov5n.onnx")
MODEL_PATH = os.environ.get("MODEL_PATH", "/app/models/yolov5n.onnx")

_session = None
_input_name = None
_img_size = 320

def _ensure_model():
    global _session, _input_name
    if _session is not None:
        return
    # Download if missing
    if not os.path.exists(MODEL_PATH):
        import urllib.request
        print(f"Downloading model to {MODEL_PATH}...")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    providers = ["CPUExecutionProvider"]
    _session = ort.InferenceSession(MODEL_PATH, providers=providers)
    _input_name = _session.get_inputs()[0].name
    print("Model loaded.", flush=True)

@app.get("/model")
def get_model():
    _ensure_model()
    return FileResponse(MODEL_PATH, media_type="application/octet-stream")

def preprocess(img: Image.Image, size=320):
    img = img.convert("RGB").resize((size, size))
    arr = np.array(img).astype(np.float32) / 255.0
    arr = arr.transpose(2, 0, 1)[None, ...]  # NCHW
    return arr

def postprocess_yolov5(outputs, conf_thres=0.25, iou_thres=0.45):
    # outputs[0]: (1, N, 85) -> [x,y,w,h, conf, class scores...]
    pred = outputs[0]
    if isinstance(pred, list):
        pred = pred[0]
    pred = np.squeeze(pred, axis=0)
    if pred.ndim == 2 and pred.shape[1] >= 85:
        boxes_xywh = pred[:, :4]
        objectness = pred[:, 4]
        class_scores = pred[:, 5:]
        scores = objectness * class_scores.max(axis=1)
        classes = class_scores.argmax(axis=1)

        keep = scores >= conf_thres
        boxes_xywh = boxes_xywh[keep]
        scores = scores[keep]
        classes = classes[keep]

        # Convert xywh to xyxy normalized
        # YOLOv5 outputs are normalized [0,1] if using export defaults; if not, assume normalized here.
        # For safety, clip to [0,1].
        cx, cy, w, h = boxes_xywh[:,0], boxes_xywh[:,1], boxes_xywh[:,2], boxes_xywh[:,3]
        xmin = np.clip(cx - w/2, 0, 1)
        ymin = np.clip(cy - h/2, 0, 1)
        xmax = np.clip(cx + w/2, 0, 1)
        ymax = np.clip(cy + h/2, 0, 1)

        # Simple greedy NMS
        order = scores.argsort()[::-1]
        keep_indices = []
        while order.size > 0:
            i = order[0]
            keep_indices.append(i)
            if order.size == 1: break
            ious = iou(
                np.stack([xmin[i], ymin[i], xmax[i], ymax[i]]),
                np.stack([xmin[order[1:]], ymin[order[1:]], xmax[order[1:]], ymax[order[1:]]], axis=1)
            )
            inds = np.where(ious <= iou_thres)[0]
            order = order[inds + 1]

        detections = []
        for i in keep_indices:
            detections.append({
                "label": LABELS[int(classes[i])] if int(classes[i]) < len(LABELS) else str(int(classes[i])),
                "score": float(scores[i]),
                "xmin": float(xmin[i]),
                "ymin": float(ymin[i]),
                "xmax": float(xmax[i]),
                "ymax": float(ymax[i]),
            })
        return detections
    else:
        return []

def iou(box1, boxes):  # boxes: (N,4)
    x1, y1, x2, y2 = box1
    xx1 = np.maximum(x1, boxes[:,0])
    yy1 = np.maximum(y1, boxes[:,1])
    xx2 = np.minimum(x2, boxes[:,2])
    yy2 = np.minimum(y2, boxes[:,3])
    inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
    area1 = (x2 - x1) * (y2 - y1)
    area2 = (boxes[:,2] - boxes[:,0]) * (boxes[:,3] - boxes[:,1])
    union = area1 + area2 - inter + 1e-9
    return inter / union

@app.get("/health")
def health():
    return {"ok": True}

@app.websocket("/ws")
async def ws_detect(ws: WebSocket):
    await ws.accept()
    _ensure_model()
    try:
        while True:
            msg = await ws.receive_text()
            data = json.loads(msg)
            frame_id = data.get("frame_id")
            capture_ts = data.get("capture_ts")
            img_b64 = data.get("image_b64")
            recv_ts = int(time.time() * 1000)

            if not img_b64:
                await ws.send_text(json.dumps({
                    "frame_id": frame_id, "capture_ts": capture_ts, "recv_ts": recv_ts,
                    "inference_ts": recv_ts, "detections": []
                }))
                continue

            raw = base64.b64decode(img_b64.split(",")[-1])
            img = Image.open(io.BytesIO(raw))
            inp = preprocess(img, size=_img_size)

            t0 = time.time()
            outputs = _session.run(None, {_input_name: inp})
            t1 = time.time()

            detections = postprocess_yolov5(outputs)
            inference_ts = int(t1 * 1000)

            out = {
                "frame_id": frame_id,
                "capture_ts": capture_ts,
                "recv_ts": recv_ts,
                "inference_ts": inference_ts,
                "detections": detections
            }
            await ws.send_text(json.dumps(out))
    except WebSocketDisconnect:
        return
    except Exception as e:
        await ws.send_text(json.dumps({"error": str(e)}))
