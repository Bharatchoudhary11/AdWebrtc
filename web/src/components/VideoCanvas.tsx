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
  const dirtyRef = useRef(false);
  const rafRef = useRef<number>();

  useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    if (!offscreenRef.current ||
        offscreenRef.current.width !== canvas.width ||
        offscreenRef.current.height !== canvas.height) {
      offscreenRef.current = new OffscreenCanvas(canvas.width, canvas.height);
    }

    const ctx = offscreenRef.current.getContext('2d');
    if (!ctx) return;
    drawDetections(ctx, detections, canvas.width, canvas.height);
    dirtyRef.current = true;
  }, [detections]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const render = () => {
      if (dirtyRef.current && offscreenRef.current) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(offscreenRef.current, 0, 0);
        dirtyRef.current = false;
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
      <video ref={videoRef} autoPlay playsInline muted style={{ transform: 'scaleX(-1)' }} />
      <canvas ref={canvasRef} style={{ position: 'absolute', top: 0, left: 0 }} />
    </div>
  );
});

export default VideoCanvas;
