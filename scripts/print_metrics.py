#!/usr/bin/env python3
"""Fetch and print backend metrics for given device IDs.

Usage:
  python scripts/print_metrics.py DEVICE_ID [DEVICE_ID ...] [--url http://localhost:8000]
"""

import argparse
import json
from urllib.request import urlopen


def fetch_metrics(device_id: str, base_url: str) -> dict:
    """Fetch metrics for a device ID from the backend server."""
    url = f"{base_url}/?device_id={device_id}"
    with urlopen(url) as resp:
        return json.load(resp)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Print backend metrics for specified device IDs"
    )
    parser.add_argument("device_ids", nargs="+", help="Device IDs to query")
    parser.add_argument(
        "--url",
        default="http://localhost:8000",
        help="Base URL of the backend server (default: http://localhost:8000)",
    )
    args = parser.parse_args()

    for device_id in args.device_ids:
        data = fetch_metrics(device_id, args.url)
        metrics = data.get("metrics", [])
        print(f"Metrics for {device_id}:")
        print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
