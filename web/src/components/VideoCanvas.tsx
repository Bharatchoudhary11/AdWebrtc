import React, { forwardRef, useEffect, useRef, useImperativeHandle } from 'react';
import { Detection, drawDetections } from '../lib/overlay';

interface Props {
  stream: MediaStream | null;
  detections: Detection[];
}

const VideoCanvas = forwardRef<HTMLVideoElement, Props>(({ stream, detections }, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<OffscreenCanvas | null>(null);
  const offsetRef = useRef(0);
  const rafRef = useRef<number>();
  const SPEED = 5; // pixels per frame

  useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(() => {});
    }
  }, [stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      return;
    }

    if (
      !offscreenRef.current ||
      offscreenRef.current.width !== video.videoWidth ||
      offscreenRef.current.height !== video.videoHeight
    ) {
      offscreenRef.current = new OffscreenCanvas(video.videoWidth, video.videoHeight);
    }

    const ctx = offscreenRef.current.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, video.videoWidth, video.videoHeight);
    drawDetections(ctx, detections, video.videoWidth, video.videoHeight);
  }, [detections]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const render = () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w && h) {
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        offsetRef.current = (offsetRef.current + SPEED) % w;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(video, -offsetRef.current, 0, w, h);
        if (offsetRef.current > 0) {
          ctx.drawImage(video, w - offsetRef.current, 0, w, h);
        }
        if (offscreenRef.current) {
          ctx.drawImage(offscreenRef.current, -offsetRef.current, 0);
          if (offsetRef.current > 0) {
            ctx.drawImage(offscreenRef.current, w - offsetRef.current, 0);
          }
        }
      }
      rafRef.current = requestAnimationFrame(render);
    };
    rafRef.current = requestAnimationFrame(render);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div style={{ position: 'relative' }}>
      <canvas ref={canvasRef} />
      <video ref={videoRef} autoPlay playsInline muted style={{ display: 'none' }} />
    </div>
  );
});

export default VideoCanvas;
