"""Parse the most recently modified FL Studio project file.

Outputs a JSON object on stdout describing the project, mixer tracks,
plugin chain on every insert, and send routing. Never crashes — on any
failure returns a valid JSON envelope with an `error` field and an empty
structure.

Called as a one-shot subprocess by the Electron main process.
"""

from __future__ import annotations

import json
import os
import re
import sys
import traceback
from pathlib import Path
from typing import Any


def _projects_dirs() -> list[Path]:
    """Locations to search for .flp files, in priority order.

    Many users have Documents redirected into OneDrive, so we probe both the
    regular Documents path AND OneDrive\\Documents. The MIXCOACH_FLP_DIR env
    var still wins if set.
    """
    dirs: list[Path] = []
    env_dir = os.environ.get("MIXCOACH_FLP_DIR", "").strip()
    if env_dir:
        dirs.append(Path(env_dir))
    user_home = Path(os.path.expanduser("~"))
    # Plain Documents
    dirs.append(user_home / "Documents" / "Image-Line" / "FL Studio" / "Projects")
    # OneDrive-redirected Documents (very common on Windows 10/11)
    onedrive = os.environ.get("OneDrive", "").strip()
    if onedrive:
        dirs.append(Path(onedrive) / "Documents" / "Image-Line" / "FL Studio" / "Projects")
    dirs.append(user_home / "OneDrive" / "Documents" / "Image-Line" / "FL Studio" / "Projects")
    return dirs


def _newest_flp(roots: list[Path]) -> Path | None:
    candidates: list[Path] = []
    for root in roots:
        if root.exists():
            candidates.extend(root.rglob("*.flp"))
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def _empty_payload(error: str, flp_path: str | None = None) -> dict[str, Any]:
    return {
        "ok": False,
        "error": error,
        "flp_path": flp_path,
        "project": {"name": None, "bpm": None},
        "mixer": [],
        "sends": [],
    }


def _safe_str(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return str(value)
    except Exception:
        return None


def _safe_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _safe_bool(value: Any) -> bool | None:
    if value is None:
        return None
    try:
        return bool(value)
    except Exception:
        return None


def _try_get(obj: Any, attr: str, default: Any = None) -> Any:
    """getattr() that also swallows exceptions raised by pyflp descriptors.

    pyflp's mixer / slot properties read from internal kw dicts that may be
    missing keys depending on the FL Studio version — accessing them raises
    KeyError. We want a clean None instead of a crash.
    """
    try:
        return getattr(obj, attr, default)
    except Exception:
        return default


_WRAPPER_PREFIXES = ("waveshell", "vstshell", "vst3shell")
_WRAPPER_LITERALS = {"wrapper", "fruity wrapper", "(unnamed)", "vstwrapper"}


def _is_wrapper_name(value: Any) -> bool:
    """True when `value` looks like a VST shell/wrapper placeholder rather
    than the actual plugin inside (e.g. 'WaveShell 14.12_x64',
    'Fruity Wrapper'). pyflp specifically documents `Slot.internal_name`
    as always 'Fruity Wrapper' for VST/AU plugins, so we must look past it.
    """
    if not isinstance(value, str):
        return False
    low = value.strip().lower()
    if not low:
        return False
    if any(low.startswith(p) for p in _WRAPPER_PREFIXES):
        return True
    if low in _WRAPPER_LITERALS:
        return True
    return False


def _name_from_path(path: Any) -> str | None:
    """Extract a plugin name from a DLL/VST3 binary path. Returns None when
    the path points at a known shell wrapper (WaveShell etc.) since the
    real plugin name lives elsewhere in that case."""
    if not isinstance(path, str) or not path.strip():
        return None
    try:
        stem = Path(path).stem  # filename without extension
    except Exception:
        return None
    if not stem:
        return None
    # Strip trailing arch suffixes (_x64, _x86, " x64", " 64bit")
    cleaned = stem
    for suf in ("_x64", "_x86", " x64", " x86", " 64bit", " 32bit"):
        if cleaned.lower().endswith(suf):
            cleaned = cleaned[: -len(suf)]
    cleaned = cleaned.strip()
    if not cleaned or _is_wrapper_name(cleaned):
        return None
    return cleaned


_STATE_PLUGIN_NAME_RE = re.compile(
    rb"<PluginName>\s*([^<\r\n]{1,128}?)\s*</PluginName>"
)


def _name_from_state(state: Any) -> str | None:
    """Pull the canonical plugin name out of the wrapper's state blob.

    Waves plugins embed a `<PresetChunkXMLTree>` document inside their
    state with `<PluginName>...</PluginName>` carrying the real name
    (e.g. 'Waves Tune Real-Time') — even when pyflp's `plugin.name` only
    sees the host shell ('WaveShell1-VST3 14.19_x64'). This is the most
    reliable cross-Waves source we have, so it beats the GUID fallback
    every time it's present."""
    if not isinstance(state, (bytes, bytearray)):
        return None
    m = _STATE_PLUGIN_NAME_RE.search(bytes(state))
    if not m:
        return None
    try:
        name = m.group(1).decode("utf-8", errors="replace").strip()
    except Exception:
        return None
    if not name or _is_wrapper_name(name):
        return None
    return name


def _unscramble_guid_bytes(raw: bytes) -> bytes:
    """Undo Windows GUID mixed-endian byte order so the embedded VSTA
    marker and ASCII payload land in the right positions.

    A Windows/COM GUID's first three fields are stored little-endian
    (4+2+2 bytes), and the last 8 bytes are stored as-is. When pyflp
    surfaces the GUID as raw bytes it preserves that layout, so the
    bytes 'V','S','T','A' end up as 'A','T','S','V' on disk. We swap
    each LE group back before pattern-matching against 'VSTA'.
    """
    if len(raw) < 8:
        return raw
    head = bytes(reversed(raw[0:4])) + bytes(reversed(raw[4:6])) + bytes(reversed(raw[6:8]))
    return head + raw[8:]


def _name_from_guid(guid: Any) -> str | None:
    """Decode a VST3 GUID to ASCII when possible. Many vendors (notably
    Waves) encode the plugin's name into the GUID after a 'VSTA' marker
    so a WaveShell-hosted NS1 has GUID bytes 'VSTA' + 'NSMn' + 's1 mono'.
    Returns the cleaned-up ASCII portion, or None for binary GUIDs."""
    if guid is None:
        return None
    raw: bytes
    if isinstance(guid, (bytes, bytearray)):
        raw = bytes(guid)
    elif isinstance(guid, str):
        # Stored as hex string like {56535441-4E53-...} — convert.
        hexstr = "".join(c for c in guid if c in "0123456789abcdefABCDEF")
        if len(hexstr) < 8:
            return None
        try:
            raw = bytes.fromhex(hexstr)
        except ValueError:
            return None
    else:
        return None
    if len(raw) < 4:
        return None
    # Try both orderings: pyflp 2.2 hands back the GUID in Windows
    # mixed-endian layout (so 'VSTA' shows up as 'ATSV'), but older
    # versions / non-Waves vendors may already be flat ASCII. Whichever
    # ordering starts with a 'VST?' marker (Waves uses VSTA, VSTL, VSTW,
    # etc.) wins; fall back to the original bytes for non-VST GUIDs so
    # we don't corrupt them.
    candidates = [_unscramble_guid_bytes(raw), raw]
    body: bytes | None = None
    for cand in candidates:
        if cand[:3] == b"VST" and 32 <= cand[3] < 127:
            body = cand[4:]
            break
    if body is None:
        # No VST? marker either way — treat the original bytes as flat
        # ASCII (e.g. some VST3 GUIDs are plain text).
        body = raw
    chars: list[str] = []
    for b in body:
        if b == 0:
            break
        if 32 <= b < 127:
            chars.append(chr(b))
        else:
            # Hit binary noise — not a name-encoded GUID. Bail.
            return None
    name = "".join(chars).strip()
    if len(name) < 2:
        return None
    if _is_wrapper_name(name):
        return None
    return name


def _resolve_plugin_name(slot: Any, plugin: Any) -> str | None:
    """Recover the real plugin name even when FL has only stored 'Fruity
    Wrapper' / 'WaveShell ...' placeholders. Order:

      1. slot.name             — user-visible slot label (best when set)
      2. plugin.name           — VST factory name (good for non-shelled VSTs)
      3. plugin.plugin_path    — basename of the DLL/VST3 file
      4. plugin.guid           — Waves-style GUID with embedded ASCII name
      5. plugin.vendor + fourcc — fallback identifier so the user can see
                                  what wrapper this is rather than a generic
                                  'Fruity Wrapper'.
    """
    primary = [
        _try_get(slot, "name", None),
        _try_get(plugin, "name", None),
    ]
    for c in primary:
        if isinstance(c, str) and c.strip() and not _is_wrapper_name(c):
            return c.strip()

    # Waves wrappers (and some others) carry the real plugin name as
    # `<PluginName>` inside their state blob. Check that before falling
    # back to DLL paths / GUID decoding, which can only give truncated
    # or fourcc-prefixed approximations.
    from_state = _name_from_state(_try_get(plugin, "state", None))
    if from_state:
        return from_state

    from_path = _name_from_path(_try_get(plugin, "plugin_path", None))
    if from_path:
        return from_path

    from_guid = _name_from_guid(_try_get(plugin, "guid", None))
    if from_guid:
        return from_guid

    vendor = _try_get(plugin, "vendor", None)
    fourcc = _try_get(plugin, "fourcc", None)
    # pyflp also surfaces fourcc via the VST chunk as a clean ASCII string;
    # combine it with the vendor when both are present (e.g. "Waves [NSSn]").
    if isinstance(vendor, str) and vendor.strip():
        if isinstance(fourcc, str) and fourcc.strip():
            return f"{vendor.strip()} [{fourcc.strip()}]"
        return f"{vendor.strip()} (unidentified)"
    if isinstance(fourcc, str) and fourcc.strip():
        return f"VST [{fourcc.strip()}]"

    # Last resort — surface whatever we have rather than dropping the slot.
    for c in (
        _try_get(slot, "name", None),
        _try_get(slot, "internal_name", None),
        _try_get(plugin, "name", None),
    ):
        if isinstance(c, str) and c.strip():
            return c.strip()
    return None


# pyflp's _MixerParamsID values for per-slot params; SlotEnabled=0, SlotMix=1.
# We read them directly because pyflp 2.2.1's `Slot.mix` / `Slot.enabled`
# descriptors are broken — they call `._kw["params"].own.items()` but at the
# Slot level `_kw["params"]` is a plain `dict[int, dict[str, Any]]`, not an
# `_InsertItems` instance with an `.own` attribute, so attribute access blows
# up with AttributeError. Reading from `_kw["params"]` directly skips the bug.
_SLOT_PARAM_ENABLED = 0
_SLOT_PARAM_MIX = 1


def _slot_param_msg(slot: Any, param_id: int) -> Any:
    try:
        params = getattr(slot, "_kw", {}).get("params")
    except Exception:
        return None
    if not isinstance(params, dict):
        return None
    item = params.get(param_id)
    if not isinstance(item, dict):
        return None
    return item.get("msg")


def _slot_mix_pct(slot: Any) -> float | None:
    """Normalize FL's slot mix knob to 0–100 %. The raw value is the
    SlotMix mixer-param message — historically a 0..12800 fixed-point int
    where 12800 = 100% wet (default). Return None if unavailable."""
    raw = _slot_param_msg(slot, _SLOT_PARAM_MIX)
    if raw is None:
        return None
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return None
    if n > 1.5:
        return max(0.0, min(100.0, (n / 12800.0) * 100.0))
    return max(0.0, min(100.0, n * 100.0))


def _slot_enabled(slot: Any) -> bool | None:
    raw = _slot_param_msg(slot, _SLOT_PARAM_ENABLED)
    if raw is None:
        return None
    try:
        return bool(int(raw))
    except (TypeError, ValueError):
        return None


def _extract_plugins(insert: Any) -> list[dict[str, Any]]:
    plugins: list[dict[str, Any]] = []
    # pyflp 2.2: Insert is iterable -> yields Slot objects (no .slots attr).
    try:
        slots_iter = list(insert)
    except Exception:
        return plugins
    for slot in slots_iter:
        plugin = _try_get(slot, "plugin", None)
        if plugin is None:
            continue
        slot_idx = _try_get(slot, "index", None)
        if slot_idx is None:
            slot_idx = len(plugins)
        name = _resolve_plugin_name(slot, plugin)
        if not name:
            continue
        enabled = _slot_enabled(slot)
        if enabled is None:
            # Fall back to the broken descriptor (yields None) → treat as enabled
            # so we don't accidentally hide every plugin when pyflp can't tell.
            enabled = _safe_bool(_try_get(slot, "enabled", True))
        plugins.append(
            {
                "slot": int(slot_idx) if isinstance(slot_idx, (int, float)) else slot_idx,
                "name": _safe_str(name),
                "enabled": enabled,
                "mix": _slot_mix_pct(slot),
            }
        )
    return plugins


def _extract_mixer(project: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    mixer = _try_get(project, "mixer", None)
    if mixer is None:
        return [], []

    inserts: list[dict[str, Any]] = []
    sends: list[dict[str, Any]] = []
    try:
        insert_iter = _try_get(mixer, "inserts", None) or list(mixer)
    except Exception:
        return [], []

    for idx, insert in enumerate(insert_iter):
        name = _try_get(insert, "name", None) or f"Insert {idx}"
        volume = _safe_float(_try_get(insert, "volume", None))
        pan = _safe_float(_try_get(insert, "pan", None))
        enabled = _try_get(insert, "enabled", True)
        muted = _safe_bool(not enabled) if enabled is not None else None

        inserts.append(
            {
                "index": idx,
                "name": _safe_str(name),
                "volume": volume,
                "pan": pan,
                "muted": muted,
                "plugins": _extract_plugins(insert),
            }
        )

        routes = _try_get(insert, "routes", None) or _try_get(insert, "sends", None) or []
        try:
            routes_iter = list(routes)
        except Exception:
            routes_iter = []
        for r in routes_iter:
            dest = (
                _try_get(r, "destination", None)
                or _try_get(r, "dest", None)
                or _try_get(r, "target", None)
            )
            if dest is None:
                continue
            try:
                dest_idx = int(dest)
            except (TypeError, ValueError):
                dest_idx = _try_get(dest, "index", None)
            if dest_idx is None:
                continue
            sends.append(
                {
                    "from": idx,
                    "to": int(dest_idx),
                    "volume": _safe_float(_try_get(r, "volume", None)),
                }
            )

    return inserts, sends


def _patch_pyflp_for_py312() -> None:
    """pyflp 2.2.1's EventEnum is intentionally empty and relies on
    `EventEnum(value)` falling through to `_missing_` to materialise
    pseudo-members. Python 3.12+ rejects calls on empty enums with a
    TypeError before `_missing_` ever runs. Injecting one sentinel
    member into `_member_map_` flips the enum from "empty" to "value
    lookup" mode without changing any semantics that pyflp relies on.
    """
    try:
        from pyflp._events import EventEnum  # type: ignore[attr-defined]
    except Exception:
        return
    if EventEnum._member_map_:
        return
    sentinel = int.__new__(EventEnum, -1)
    sentinel._name_ = "_PY312_BOOTSTRAP"
    sentinel._value_ = -1
    EventEnum._member_map_["_PY312_BOOTSTRAP"] = sentinel
    EventEnum._value2member_map_[-1] = sentinel
    EventEnum._member_names_.append("_PY312_BOOTSTRAP")


def parse(flp_path: Path) -> dict[str, Any]:
    try:
        import pyflp  # type: ignore
    except ImportError as exc:
        return _empty_payload(f"pyflp not installed: {exc}", str(flp_path))

    _patch_pyflp_for_py312()

    import warnings

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            project = pyflp.parse(str(flp_path))
    except Exception as exc:  # noqa: BLE001
        return _empty_payload(f"pyflp.parse failed: {exc}", str(flp_path))

    try:
        name = (
            _try_get(project, "title", None)
            or _try_get(project, "name", None)
            or flp_path.stem
        )
        bpm = _safe_float(_try_get(project, "tempo", None))
        mixer, sends = _extract_mixer(project)

        return {
            "ok": True,
            "error": None,
            "flp_path": str(flp_path),
            "project": {"name": _safe_str(name), "bpm": bpm},
            "mixer": mixer,
            "sends": sends,
        }
    except Exception as exc:  # noqa: BLE001
        return _empty_payload(
            f"extraction failed: {exc}\n{traceback.format_exc()}", str(flp_path)
        )


def main() -> None:
    try:
        flp = _newest_flp(_projects_dirs())
        if flp is None:
            searched = [str(p) for p in _projects_dirs()]
            print(
                json.dumps(
                    _empty_payload(f"no .flp file found in: {searched}")
                )
            )
            return
        print(json.dumps(parse(flp)))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps(_empty_payload(f"unexpected: {exc}")))


if __name__ == "__main__":
    main()
    sys.stdout.flush()
