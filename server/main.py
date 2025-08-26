import asyncio
import json
import os
import time
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription

from inference import Detector
from tracker import SimpleTracker

pcs = set()
detector = Detector()


async def index(request):
    """Return server status or metrics for a specific device."""
    device_id = request.query.get("device_id")

    if not device_id:
        # Try to infer a device ID from existing metric files if one wasn't
        # explicitly requested.
        for fname in os.listdir("."):
            if fname.endswith("_metrics.json"):
                device_id = fname.removesuffix("_metrics.json")
                break

    if device_id:
        path = f"{device_id}_metrics.json"
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                data = [json.loads(line) for line in f if line.strip()]
            return web.json_response({"device_id": device_id, "metrics": data})
        return web.json_response({"device_id": device_id, "metrics": []})

    # Return a sample detection response format when no metrics are available
    return web.json_response(
        {
            "device_id": device_id or "sample_device",
            "frame_id": "sample",
            "capture_ts": int(time.time() * 1000),
            "recv_ts": int(time.time() * 1000),
            "inference_ts": int(time.time() * 1000),
            "detections": [
                {
                    "label": "person",
                    "score": 0.93,
                    "xmin": 0.12,
                    "ymin": 0.08,
                    "xmax": 0.34,
                    "ymax": 0.67,
                }
            ],
        }
    )


async def health(request):
    return web.json_response({"ok": True})

async def favicon(request):
    icon_path = os.path.join(os.path.dirname(__file__), "favicon.ico")
    return web.FileResponse(icon_path)


async def offer(request):
    device_id = request.query.get("device_id")
    sdp = await request.text()
    offer = RTCSessionDescription(sdp=sdp, type="offer")

    pc = RTCPeerConnection()
    pcs.add(pc)
    print(f"Browser connected: {device_id or 'unknown'}, total browsers: {len(pcs)}")

    detections_channel = pc.createDataChannel("detections")
    metrics_path = f"{device_id}_metrics.json" if device_id else None
    metrics_file = open(metrics_path, "a", encoding="utf-8") if metrics_path else None

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
                inference_ts = int(time.time() * 1000)
                message = {
                    "device_id": device_id or "unknown",
                    "frame_id": frame_id,
                    "capture_ts": capture_ts,
                    "recv_ts": recv_ts,
                    "inference_ts": inference_ts,
                    "detections": detections,
                }
                print(json.dumps(message))
                if metrics_file:
                    metrics_file.write(json.dumps(message) + "\n")
                    metrics_file.flush()
                if detections_channel.readyState == "open":
                    detections_channel.send(json.dumps(message))

    @pc.on("connectionstatechange")
    async def on_state_change():
        if pc.connectionState in ("failed", "closed"):
            await pc.close()
            pcs.discard(pc)
            print(f"Browser disconnected: {device_id or 'unknown'}, total browsers: {len(pcs)}")
            if metrics_file:
                metrics_file.close()

    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return web.Response(text=pc.localDescription.sdp, content_type="application/sdp")


async def on_shutdown(app):
    await asyncio.gather(*[pc.close() for pc in pcs])
    pcs.clear()


app = web.Application()
app.router.add_get("/", index)
app.router.add_get("/health", health)
app.router.add_post("/offer", offer)
app.router.add_get("/favicon.ico", favicon)


import aiohttp.web

app.on_shutdown.append(on_shutdown)


if __name__ == "__main__":
    web.run_app(app, port=int(os.getenv("PORT", 8080)))
