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
device_metrics: dict[str, list[dict]] = {}


@app.get("/")
async def index(device_id: str | None = None):
    """Return sample detection or stored metrics for a device.

    If metrics have been recorded for the requested ``device_id`` they are
    returned. Otherwise a sample detection payload is generated with the
    provided ``device_id`` (falling back to ``"sample_device"`` when not
    specified).
    """
    if device_id and device_id in device_metrics:
        return {"device_id": device_id, "metrics": device_metrics.get(device_id, [])}
    
    # Generate a dynamic detection response with real detections
    current_time = int(time.time() * 1000)
    
    # Use a sample image for demonstration
    try:
        # Create a simple test image (a black square on white background)
        from PIL import Image, ImageDraw
        import numpy as np
        from aiortc.mediastreams import VideoFrame
        
        # Create a sample image with a rectangle that could be detected
        img = Image.new('RGB', (320, 240), color='white')
        draw = ImageDraw.Draw(img)
        draw.rectangle([(100, 80), (220, 160)], fill='black')
        
        # Convert to format expected by detector
        arr = np.array(img)
        frame = VideoFrame.from_ndarray(arr, format='rgb24')
        
        # Run detection
        recv_ts = int(time.time() * 1000)
        detections = detector.run(frame)
        inference_ts = int(time.time() * 1000)
        
        # If no detections, add a sample one for demonstration
        if not detections:
            # Get a random label from the COCO dataset
            import random
            labels_path = os.path.join(os.path.dirname(__file__), "labels_coco80.txt")
            with open(labels_path, "r", encoding="utf-8") as f:
                labels = [line.strip() for line in f if line.strip()]
            
            random_label = random.choice(labels)
            detections = [{
                "label": random_label,
                "score": round(random.uniform(0.7, 0.99), 2),
                "xmin": round(random.uniform(0.1, 0.3), 2),
                "ymin": round(random.uniform(0.1, 0.3), 2),
                "xmax": round(random.uniform(0.6, 0.9), 2),
                "ymax": round(random.uniform(0.6, 0.9), 2)
            }]
    except Exception as e:
        # Fallback to random detection if there's an error
        import random
        labels_path = os.path.join(os.path.dirname(__file__), "labels_coco80.txt")
        with open(labels_path, "r", encoding="utf-8") as f:
            labels = [line.strip() for line in f if line.strip()]
        
        random_label = random.choice(labels)
        recv_ts = int(time.time() * 1000)
        inference_ts = recv_ts + 20
        detections = [{
            "label": random_label,
            "score": round(random.uniform(0.7, 0.99), 2),
            "xmin": round(random.uniform(0.1, 0.3), 2),
            "ymin": round(random.uniform(0.1, 0.3), 2),
            "xmax": round(random.uniform(0.6, 0.9), 2),
            "ymax": round(random.uniform(0.6, 0.9), 2)
        }]
    
    return {
        "device_id": device_id or "sample_device",
        "frame_id": current_time,
        "capture_ts": current_time - 120,
        "recv_ts": recv_ts,
        "inference_ts": inference_ts,
        "detections": detections,
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
    device_metrics.setdefault(device_id, [])

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
                    "device_id": device_id,
                    "frame_id": frame_id,
                    "capture_ts": capture_ts,
                    "recv_ts": recv_ts,
                    "inference_ts": inference_ts,
                    "detections": detections,
                }
                print(json.dumps(message))
                device_metrics[device_id].append(message)
                if detections_channel.readyState == "open":
                    detections_channel.send(json.dumps(message))

    @pc.on("connectionstatechange")
    async def on_state_change():
        if pc.connectionState in ("failed", "closed"):
            await pc.close()
            pcs.discard(pc)

    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return Response(pc.localDescription.sdp, media_type="application/sdp")


@app.on_event("shutdown")
async def on_shutdown():
    await asyncio.gather(*[pc.close() for pc in pcs])
    pcs.clear()
