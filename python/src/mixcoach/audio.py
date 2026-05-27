"""Audio analysis stubs. Replace with real logic."""

from __future__ import annotations

from typing import Any


def analyze(path: str) -> dict[str, Any]:
    return {
        "path": path,
        "duration_sec": None,
        "tempo_bpm": None,
        "key": None,
        "status": "stub",
    }
