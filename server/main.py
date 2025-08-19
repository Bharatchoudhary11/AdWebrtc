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
    return web.Response(text="aiortc inference server", content_type="text/html")


async def health(request):
    return web.json_response({"ok": True})


async def offer(request):
    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    pc = RTCPeerConnection()
    pcs.add(pc)

    detections_channel = pc.createDataChannel("detections")

    @pc.on("track")
    async def on_track(track):
        if track.kind == "video":
            while True:
                frame = await track.recv()
                frame_id = int(frame.pts or 0)
                recv_ts = int(time.time() * 1000)
                detections = detector.run(frame)
                inference_ts = int(time.time() * 1000)
                message = {
                    "frame_id": frame_id,
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
app.on_shutdown.append(on_shutdown)


if __name__ == "__main__":
    web.run_app(app, port=int(os.getenv("PORT", 8080)))
