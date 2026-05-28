"""Scan the local FL Studio plugin database and emit a deduped list of
installed effect plugins.

Looks at `Presets\\Plugin database\\Installed\\Effects\\{Fruity,VST,VST3}`
and collapses VST2/VST3, Mono/Stereo, and surround variants down to one
canonical name per plugin.

Run with no args to print JSON to stdout. Pipe into your editor when
updating YOUR_GEAR.plugins_owned in src/main/gemini.ts.

Usage:
    python python/scan_plugins.py                      # default OneDrive + Docs
    python python/scan_plugins.py "C:/custom/path"     # explicit root
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path


SUFFIXES = [
    r"\s+Mono-Stereo$",
    r"\s+Stereo-Mono$",
    r"\s+Mono-5\.\d$",
    r"\s+Stereo-5\.\d$",
    r"\s+5\.\d$",
    r"\s+Mono$",
    r"\s+Stereo$",
    r"\s+\(Mono\)$",
    r"\s+\(Stereo\)$",
    r"\s+long$",
    r"_2$",
    r"_3$",
    r"_\d+$",
    r"\s*\((?:VST3?|x64|x86)\)\s*$",
    r"_x64$",
    r"_x86$",
]

DROP = re.compile(
    r"^("
    r"Fruity Wrapper|WaveShell.*|"
    r"EffectRack|Control Surface|Patcher|StudioRack|Waves StudioRack for OBS|"
    r"Edison|Newtone|Newtime|Melodyne|Wave Candy|Tuner|"
    r"Razer Chroma|ZGameEditor Visualizer|"
    r"VFX [A-Za-z ]+|"
    r"Fruity (?:NoteBook ?2?|HTML NoteBook|Big Clock|Mute 2|Phase Inverter|"
    r"Center|Balance|Send|LSD|Formula Controller|Peak Controller|"
    r"X-Y Controller|X-Y-Z Controller|Spectroman|dB Meter|Scratcher)|"
    r"kHs Tape Stop|kHs Trance Gate|kHs Reverser|kHs Phase Distortion|kHs|"
    r"X-Click|X-Crackle|Sibilance-Live|Silk Vocal Live|Vocal Rider Live"
    r")$",
    re.I,
)


def _canonical(stem: str) -> str:
    s = stem.strip()
    changed = True
    while changed:
        changed = False
        for pat in SUFFIXES:
            new = re.sub(pat, "", s, flags=re.I)
            if new != s:
                s = new.strip()
                changed = True
    return s


def _dedup_key(name: str) -> str:
    n = name.lower()
    for prefix in ("fabfilter ", "waves "):
        if n.startswith(prefix):
            n = n[len(prefix):]
    return re.sub(r"[^a-z0-9]+", "", n)


def _candidate_roots() -> list[Path]:
    if len(sys.argv) > 1:
        return [Path(sys.argv[1])]
    home = Path(os.path.expanduser("~"))
    roots: list[Path] = []
    onedrive = os.environ.get("OneDrive", "").strip()
    if onedrive:
        roots.append(
            Path(onedrive)
            / "Documents"
            / "Image-Line"
            / "FL Studio"
            / "Presets"
            / "Plugin database"
            / "Installed"
            / "Effects"
        )
    roots.extend(
        [
            home
            / "OneDrive"
            / "Documents"
            / "Image-Line"
            / "FL Studio"
            / "Presets"
            / "Plugin database"
            / "Installed"
            / "Effects",
            home
            / "Documents"
            / "Image-Line"
            / "FL Studio"
            / "Presets"
            / "Plugin database"
            / "Installed"
            / "Effects",
        ]
    )
    return roots


def scan(root: Path) -> list[str]:
    if not root.exists():
        return []
    found: dict[str, str] = {}
    for sub in ("Fruity", "VST", "VST3"):
        d = root / sub
        if not d.exists():
            continue
        for fst in d.rglob("*.fst"):
            c = _canonical(fst.stem)
            if not c or DROP.match(c):
                continue
            k = _dedup_key(c)
            if not k:
                continue
            if k not in found or len(c) < len(found[k]):
                found[k] = c
    return sorted(set(found.values()), key=lambda s: s.lower())


def main() -> None:
    roots = _candidate_roots()
    chosen: Path | None = next((r for r in roots if r.exists()), None)
    if chosen is None:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "no plugin database directory found",
                    "searched": [str(r) for r in roots],
                }
            )
        )
        return
    names = scan(chosen)
    print(json.dumps({"ok": True, "root": str(chosen), "count": len(names), "plugins": names}, indent=2))


if __name__ == "__main__":
    main()
