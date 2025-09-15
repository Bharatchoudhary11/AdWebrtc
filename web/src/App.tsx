import React, { useEffect, useRef, useState } from 'react';
import VideoCanvas from './components/VideoCanvas';
import QRJoin from './components/QRJoin';
import StatsPanel from './components/StatsPanel';
import { Metrics } from './lib/metrics';
import { Detection } from './lib/overlay';
import { initWebRTC, SERVER_URL } from './lib/webrtc';
import { warmup, infer } from './lib/wasm_infer';
import { deviceId } from './lib/device';

const MODE = import.meta.env.VITE_MODE as 'wasm' | 'server';

export default function App() {
  const [lowRes, setLowRes] = useState(true);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [serverDown, setServerDown] = useState(false);
  const [joinUrl, setJoinUrl] = useState(() => {
    const loc = window.location
    const isLocalHost = ['localhost', '127.0.0.1'].includes(loc.hostname)
    const proto = !isLocalHost && loc.protocol === 'http:' ? 'https:' : loc.protocol
    return `${proto}//${loc.host}`
  });
  const metricsRef = useRef(new Metrics());
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const frameCountRef = useRef(0);

  // setup media stream
  useEffect(() => {
    // Only run in browser
    if (typeof window === "undefined" || typeof navigator === "undefined") return;

    (async () => {
      const constraints: MediaStreamConstraints = {
        video: {
          width: lowRes ? 320 : 640,
          // Height of 240 caused zero-dimension frames which in turn led to
          // canvas drawImage errors and ONNXRuntime shape mismatches. Use 256
          // which is divisible by 32 and matches the worker's expectations.
          height: lowRes ? 256 : 480,
          frameRate: 30
        },
        audio: false
      };
      const mediaDevices = navigator.mediaDevices;
      const getUserMedia = mediaDevices?.getUserMedia
        || (navigator as any).getUserMedia
        || (navigator as any).webkitGetUserMedia
        || (navigator as any).mozGetUserMedia;

      if (!window.isSecureContext || !getUserMedia) {
        console.error('getUserMedia requires HTTPS or localhost');
        setServerDown(true);
        return;
      }

      try {
        const stream = mediaDevices?.getUserMedia
          ? await mediaDevices.getUserMedia(constraints)
          : await new Promise<MediaStream>((resolve, reject) =>
              getUserMedia.call(navigator, constraints, resolve, reject)
            );
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.stop());
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          try {
            await videoRef.current.play();
          } catch (err) {
            console.warn('Failed to play video stream', err);
          }
        }
        if (MODE === 'server') {
          try {
            const res = await fetch(`${SERVER_URL}/health`);
            if (!res.ok) throw new Error('bad');
          } catch {
            setServerDown(true);
          }
          pcRef.current = await initWebRTC(stream, msg => {
            setDetections(msg.detections);
            if (msg.detections.some(d => d.label && ['left', 'right'].includes(d.label.toLowerCase()))) {
              setEvents(e => [...e, 'User is looking away']);
            }
            const sent = msg.capture_ts ?? msg.recv_ts ?? performance.now();
            const now = performance.now();
            const serverLatency =
              typeof msg.inference_ts === 'number' && typeof msg.recv_ts === 'number'
                ? msg.inference_ts - msg.recv_ts
                : undefined;
            const networkLatency =
              typeof msg.recv_ts === 'number' && typeof msg.capture_ts === 'number'
                ? msg.recv_ts - msg.capture_ts
                : undefined;
            metricsRef.current.record(sent, now, {
              server: serverLatency,
              network: networkLatency,
            });
            frameCountRef.current++;
          });
        }
      } catch (err) {
        console.error('Error accessing camera:', err);
        setServerDown(true);
      }
    })();
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      pcRef.current?.close();
    };
  }, [lowRes]);

  // wasm worker setup
  useEffect(() => {
    if (MODE !== 'wasm') return;
    warmup().catch(err => console.error(err));
  }, []);

  // frame capture loop for wasm mode
  useEffect(() => {
    if (MODE !== 'wasm') return;
    let active = true;
    const fps = 12; // clamp inference FPS
    const interval = 1000 / fps;
    let last = 0;
    const loop = async (now: number) => {
      if (!active) return;
      if (now - last > interval) {
        last = now;
        // Wait for the video element to have valid dimensions before attempting
        // to capture a frame. This prevents repeated "Video not ready" warnings
        // and zero-sized OffscreenCanvas errors.
        const vid = videoRef.current;
        if (vid && vid.readyState >= 2) {
          const bitmap = await captureFrame();
          if (bitmap) {
            infer(bitmap)
              .then(output => {
                if (output) {
                  const { capture_ts, detections } = output;
                  const inference_ts = performance.now();
                  setDetections(detections);
                  if (detections.some(d => d.label && ['left', 'right'].includes(d.label.toLowerCase()))) {
                    setEvents(e => [...e, 'User is looking away']);
                  }
                  metricsRef.current.record(capture_ts, inference_ts);
                  frameCountRef.current++;
                }
              })
              .catch(err => {
                console.error(err);
              });
          }
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return () => {
      active = false;
    };
  }, [lowRes]);

  // Periodically push FPS and bandwidth stats to bench endpoint
  useEffect(() => {
    let lastFrames = 0;
    const lastBytes = { up: 0, down: 0 };
    const id = setInterval(() => {
      const fps = frameCountRef.current - lastFrames;
      lastFrames = frameCountRef.current;
      if (pcRef.current) {
        pcRef.current.getStats().then(stats => {
          let sent = 0;
          let recv = 0;
          stats.forEach(r => {
            if (r.type === 'outbound-rtp' && (r as any).bytesSent) sent += (r as any).bytesSent;
            if (r.type === 'inbound-rtp' && (r as any).bytesReceived) recv += (r as any).bytesReceived;
          });
          const kbps_up = (sent - lastBytes.up) * 8 / 1000;
          const kbps_down = (recv - lastBytes.down) * 8 / 1000;
          lastBytes.up = sent;
          lastBytes.down = recv;
          fetch('/api/bench/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: deviceId, fps, kbps_up, kbps_down })
          }).catch(() => {});
        }).catch(() => {
          fetch('/api/bench/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: deviceId, fps })
          }).catch(() => {});
        });
      } else {
        fetch('/api/bench/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: deviceId, fps })
        }).catch(() => {});
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const captureFrame = async (): Promise<ImageBitmap | null> => {
    const video = videoRef.current;
    if (
      !video ||
      video.readyState < 2 ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      console.warn('Video not ready for drawImage', video);
      return null;
    }
    const canvas = document.createElement('canvas');
    const w = lowRes ? 320 : video.videoWidth;
    const h = lowRes ? 256 : video.videoHeight;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return await createImageBitmap(canvas);
  };

  const saveMetrics = () => {
    const data = metricsRef.current.toJSON();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'metrics.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Prefer a join URL from the server if provided (e.g. ngrok)
  useEffect(() => {
    fetch('/join.txt')
      .then(res => (res.ok ? res.text() : ''))
      .then(text => {
        const t = text.trim();
        if (t) {
          try {
            const u = new URL(t)
            const isLocal = ['localhost', '127.0.0.1'].includes(u.hostname)
            if (!isLocal && u.protocol === 'http:') u.protocol = 'https:'
            setJoinUrl(u.toString())
          } catch {
            setJoinUrl(t)
          }
        }
      })
      .catch(() => {});
  }, []);

  return (
    <div>
      {serverDown && MODE === 'server' && (
        <div style={{ background: 'red', color: 'white', padding: '4px' }}>
          Server unreachable
        </div>
      )}
      <VideoCanvas ref={videoRef} stream={streamRef.current} detections={detections} />
      <div>
        <label>
          <input
            type="checkbox"
            checked={lowRes}
            onChange={e => setLowRes(e.target.checked)}
          />
          Low resource mode
        </label>
        <button onClick={saveMetrics}>Save metrics</button>
      </div>
      <StatsPanel metrics={metricsRef.current.summary()} />
      <div>
        <h3>Event log</h3>
        <ul>
          {events.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      </div>
      <QRJoin url={joinUrl} />
    </div>
  );
}
