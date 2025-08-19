import React, { forwardRef, useEffect, useRef, useImperativeHandle } from 'react';
import { Detection, drawDetections } from '../lib/overlay';

interface Props {
  stream: MediaStream | null;
  detections: Detection[];
}

const VideoCanvas = forwardRef<HTMLVideoElement, Props>(({ stream, detections }, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawDetections(ctx, detections, canvas.width, canvas.height);
  }, [detections]);

  return (
    <div style={{ position: 'relative' }}>
      <video ref={videoRef} autoPlay playsInline muted style={{ transform: 'scaleX(-1)' }} />
      <canvas ref={canvasRef} style={{ position: 'absolute', top: 0, left: 0 }} />
    </div>
  );
});

export default VideoCanvas;
