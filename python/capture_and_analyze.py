"""Record 15 seconds of WASAPI loopback audio and run a fully local analysis.

# ROEX_DISABLED — RoEx Tonn API integration is currently disabled. All RoEx
# logic is preserved below behind `# ROEX_DISABLED` prefixes so it can be
# brought back by uncommenting + restoring the dispatch in `main()` and
# re-adding `roex-python` to requirements.txt.

Always prints a single JSON object on stdout describing the result and deletes
the temp WAV before exit. Never crashes — failures are reported as
`{"ok": false, "error": ...}`.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import sys
import tempfile
# ROEX_DISABLED import time
import traceback
import wave
from pathlib import Path
from typing import Any

SAMPLE_RATE = 44_100
CHANNELS = 2
RECORD_SECONDS = 15

# Frequency bands (Hz). Used for both per-band dBFS readings and ratios.
BANDS: dict[str, tuple[float, float]] = {
    "sub": (20.0, 60.0),
    "bass": (60.0, 250.0),
    "low_mid": (250.0, 500.0),
    "mid": (500.0, 2000.0),
    "high_mid": (2000.0, 8000.0),
    "air": (8000.0, 20000.0),
}


def _sanitize(value: Any) -> Any:
    """Recursively replace non-finite floats (inf/-inf/NaN) with None so the
    emitted JSON parses cleanly on the Node side (Python's json.dumps writes
    the literal token 'Infinity'/'-Infinity'/'NaN' otherwise, which standard
    JSON.parse rejects)."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _sanitize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize(v) for v in value]
    if isinstance(value, tuple):
        return [_sanitize(v) for v in value]
    return value


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(_sanitize(payload)) + "\n")
    sys.stdout.flush()


def _record_loopback() -> Path:
    import numpy as np  # type: ignore
    import soundcard as sc  # type: ignore

    speaker = sc.default_speaker()
    mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)

    total_frames = SAMPLE_RATE * RECORD_SECONDS
    with mic.recorder(samplerate=SAMPLE_RATE, channels=CHANNELS) as rec:
        data = rec.record(numframes=total_frames)

    data = np.clip(data, -1.0, 1.0)
    pcm = (data * 32767.0).astype("<i2")

    fd, tmp_str = tempfile.mkstemp(suffix=".wav", prefix="mixcoach_")
    os.close(fd)  # close mkstemp's fd so wave.open can write and later unlink works
    tmp = Path(tmp_str)
    with wave.open(str(tmp), "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm.tobytes())
    return tmp


# ─────────────────────────────────────────────────────────────────────
# ROEX_DISABLED — Original RoEx analyzer. Preserved verbatim for re-enable.
# ─────────────────────────────────────────────────────────────────────
# ROEX_DISABLED def _roex_analyze(wav_path: Path, api_key: str) -> dict[str, Any]:
# ROEX_DISABLED     """Best-effort RoEx Tonn API call.
# ROEX_DISABLED
# ROEX_DISABLED     The roex-python SDK surface has shifted across versions, so we probe
# ROEX_DISABLED     for the common entry points instead of pinning one. If nothing works,
# ROEX_DISABLED     we raise and the caller falls back to local analysis.
# ROEX_DISABLED     """
# ROEX_DISABLED     try:
# ROEX_DISABLED         import roex_python  # type: ignore
# ROEX_DISABLED     except ImportError as exc:
# ROEX_DISABLED         raise RuntimeError(f"roex-python not installed: {exc}") from exc
# ROEX_DISABLED
# ROEX_DISABLED     client = None
# ROEX_DISABLED     for ctor_name in ("RoExClient", "Client", "TonnClient", "Tonn"):
# ROEX_DISABLED         ctor = getattr(roex_python, ctor_name, None)
# ROEX_DISABLED         if ctor is not None:
# ROEX_DISABLED             try:
# ROEX_DISABLED                 client = ctor(api_key=api_key)
# ROEX_DISABLED                 break
# ROEX_DISABLED             except Exception:
# ROEX_DISABLED                 continue
# ROEX_DISABLED     if client is None:
# ROEX_DISABLED         from_env = getattr(roex_python, "from_env", None)
# ROEX_DISABLED         if callable(from_env):
# ROEX_DISABLED             client = from_env()
# ROEX_DISABLED     if client is None:
# ROEX_DISABLED         raise RuntimeError("could not instantiate a RoEx client")
# ROEX_DISABLED
# ROEX_DISABLED     method = None
# ROEX_DISABLED     for name in ("analyze_mix", "mix_analysis", "analyze", "analyse_mix"):
# ROEX_DISABLED         candidate = getattr(client, name, None)
# ROEX_DISABLED         if callable(candidate):
# ROEX_DISABLED             method = candidate
# ROEX_DISABLED             break
# ROEX_DISABLED     if method is None:
# ROEX_DISABLED         raise RuntimeError("no mix-analysis method on RoEx client")
# ROEX_DISABLED
# ROEX_DISABLED     job = method(str(wav_path))
# ROEX_DISABLED
# ROEX_DISABLED     if isinstance(job, dict):
# ROEX_DISABLED         return job
# ROEX_DISABLED
# ROEX_DISABLED     for attr in ("wait", "result", "fetch"):
# ROEX_DISABLED         fn = getattr(job, attr, None)
# ROEX_DISABLED         if callable(fn):
# ROEX_DISABLED             try:
# ROEX_DISABLED                 out = fn(timeout=120) if attr == "wait" else fn()
# ROEX_DISABLED                 if isinstance(out, dict):
# ROEX_DISABLED                     return out
# ROEX_DISABLED                 if hasattr(out, "to_dict"):
# ROEX_DISABLED                     return out.to_dict()
# ROEX_DISABLED             except TypeError:
# ROEX_DISABLED                 try:
# ROEX_DISABLED                     out = fn()
# ROEX_DISABLED                     if isinstance(out, dict):
# ROEX_DISABLED                         return out
# ROEX_DISABLED                 except Exception:
# ROEX_DISABLED                     pass
# ROEX_DISABLED
# ROEX_DISABLED     job_id = getattr(job, "id", None) or getattr(job, "job_id", None)
# ROEX_DISABLED     status_fn = getattr(client, "get_status", None) or getattr(client, "status", None)
# ROEX_DISABLED     result_fn = getattr(client, "get_result", None) or getattr(client, "result", None)
# ROEX_DISABLED     if job_id and callable(status_fn) and callable(result_fn):
# ROEX_DISABLED         deadline = time.time() + 120
# ROEX_DISABLED         while time.time() < deadline:
# ROEX_DISABLED             status = status_fn(job_id)
# ROEX_DISABLED             state = (
# ROEX_DISABLED                 status.get("status") if isinstance(status, dict) else getattr(status, "status", None)
# ROEX_DISABLED             )
# ROEX_DISABLED             if state and str(state).lower() in {"done", "complete", "completed", "success"}:
# ROEX_DISABLED                 res = result_fn(job_id)
# ROEX_DISABLED                 if isinstance(res, dict):
# ROEX_DISABLED                     return res
# ROEX_DISABLED                 if hasattr(res, "to_dict"):
# ROEX_DISABLED                     return res.to_dict()
# ROEX_DISABLED                 break
# ROEX_DISABLED             time.sleep(2)
# ROEX_DISABLED
# ROEX_DISABLED     raise RuntimeError("RoEx call returned no usable result")
# ROEX_DISABLED
# ROEX_DISABLED
# ROEX_DISABLED def _normalize_roex(raw: dict[str, Any]) -> dict[str, Any]:
# ROEX_DISABLED     def pick(*keys: str) -> Any:
# ROEX_DISABLED         for k in keys:
# ROEX_DISABLED             if k in raw and raw[k] is not None:
# ROEX_DISABLED                 return raw[k]
# ROEX_DISABLED         if "results" in raw and isinstance(raw["results"], dict):
# ROEX_DISABLED             for k in keys:
# ROEX_DISABLED                 if k in raw["results"] and raw["results"][k] is not None:
# ROEX_DISABLED                     return raw["results"][k]
# ROEX_DISABLED         return None
# ROEX_DISABLED
# ROEX_DISABLED     return {
# ROEX_DISABLED         "source": "roex",
# ROEX_DISABLED         "integrated_lufs": pick("integrated_lufs", "lufs_integrated", "loudness"),
# ROEX_DISABLED         "true_peak_dbtp": pick("true_peak", "true_peak_dbtp", "peak"),
# ROEX_DISABLED         "dynamic_range": pick("dynamic_range", "dr", "lra"),
# ROEX_DISABLED         "stereo_width": pick("stereo_width", "width"),
# ROEX_DISABLED         "frequency_balance": pick("frequency_balance", "frequency_bands", "spectrum"),
# ROEX_DISABLED         "feedback": pick("feedback", "comments", "notes", "summary"),
# ROEX_DISABLED         "raw": raw,
# ROEX_DISABLED     }


def _bandpass_rms_dbfs(x: Any, sr: int, lo: float, hi: float) -> float:
    """RMS of a band-pass-filtered signal, in dBFS."""
    import numpy as np  # type: ignore
    from scipy.signal import butter, sosfiltfilt  # type: ignore

    nyq = sr / 2.0
    lo_n = max(lo, 1.0) / nyq
    hi_n = min(hi, nyq - 1.0) / nyq
    if hi_n <= lo_n or hi_n >= 1.0:
        return -120.0
    sos = butter(4, [lo_n, hi_n], btype="band", output="sos")
    y = sosfiltfilt(sos, x)
    rms = float(np.sqrt(np.mean(y ** 2)))
    if rms <= 0.0:
        return -120.0
    return 20.0 * float(np.log10(rms))


def _bandpass_power(x: Any, sr: int, lo: float, hi: float) -> float:
    """Mean squared amplitude (linear power) of a band-pass-filtered signal."""
    import numpy as np  # type: ignore
    from scipy.signal import butter, sosfiltfilt  # type: ignore

    nyq = sr / 2.0
    lo_n = max(lo, 1.0) / nyq
    hi_n = min(hi, nyq - 1.0) / nyq
    if hi_n <= lo_n or hi_n >= 1.0:
        return 0.0
    sos = butter(4, [lo_n, hi_n], btype="band", output="sos")
    y = sosfiltfilt(sos, x)
    return float(np.mean(y ** 2))


def _bit_depth_from_subtype(subtype: str | None) -> int | None:
    table = {
        "PCM_S8": 8,
        "PCM_U8": 8,
        "PCM_16": 16,
        "PCM_24": 24,
        "PCM_32": 32,
        "FLOAT": 32,
        "DOUBLE": 64,
    }
    return table.get(subtype or "", None)


def _analyze(wav_path: Path) -> dict[str, Any]:
    import numpy as np  # type: ignore
    import soundfile as sf  # type: ignore
    import pyloudnorm as pyln  # type: ignore
    from scipy.signal import resample_poly  # type: ignore

    # Use a context-managed SoundFile so the handle is closed before main()
    # tries to delete the temp WAV (sf.info alone leaks a handle on Windows).
    with sf.SoundFile(str(wav_path)) as snd:
        sample_rate = int(snd.samplerate)
        bit_depth = _bit_depth_from_subtype(snd.subtype)
        raw = snd.read(always_2d=True)

    sr = sample_rate
    audio = np.asarray(raw, dtype=np.float64)
    if audio.ndim == 1:
        audio = np.repeat(audio[:, None], 2, axis=1)
    elif audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    left = audio[:, 0]
    right = audio[:, 1]
    mono = (left + right) * 0.5

    # Integrated LUFS + LRA (ITU-R BS.1770)
    meter = pyln.Meter(sr)
    integrated_lufs = float(meter.integrated_loudness(audio))
    try:
        loudness_range_lra: float | None = float(meter.loudness_range(audio))
    except Exception:
        loudness_range_lra = None

    # True peak: 4× oversample then take max |sample|
    oversampled = resample_poly(audio, 4, 1, axis=0)
    tp = float(np.max(np.abs(oversampled))) if oversampled.size else 0.0
    true_peak_db = 20.0 * float(np.log10(tp)) if tp > 0 else -120.0

    # Sample-peak clipping detection (threshold 0.99)
    clipping_sample_count = int(np.sum(np.abs(audio) > 0.99))
    clipping_detected = clipping_sample_count > 0

    # Phase correlation between L and R → mono compatibility
    if float(left.std()) > 0 and float(right.std()) > 0:
        phase_correlation = float(np.corrcoef(left, right)[0, 1])
    else:
        phase_correlation = 1.0
    mono_compatible = phase_correlation > 0.0

    # Mid/side stereo width (0=mono, ~0.5=fully decorrelated)
    mid_ch = (left + right) * 0.5
    side_ch = (left - right) * 0.5
    mid_e = float(np.sum(mid_ch ** 2))
    side_e = float(np.sum(side_ch ** 2))
    stereo_width = side_e / (mid_e + side_e) if (mid_e + side_e) > 0 else 0.0

    # Crest factor: peak vs RMS, in dB
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    rms_total = float(np.sqrt(np.mean(audio ** 2))) if audio.size else 0.0
    crest_factor_db: float | None
    if rms_total > 0 and peak > 0:
        crest_factor_db = 20.0 * float(np.log10(peak / rms_total))
    else:
        crest_factor_db = None

    # Per-band RMS dBFS
    tonal_bands: dict[str, float] = {
        name: _bandpass_rms_dbfs(mono, sr, lo, hi)
        for name, (lo, hi) in BANDS.items()
    }
    dominant_band = max(tonal_bands, key=lambda k: tonal_bands[k])

    # Energy ratios (mud/harshness/sibilance) over full-band power
    total_power = _bandpass_power(mono, sr, 20.0, 20000.0) or 1e-12
    mud_ratio = _bandpass_power(mono, sr, 250.0, 500.0) / total_power
    harshness_ratio = _bandpass_power(mono, sr, 2000.0, 5000.0) / total_power
    sibilance_ratio = _bandpass_power(mono, sr, 6000.0, 10000.0) / total_power

    # ── Key + BPM (librosa) ─────────────────────────────────────────
    # Both can fail on silence or very short clips; surface None rather
    # than blowing up the whole audio analysis.
    key_label: str | None = None
    key_confidence: float | None = None
    bpm_value: float | None = None
    bpm_stability_pct: float | None = None
    try:
        import librosa  # type: ignore
        # Downmix to mono for tempo + chroma. mono is the librosa input.
        if mono.size >= sr:  # need at least 1 s of audio
            # Tempo via beat_track. We use the full default settings.
            try:
                tempo_arr, beats = librosa.beat.beat_track(y=mono.astype(np.float32), sr=sr)
                # librosa >=0.10 returns numpy.ndarray with one element.
                bpm_value = float(tempo_arr) if np.isscalar(tempo_arr) else float(tempo_arr.item())
                if bpm_value <= 0 or not np.isfinite(bpm_value):
                    bpm_value = None
                # Beat-interval stability — coefficient of variation of inter-beat ms.
                if bpm_value is not None and beats is not None and len(beats) >= 4:
                    beat_times = librosa.frames_to_time(beats, sr=sr)
                    iois = np.diff(beat_times)
                    if iois.size > 0 and float(np.mean(iois)) > 0:
                        bpm_stability_pct = float(100.0 * np.std(iois) / np.mean(iois))
            except Exception:
                bpm_value = None
            # Key detection. Two failure modes the previous K-S pipeline hit on
            # trap/hip-hop:
            #   1. Sub-bass at the tonic + its overtones biased the chroma
            #      toward parallel/enharmonic majors (e.g. F-minor 808 read as
            #      Db/C# major because both share 6 of 7 scale tones).
            #   2. Percussion contributed broadband chroma energy that smeared
            #      the tonal profile.
            # Fixes: harmonic-percussive separation first; CQT chroma starting
            # at C2 to skip the 808 fundamental; Albrecht-Shanahan profiles
            # (2013) which empirically outperform K-S on popular music.
            try:
                y_mono = mono.astype(np.float32)
                try:
                    y_harm = librosa.effects.harmonic(y_mono, margin=8.0)
                except Exception:
                    y_harm = y_mono
                fmin = float(librosa.note_to_hz("C2"))
                chroma = librosa.feature.chroma_cqt(
                    y=y_harm, sr=sr, fmin=fmin, n_octaves=5
                )
                chroma_mean = chroma.mean(axis=1)
                # Albrecht & Shanahan (2013) key profiles.
                maj = np.array([0.238, 0.006, 0.111, 0.006, 0.137, 0.094,
                                0.016, 0.214, 0.009, 0.080, 0.008, 0.081])
                minr = np.array([0.220, 0.006, 0.104, 0.123, 0.019, 0.103,
                                 0.012, 0.214, 0.062, 0.022, 0.061, 0.052])
                pcs = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
                # Correlation for each pitch class as tonic, both modes.
                cm = chroma_mean - chroma_mean.mean()
                cm_norm = float(np.linalg.norm(cm)) or 1.0
                scores = []
                for i in range(12):
                    for mode_name, prof in (("major", maj), ("minor", minr)):
                        rotated = np.roll(prof, i)
                        p = rotated - rotated.mean()
                        p_norm = float(np.linalg.norm(p)) or 1.0
                        corr = float(np.dot(cm, p) / (cm_norm * p_norm))
                        scores.append((corr, i, mode_name))
                scores.sort(reverse=True, key=lambda s: s[0])
                best = scores[0]
                second = scores[1]
                key_label = f"{pcs[best[1]]} {best[2]}"
                # Confidence: gap to runner-up, clamped 0..1.
                gap = best[0] - second[0]
                key_confidence = float(max(0.0, min(1.0, 0.5 + gap * 5)))
            except Exception:
                key_label = None
                key_confidence = None
    except ImportError:
        pass

    return {
        "ok": True,
        "error": None,
        "source": "local",
        "sample_rate": sample_rate,
        "bit_depth": bit_depth,
        "integrated_lufs": integrated_lufs,
        "true_peak_db": true_peak_db,
        "loudness_range_lra": loudness_range_lra,
        "clipping_detected": clipping_detected,
        "clipping_sample_count": clipping_sample_count,
        "mono_compatible": bool(mono_compatible),
        "phase_correlation": phase_correlation,
        "stereo_width": stereo_width,
        "crest_factor_db": crest_factor_db,
        "tonal_bands": tonal_bands,
        "dominant_band": dominant_band,
        "mud_ratio": float(mud_ratio),
        "harshness_ratio": float(harshness_ratio),
        "sibilance_ratio": float(sibilance_ratio),
        "key": key_label,
        "key_confidence": key_confidence,
        "bpm": bpm_value,
        "bpm_stability_pct": bpm_stability_pct,
    }


def main() -> None:
    wav_path: Path | None = None
    try:
        wav_path = _record_loopback()
    except Exception as exc:  # noqa: BLE001
        _emit(
            {
                "ok": False,
                "error": f"recording failed: {exc}",
                "trace": traceback.format_exc(),
            }
        )
        return

    # ROEX_DISABLED api_key = os.environ.get("ROEX_API_KEY", "").strip()
    # ROEX_DISABLED if api_key:
    # ROEX_DISABLED     try:
    # ROEX_DISABLED         raw = _roex_analyze(wav_path, api_key)
    # ROEX_DISABLED         payload = {"ok": True, "error": None, **_normalize_roex(raw)}
    # ROEX_DISABLED     except Exception as exc:
    # ROEX_DISABLED         payload = {"ok": True, "error": None, "roex_error": str(exc), **_analyze(wav_path)}
    # ROEX_DISABLED else:
    # ROEX_DISABLED     payload = _analyze(wav_path)

    payload: dict[str, Any]
    try:
        payload = _analyze(wav_path)
    except Exception as exc:  # noqa: BLE001
        payload = {
            "ok": False,
            "error": f"analysis failed: {exc}",
            "trace": traceback.format_exc(),
        }

    persisted_path: str | None = None
    dest_env = os.environ.get("MIXCOACH_LAST_WAV", "").strip()
    if wav_path is not None and dest_env:
        try:
            dest = Path(dest_env)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(wav_path), str(dest))
            persisted_path = str(dest)
        except Exception:
            try:
                wav_path.unlink(missing_ok=True)
            except Exception:
                pass
    elif wav_path is not None:
        try:
            wav_path.unlink(missing_ok=True)
        except Exception:
            pass

    payload["wav_path"] = persisted_path
    _emit(payload)


if __name__ == "__main__":
    main()
