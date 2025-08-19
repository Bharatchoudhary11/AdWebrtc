import { Detection } from './overlay';

export interface DetectionMessage {
  frame_id?: number;
  capture_ts?: number;
  recv_ts?: number;
  inference_ts?: number;
  detections: Detection[];
}

export async function initWebRTC(
  stream: MediaStream,
  onMessage: (msg: DetectionMessage) => void
) {
  const pc = new RTCPeerConnection();
  stream.getTracks().forEach(t => pc.addTrack(t, stream));

  pc.ondatachannel = ev => {
    if (ev.channel.label === 'detections') {
      ev.channel.onmessage = e => {
        onMessage(JSON.parse(e.data));
      };
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const serverUrl = `${window.location.protocol}//${window.location.hostname}:8000`;
  const res = await fetch(`${serverUrl}/offer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: offer.sdp || ''
  });
  const answer = await res.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });

  return pc;
}
