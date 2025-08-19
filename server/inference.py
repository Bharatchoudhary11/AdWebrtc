import os
import numpy as np
import onnxruntime as ort
from PIL import Image
import urllib.request


class Detector:
    """Simple object detector using an ONNX model."""

    def __init__(self, model_path: str | None = None) -> None:
        """Load model for inference.

        Args:
            model_path: Path to ONNX model. Defaults to models/yolov5n.onnx.
        """
        self.model_path = model_path or os.getenv("MODEL_PATH", "models/yolov5n.onnx")
        if not os.path.exists(self.model_path):
            os.makedirs(os.path.dirname(self.model_path), exist_ok=True)
            print("Downloading YOLOv5n model...")
            urllib.request.urlretrieve(
                "https://github.com/ultralytics/yolov5/releases/download/v6.0/yolov5n.onnx",
                self.model_path,
            )
        providers = ["CPUExecutionProvider"]
        self.session = ort.InferenceSession(self.model_path, providers=providers)
        self.input_name = self.session.get_inputs()[0].name
        self.size = (320, 240)  # width, height

    def _preprocess(self, frame) -> np.ndarray:
        img = frame.to_image().resize(self.size)
        arr = np.array(img).astype(np.float32) / 255.0
        arr = arr.transpose(2, 0, 1)[None, ...]  # NCHW
        return arr

    def _postprocess(self, outputs, conf_thres: float = 0.25):
        pred = outputs[0]
        if isinstance(pred, list):
            pred = pred[0]
        pred = np.squeeze(pred, axis=0)
        if pred.ndim != 2 or pred.shape[1] < 85:
            return []

        boxes = pred[:, :4]
        objectness = pred[:, 4]
        class_scores = pred[:, 5:]
        scores = objectness * class_scores.max(axis=1)
        classes = class_scores.argmax(axis=1)

        keep = scores >= conf_thres
        boxes = boxes[keep]
        scores = scores[keep]
        classes = classes[keep]

        cx, cy, w, h = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
        xmin = np.clip(cx - w / 2, 0, 1)
        ymin = np.clip(cy - h / 2, 0, 1)
        xmax = np.clip(cx + w / 2, 0, 1)
        ymax = np.clip(cy + h / 2, 0, 1)

        detections = []
        for i in range(len(scores)):
            detections.append(
                {
                    "label": int(classes[i]),
                    "score": float(scores[i]),
                    "xmin": float(xmin[i]),
                    "ymin": float(ymin[i]),
                    "xmax": float(xmax[i]),
                    "ymax": float(ymax[i]),
                }
            )
        return detections

    def run(self, frame):
        inp = self._preprocess(frame)
        outputs = self.session.run(None, {self.input_name: inp})
        return self._postprocess(outputs)
