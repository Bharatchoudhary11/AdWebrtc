import { Detection } from './overlay';

export interface DetectionMessage {
  frame_id?: number;
  capture_ts?: number;
  recv_ts?: number;
  inference_ts?: number;
  detections: Detection[];
}

// Base URL for the inference server. Using the same value everywhere ensures
// that the frontend consistently talks to the correct backend port regardless
// of the current origin (e.g. dev server on 3000). Allow overriding via
// window.SERVER_URL so deployments can specify a custom endpoint or protocol.
export const SERVER_URL =
  (window as any).SERVER_URL ||
  `${window.location.protocol}//${window.location.hostname}:8000`;

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
  const res = await fetch(`${SERVER_URL}/offer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: offer.sdp || ''
  });
  const answer = await res.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });

  return pc;
}
