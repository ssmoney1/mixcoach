"""Live WASAPI loopback meter.

Records the default speaker via soundcard's loopback in small chunks and
emits one JSON line per chunk to stdout:

    {"peak_db": -12.4, "rms_db": -22.7}

dBFS reference is full-scale (|sample|=1.0 → 0 dBFS). Silence reports
peak_db = -inf, sanitized to null so the Node side can JSON.parse it.

Designed to run forever. Exits cleanly on stdin EOF or SIGTERM (Electron
sends SIGTERM via ChildProcess.kill() on Windows by terminating the
process — that's fine).
"""

from __future__ import annotations

import json
import math
import sys
import threading
import time
import traceback
from typing import Any

SAMPLE_RATE = 44_100
CHANNELS = 2
# 100ms chunks → 10 updates per second. Small enough to feel live, big
# enough that the spawn → IPC → DOM update path doesn't burn CPU.
CHUNK_SECONDS = 0.1
CHUNK_FRAMES = int(SAMPLE_RATE * CHUNK_SECONDS)


def _emit(payload: dict[str, Any]) -> None:
    def san(v: Any) -> Any:
        if isinstance(v, float):
            return v if math.isfinite(v) else None
        return v

    out = {k: san(v) for k, v in payload.items()}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()


def _watch_stdin_for_eof(stop_event: threading.Event) -> None:
    """Exit when stdin closes — the parent process uses this as a kill
    signal. stdin.read() blocks until close or any input; either way we
    treat it as 'stop'."""
    try:
        sys.stdin.read()
    except Exception:
        pass
    stop_event.set()


def main() -> None:
    try:
        import numpy as np
        import soundcard as sc
    except Exception as exc:  # noqa: BLE001
        _emit({"error": f"import failed: {exc}"})
        return

    stop_event = threading.Event()
    threading.Thread(
        target=_watch_stdin_for_eof, args=(stop_event,), daemon=True
    ).start()

    try:
        speaker = sc.default_speaker()
        mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)
    except Exception as exc:  # noqa: BLE001
        _emit({"error": f"loopback open failed: {exc}", "trace": traceback.format_exc()})
        return

    try:
        with mic.recorder(samplerate=SAMPLE_RATE, channels=CHANNELS) as rec:
            while not stop_event.is_set():
                data = rec.record(numframes=CHUNK_FRAMES)
                if data is None or data.size == 0:
                    time.sleep(CHUNK_SECONDS)
                    continue
                arr = np.asarray(data, dtype=np.float64)
                peak = float(np.max(np.abs(arr))) if arr.size else 0.0
                rms = float(np.sqrt(np.mean(arr ** 2))) if arr.size else 0.0
                peak_db = 20.0 * math.log10(peak) if peak > 0 else float("-inf")
                rms_db = 20.0 * math.log10(rms) if rms > 0 else float("-inf")
                _emit({"peak_db": peak_db, "rms_db": rms_db})
    except Exception as exc:  # noqa: BLE001
        _emit({"error": f"meter loop failed: {exc}", "trace": traceback.format_exc()})


if __name__ == "__main__":
    main()
