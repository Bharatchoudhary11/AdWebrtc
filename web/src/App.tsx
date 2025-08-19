import React, { useEffect, useRef, useState } from 'react';
import VideoCanvas from './components/VideoCanvas';
import QRJoin from './components/QRJoin';
import StatsPanel from './components/StatsPanel';
import { Metrics } from './lib/metrics';
import { Detection } from './lib/overlay';
import { initWebRTC } from './lib/webrtc';
import { warmup, infer } from './lib/wasm_infer';

const MODE = import.meta.env.VITE_MODE as 'wasm' | 'server';

export default function App() {
  const [lowRes, setLowRes] = useState(true);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [serverDown, setServerDown] = useState(false);
  const metricsRef = useRef(new Metrics());
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const workerBusy = useRef(false);
  const frameCountRef = useRef(0);

  // setup media stream
  useEffect(() => {
    (async () => {
      const constraints: MediaStreamConstraints = {
        video: {
          width: lowRes ? 320 : 640,
          height: lowRes ? 240 : 480,
          frameRate: lowRes ? 10 : 30
        },
        audio: false
      };
      if (!navigator.mediaDevices?.getUserMedia) {
        console.error('getUserMedia is not supported in this browser');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      if (MODE === 'server') {
        try {
          const res = await fetch('/health');
          if (!res.ok) throw new Error('bad');
        } catch {
          setServerDown(true);
        }
        pcRef.current = await initWebRTC(stream, msg => {
          setDetections(msg.detections);
          const sent = msg.capture_ts ?? msg.recv_ts ?? performance.now();
          metricsRef.current.record(sent, performance.now());
          frameCountRef.current++;
        });
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
    const fps = lowRes ? 10 : 30;
    const interval = 1000 / fps;
    let last = 0;
    const loop = async (now: number) => {
      if (!active) return;
      if (now - last > interval && !workerBusy.current) {
        last = now;
        const bitmap = await captureFrame();
        if (bitmap) {
          workerBusy.current = true;
          infer(bitmap).then(({ capture_ts, inference_ts, detections }) => {
            workerBusy.current = false;
            setDetections(detections);
            metricsRef.current.record(capture_ts, inference_ts);
            frameCountRef.current++;
          }).catch(err => {
            workerBusy.current = false;
            console.error(err);
          });
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
            body: JSON.stringify({ fps, kbps_up, kbps_down })
          }).catch(() => {});
        }).catch(() => {
          fetch('/api/bench/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fps })
          }).catch(() => {});
        });
      } else {
        fetch('/api/bench/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fps })
        }).catch(() => {});
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const captureFrame = async (): Promise<ImageBitmap | null> => {
    const video = videoRef.current;
    if (!video) return null;
    const canvas = document.createElement('canvas');
    const w = lowRes ? 320 : video.videoWidth;
    const h = lowRes ? 240 : video.videoHeight;
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

  const url = window.location.href;

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
      <QRJoin url={url} />
    </div>
  );
}
