"""Analyze a reference / static audio file and emit the same JSON shape
as capture_and_analyze.py.

Reuses the local DSP analyzer from `capture_and_analyze._analyze`. Handles
WAV / FLAC / AIFF natively via soundfile, falls back to librosa (which
uses audioread + system codecs) for MP3 / M4A / OGG when needed.

Usage: pass the file path either as the first CLI arg OR via the
MIXCOACH_REF_PATH environment variable.

Always prints a single JSON object on stdout. Never crashes — failures
become `{"ok": false, "error": ...}`.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import traceback
import wave
from pathlib import Path
from typing import Any

# Re-use the analyzer that capture_and_analyze.py already exposes.
from capture_and_analyze import _analyze, _sanitize


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

    tmp_path: Path | None = None
    analysis_target: Path = src

    try:
        if not _is_native(src):
            try:
                tmp_path = _to_wav_via_librosa(src)
                analysis_target = tmp_path
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
            # libsndfile occasionally chokes on exotic WAV subtypes; try
            # opening it once and re-encode if it fails.
            try:
                with wave.open(str(src), "rb") as _:
                    pass
            except Exception:
                try:
                    tmp_path = _to_wav_via_librosa(src)
                    analysis_target = tmp_path
                except Exception:
                    # Let _analyze raise naturally with the real error.
                    pass

        try:
            payload = _analyze(analysis_target)
        except Exception as exc:  # noqa: BLE001
            payload = {
                "ok": False,
                "error": f"analysis failed: {exc}",
                "trace": traceback.format_exc(),
            }

        # Tag the result so the UI can show which file this verdict came from.
        payload.setdefault("source", "local")
        payload["reference_filename"] = src.name
        payload["reference_path"] = str(src)
        _emit(payload)
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass


if __name__ == "__main__":
    main()
