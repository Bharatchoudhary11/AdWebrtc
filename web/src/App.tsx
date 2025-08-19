import React, { useEffect, useRef, useState } from 'react';
import VideoCanvas from './components/VideoCanvas';
import QRJoin from './components/QRJoin';
import StatsPanel from './components/StatsPanel';
import { Metrics } from './lib/metrics';
import { Detection } from './lib/overlay';
import { initWebRTC } from './lib/webrtc';

const MODE = import.meta.env.VITE_MODE as 'wasm' | 'server';

export default function App() {
  const [lowRes, setLowRes] = useState(true);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [serverDown, setServerDown] = useState(false);
  const metricsRef = useRef(new Metrics());
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker>();
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const workerBusy = useRef(false);

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
          metricsRef.current.record(msg.ts, performance.now());
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
    const worker = new Worker(new URL('./lib/wasm_infer.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = ev => {
      workerBusy.current = false;
      const { ts, detections } = ev.data;
      setDetections(detections);
      metricsRef.current.record(ts, performance.now());
    };
    worker.postMessage({ type: 'init' });
    return () => worker.terminate();
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
      if (now - last > interval && workerRef.current && !workerBusy.current) {
        last = now;
        const bitmap = await captureFrame();
        if (bitmap) {
          workerBusy.current = true;
          workerRef.current.postMessage({ type: 'frame', image: bitmap, ts: performance.now() }, [bitmap]);
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return () => {
      active = false;
    };
  }, [lowRes]);

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
