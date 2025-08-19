import asyncio
import json
import time
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from aiortc import RTCPeerConnection, RTCSessionDescription
from inference import Detector

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

pcs = set()
detector = Detector()

@app.get("/health")
async def health():
    return {"ok": True}

@app.post("/offer")
async def offer(request: Request):
    sdp = (await request.body()).decode()
    offer = RTCSessionDescription(sdp=sdp, type="offer")

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

    return Response(pc.localDescription.sdp, media_type="application/sdp")

@app.on_event("shutdown")
async def on_shutdown():
    await asyncio.gather(*[pc.close() for pc in pcs])
    pcs.clear()
