export interface Detection {
  x: number; // normalized top-left x
  y: number; // normalized top-left y
  w: number; // normalized width
  h: number; // normalized height
  label?: string;
  score?: number;
}

export function normToPixels(det: Detection, width: number, height: number) {
  return {
    x: det.x * width,
    y: det.y * height,
    w: det.w * width,
    h: det.h * height,
    label: det.label,
    score: det.score
  };
}

export function drawDetections(
  ctx: CanvasRenderingContext2D,
  detections: Detection[],
  width: number,
  height: number
) {
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'lime';
  ctx.font = '16px sans-serif';
  detections.forEach(det => {
    const d = normToPixels(det, width, height);
    ctx.strokeRect(d.x, d.y, d.w, d.h);
    if (d.label) {
      ctx.fillStyle = 'lime';
      const text = `${d.label}${d.score ? ` ${(d.score * 100).toFixed(1)}%` : ''}`;
      ctx.fillText(text, d.x + 4, d.y + 16);
    }
  });
}
