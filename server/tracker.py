import math
from typing import Dict, List, Tuple


class SimpleTracker:
    """Track objects across frames using centroid distance.

    Each detection is matched to an existing track based on the nearest centroid.
    Unmatched detections start new tracks, and tracks that go missing for too
    long are removed.
    """

    def __init__(self, max_distance: float = 0.1, max_missing: int = 5) -> None:
        self.max_distance = max_distance
        self.max_missing = max_missing
        self.tracks: Dict[int, Dict[str, Tuple[float, float] | int]] = {}
        self.next_id = 1

    def update(self, detections: List[Dict]) -> List[Dict]:
        """Update tracker with latest detections.

        Args:
            detections: List of detection dicts containing xmin, ymin, xmax, ymax.

        Returns:
            List of detections with an added `id` field.
        """
        # Mark all tracks as missed initially
        for track in self.tracks.values():
            track["missed"] += 1

        for det in detections:
            cx = (det["xmin"] + det["xmax"]) / 2
            cy = (det["ymin"] + det["ymax"]) / 2

            best_id = None
            best_dist = self.max_distance
            for tid, track in self.tracks.items():
                tx, ty = track["center"]
                dist = math.hypot(cx - tx, cy - ty)
                if dist < best_dist:
                    best_dist = dist
                    best_id = tid

            if best_id is not None:
                self.tracks[best_id]["center"] = (cx, cy)
                self.tracks[best_id]["missed"] = 0
                det["id"] = best_id
            else:
                tid = self.next_id
                self.next_id += 1
                self.tracks[tid] = {"center": (cx, cy), "missed": 0}
                det["id"] = tid

        # Drop tracks that have been missing for too long
        self.tracks = {
            tid: track
            for tid, track in self.tracks.items()
            if track["missed"] <= self.max_missing
        }

        return detections
