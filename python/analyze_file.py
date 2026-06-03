"""Analyze a reference / static audio file and emit the same JSON shape
as capture_and_analyze.py.

Instead of analyzing the whole file, this extracts a 15-second segment
(matching the mix capture length) starting at a user-supplied timestamp,
analyzes THAT window, and also writes the segment out as a 16-bit WAV so
the Electron side can attach it to Gemini ("AUDIO 2: the reference").

Start point:
  - MIXCOACH_REF_START_SEC accepts `90`, `90.5`, or `mm:ss` / `h:mm:ss`.
  - Empty / invalid → 50% into the file (lands mid-song, not on an intro).
  - Clamped so the 15s window always fits inside the file; files shorter
    than 15s are used whole.

Clip output path comes from MIXCOACH_REF_CLIP_OUT (falls back to a temp
file if unset). The source path is the first CLI arg OR MIXCOACH_REF_PATH.

Reuses the local DSP analyzer from `capture_and_analyze._analyze`. Handles
WAV / FLAC / AIFF natively via soundfile, falls back to librosa for
MP3 / M4A / OGG when needed.

Always prints a single JSON object on stdout. Never crashes — failures
become `{"ok": false, "error": ...}`.
"""

from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import traceback
import wave
from pathlib import Path
from typing import Any

# Re-use the analyzer that capture_and_analyze.py already exposes.
from capture_and_analyze import _analyze, _sanitize

# Segment length must match the mix capture (capture_and_analyze.RECORD_SECONDS)
# so we A/B equal-length windows.
SEGMENT_SECONDS = 15


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(_sanitize(payload)) + "\n")
    sys.stdout.flush()


# Formats soundfile (libsndfile) can decode natively without conversion.
_NATIVE_EXTS = {".wav", ".flac", ".aiff", ".aif", ".ogg", ".opus", ".w64"}


def _is_native(path: Path) -> bool:
    return path.suffix.lower() in _NATIVE_EXTS


def _to_wav_via_librosa(src: Path) -> Path:
    """Decode any audio file librosa can read and write it back as a 16-bit
    WAV at the source sample rate. Used as a fallback for formats libsndfile
    cannot decode directly (e.g. older MP3 / M4A on some platforms)."""
    import librosa  # type: ignore
    import numpy as np  # type: ignore
    import soundfile as sf  # type: ignore

    # mono=False preserves channels; sr=None preserves native sample rate.
    audio, sr = librosa.load(str(src), sr=None, mono=False)
    if audio.ndim == 1:
        audio = audio[None, :]  # (channels, samples)
    audio = np.clip(audio.T, -1.0, 1.0).astype(np.float32)  # (samples, channels)

    fd, tmp_str = tempfile.mkstemp(suffix=".wav", prefix="mixcoach_ref_")
    os.close(fd)
    tmp = Path(tmp_str)
    sf.write(str(tmp), audio, int(sr), subtype="PCM_16")
    return tmp


def _parse_start_sec(raw: str, duration: float) -> float:
    """Parse the requested start time. Accepts plain seconds (`90`, `90.5`)
    or colon time (`1:30`, `1:02:03`). Empty / invalid → 50% into the file."""
    s = (raw or "").strip()
    default = max(0.0, duration * 0.5)
    if not s:
        return default
    try:
        if ":" in s:
            parts = [float(p) for p in s.split(":")]
            if len(parts) == 2:
                val = parts[0] * 60 + parts[1]
            elif len(parts) == 3:
                val = parts[0] * 3600 + parts[1] * 60 + parts[2]
            else:
                val = float(parts[-1])
        else:
            val = float(s)
    except ValueError:
        return default
    if not math.isfinite(val) or val < 0:
        return default
    return val


def _make_clip(readable_wav: Path, out_path: Path, start_raw: str) -> dict[str, Any]:
    """Read `readable_wav`, slice a SEGMENT_SECONDS window starting at the
    requested timestamp, write it to `out_path` as 16-bit PCM, and return
    metadata describing what was actually taken."""
    import soundfile as sf  # type: ignore

    with sf.SoundFile(str(readable_wav)) as snd:
        sr = int(snd.samplerate)
        total_frames = len(snd)
        data = snd.read(always_2d=True)

    duration = total_frames / sr if sr > 0 else 0.0
    requested_start = _parse_start_sec(start_raw, duration)

    if duration <= SEGMENT_SECONDS:
        # File shorter than a full window — use the whole thing.
        start_sec = 0.0
        seg = data
    else:
        start_sec = requested_start
        if start_sec + SEGMENT_SECONDS > duration:
            start_sec = max(0.0, duration - SEGMENT_SECONDS)
        start_frame = int(round(start_sec * sr))
        seg_frames = int(round(SEGMENT_SECONDS * sr))
        seg = data[start_frame:start_frame + seg_frames]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), seg, sr, subtype="PCM_16")

    clip_seconds = (len(seg) / sr) if sr > 0 else 0.0
    return {
        "clip_path": str(out_path),
        "start_sec": float(start_sec),
        "clip_seconds": float(clip_seconds),
        "source_duration_sec": float(duration),
        "requested_start_sec": float(requested_start),
    }


def _resolve_path() -> Path | None:
    if len(sys.argv) > 1 and sys.argv[1].strip():
        return Path(sys.argv[1])
    env = os.environ.get("MIXCOACH_REF_PATH", "").strip()
    if env:
        return Path(env)
    return None


def main() -> None:
    src = _resolve_path()
    if src is None:
        _emit({"ok": False, "error": "no audio file path provided"})
        return
    if not src.exists():
        _emit({"ok": False, "error": f"file not found: {src}"})
        return

    # Where to write the 15s clip we attach to Gemini.
    clip_out_env = os.environ.get("MIXCOACH_REF_CLIP_OUT", "").strip()
    if clip_out_env:
        clip_out = Path(clip_out_env)
    else:
        fd, tmp_clip = tempfile.mkstemp(suffix=".wav", prefix="mixcoach_refclip_")
        os.close(fd)
        clip_out = Path(tmp_clip)
    start_raw = os.environ.get("MIXCOACH_REF_START_SEC", "")

    tmp_decoded: Path | None = None  # full-file decode (deleted at the end)
    try:
        # 1. Get a path libsndfile can read (decode exotic formats first).
        readable: Path = src
        if not _is_native(src):
            try:
                tmp_decoded = _to_wav_via_librosa(src)
                readable = tmp_decoded
            except Exception as exc:  # noqa: BLE001
                _emit(
                    {
                        "ok": False,
                        "error": f"could not decode {src.suffix} via librosa: {exc}",
                        "trace": traceback.format_exc(),
                    }
                )
                return
        else:
            # libsndfile occasionally chokes on exotic WAV subtypes; probe it
            # and re-encode via librosa if the plain wave reader fails.
            try:
                with wave.open(str(src), "rb"):
                    pass
            except Exception:
                try:
                    tmp_decoded = _to_wav_via_librosa(src)
                    readable = tmp_decoded
                except Exception:
                    pass  # let _make_clip surface the real error

        # 2. Slice the 15s window at the requested timestamp + write the clip.
        try:
            clip_meta = _make_clip(readable, clip_out, start_raw)
        except Exception as exc:  # noqa: BLE001
            _emit(
                {
                    "ok": False,
                    "error": f"clip extraction failed: {exc}",
                    "trace": traceback.format_exc(),
                }
            )
            return

        # 3. Analyze the CLIP (so the deltas describe the exact 15s we send).
        try:
            payload = _analyze(Path(clip_meta["clip_path"]))
        except Exception as exc:  # noqa: BLE001
            payload = {
                "ok": False,
                "error": f"analysis failed: {exc}",
                "trace": traceback.format_exc(),
            }

        # Tag the result so the UI + Electron side know what was taken.
        payload.setdefault("source", "local")
        payload["reference_filename"] = src.name
        payload["reference_path"] = str(src)
        payload["reference_clip_path"] = clip_meta["clip_path"]
        payload["reference_start_sec"] = clip_meta["start_sec"]
        payload["reference_clip_seconds"] = clip_meta["clip_seconds"]
        payload["reference_duration_sec"] = clip_meta["source_duration_sec"]
        _emit(payload)
    finally:
        # Only delete the full-file decode; the clip must survive for Electron.
        if tmp_decoded is not None:
            try:
                tmp_decoded.unlink(missing_ok=True)
            except Exception:
                pass


if __name__ == "__main__":
    main()
