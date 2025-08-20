import asyncio
import json
import os
import time
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription

from inference import Detector

pcs = set()
detector = Detector()


async def index(request):
    return web.json_response(
        {
            "message": "aiortc inference server",
            "hint": "add ?device_id=<id> query parameter to fetch metrics",
        }
    )


async def health(request):
    return web.json_response({"ok": True})

async def favicon(request):
    icon_path = os.path.join(os.path.dirname(__file__), "favicon.ico")
    return web.FileResponse(icon_path)


async def offer(request):
    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    pc = RTCPeerConnection()
    pcs.add(pc)

    detections_channel = pc.createDataChannel("detections")

    @pc.on("track")
    async def on_track(track):
        if track.kind == "video":
            queue: asyncio.Queue = asyncio.Queue(maxsize=1)

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
                recv_ts = int(time.time() * 1000)
                detections = detector.run(frame)
                # Print detections so they appear in backend logs
                print(f"Frame {frame_id} detections: {detections}")
                inference_ts = int(time.time() * 1000)
                capture_ts = (
                    int(frame.time * 1000) if getattr(frame, "time", None) is not None else recv_ts
                )
                message = {
                    "frame_id": frame_id,
                    "capture_ts": capture_ts,
                    "recv_ts": recv_ts,
                    "inference_ts": inference_ts,
                    "detections": detections,
                }
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

    return web.json_response(
        {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}
    )


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
