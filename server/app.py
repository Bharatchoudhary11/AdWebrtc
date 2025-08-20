import asyncio
import json
import os
import time
from fastapi import FastAPI, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from aiortc import RTCPeerConnection, RTCSessionDescription
from inference import Detector
from tracker import SimpleTracker

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

pcs = set()
detector = Detector()


@app.get("/")
async def index(device_id: str | None = None):
    """Return server status or the latest metrics for a specific device.

    When ``device_id`` is provided, this endpoint returns the most recent
    per-frame metrics entry written for that device.  The metrics file is
    appended to by the ``/offer`` handler and contains one JSON object per
    line.  If no metrics are available yet for the device, an empty object is
    returned.  When ``device_id`` is omitted, a simple status message is
    returned instead.
    """

    if device_id:
        path = f"{device_id}_metrics.json"
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                # load all lines and return the most recent entry
                data = [json.loads(line) for line in f if line.strip()]
            if data:
                return data[-1]
        return {}

    return {
        "message": "aiortc inference server",
        "hint": "add ?device_id=<id> query parameter to fetch metrics",
    }


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/offer")
async def offer(request: Request, device_id: str = Query(...)):
    sdp = (await request.body()).decode()
    offer = RTCSessionDescription(sdp=sdp, type="offer")

    pc = RTCPeerConnection()
    pcs.add(pc)

    detections_channel = pc.createDataChannel("detections")
    metrics_path = f"{device_id}_metrics.json"
    metrics_file = open(metrics_path, "a", encoding="utf-8")

    @pc.on("track")
    async def on_track(track):
        if track.kind == "video":
            queue: asyncio.Queue = asyncio.Queue(maxsize=1)
            tracker = SimpleTracker()

            async def reader():
                while True:
                    frame = await track.recv()
                    if queue.full():
                        try:
                            queue.get_nowait()
                        except asyncio.QueueEmpty:
                            pass
                    await queue.put(frame)

            asyncio.create_task(reader())

            while True:
                frame = await queue.get()
                frame_id = int(frame.pts or 0)
                capture_ts = int((getattr(frame, "time", 0) or 0) * 1000)
                recv_ts = int(time.time() * 1000)
                detections = detector.run(frame)
                detections = tracker.update(detections)
                detections = [
                    {
                        "label": det["label"],
                        "score": det["score"],
                        "xmin": det["xmin"],
                        "ymin": det["ymin"],
                        "xmax": det["xmax"],
                        "ymax": det["ymax"],
                    }
                    for det in detections
                ]
                inference_ts = int(time.time() * 1000)
                message = {
                    "frame_id": frame_id,
                    "capture_ts": capture_ts,
                    "recv_ts": recv_ts,
                    "inference_ts": inference_ts,
                    "detections": detections,
                }
                print(json.dumps(message))
                metrics_file.write(json.dumps(message) + "\n")
                metrics_file.flush()
                if detections_channel.readyState == "open":
                    detections_channel.send(json.dumps(message))

    @pc.on("connectionstatechange")
    async def on_state_change():
        if pc.connectionState in ("failed", "closed"):
            await pc.close()
            pcs.discard(pc)
            metrics_file.close()

    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return Response(pc.localDescription.sdp, media_type="application/sdp")


@app.on_event("shutdown")
async def on_shutdown():
    await asyncio.gather(*[pc.close() for pc in pcs])
    pcs.clear()
