# MixCoach

AI mixing coach that sits beside FL Studio. Press **Ctrl+Shift+M** and MixCoach
captures your screen, the latest `.flp` project, and 15 seconds of system
audio, then asks a veteran mixing engineer (Google Gemini, with RoEx Tonn for
audio analysis) what to fix.

## Stack

- **Electron + electron-vite + TypeScript** — desktop shell
- **Vanilla HTML/CSS/JS renderer** — frameless always-on-top overlay (480x700)
- **Python 3.12** — one-shot subprocess scripts for FLP parsing and audio analysis
- **RoEx Tonn API** — professional mix analysis (local pyloudnorm/librosa fallback)
- **Google Gemini 1.5 Pro** — coaching feedback

## Layout

```
mixcoach/
├─ src/
│  ├─ main/
│  │  ├─ index.ts        Electron main, global hotkey, window management
│  │  ├─ pipeline.ts     Orchestrates screenshot + FLP + audio in parallel
│  │  ├─ gemini.ts       YOUR_GEAR config, Gemini API call
│  │  └─ screenshot.ts   PowerShell screen capture
│  ├─ preload/index.ts   IPC bridge (window.mc)
│  └─ renderer/
│     ├─ index.html
│     ├─ styles.css
│     └─ app.js
├─ python/
│  ├─ parse_flp.py             pyflp project parser
│  └─ capture_and_analyze.py   WASAPI loopback + RoEx / local analysis
├─ prompts/
│  └─ system.md          Veteran engineer system prompt with placeholders
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ .env.example
└─ package.json
```

## Setup

```powershell
# 1. Install Node dependencies
npm install

# 2. Create a Python virtualenv and install audio libs
python -m venv python\.venv
python\.venv\Scripts\Activate.ps1
pip install roex-python soundcard pyloudnorm librosa soundfile numpy pyflp

# 3. Configure API keys
copy .env.example .env
# then edit .env and fill in GEMINI_API_KEY (required) and ROEX_API_KEY (optional)
```

Point MixCoach at your venv interpreter (optional but recommended):

```powershell
# In .env:
MIXCOACH_PYTHON=C:\Users\your7\Documents\mixcoach\python\.venv\Scripts\python.exe
```

## Run

```powershell
npm run dev
```

The window appears in the top-right of your primary display. Switch to
FL Studio, hit **Ctrl+Shift+M**, and the overlay pops up showing live status
(recording countdown → RoEx → FLP → Gemini) before rendering the feedback.

## Editing your gear

The producer profile injected into the system prompt lives at the top of
`src/main/gemini.ts` in the `YOUR_GEAR` block — monitors, interface, genre,
skill level, plugins owned. Edit there, restart dev, done.

## Build

```powershell
npm run build:win    # NSIS installer
```

Python scripts and prompts are packaged via `extraResources` in
`electron-builder.yml`. End users still need Python 3.12 with the listed pip
packages on PATH, or set `MIXCOACH_PYTHON` to a specific interpreter.

## Pipeline timing

Audio recording is the long pole (15s). Screenshot and FLP parsing run in
parallel during those 15 seconds, so total pipeline time is roughly
`15s + Gemini latency`, not `15s + everything else`.

## Notes

- The hotkey works even when FL Studio has focus (registered via
  Electron `globalShortcut`).
- Save your `.flp` in FL Studio **before** pressing the hotkey — the parser
  reads the most recently modified file on disk.
- If RoEx fails or no `ROEX_API_KEY` is set, the script falls back to local
  pyloudnorm + librosa analysis (LUFS, true peak, crest, stereo width,
  frequency-band RMS, mud/harshness/sibilance ratios). The Gemini prompt
  works with either source.
- Closing the window with `×` hides it; the next Ctrl+Shift+M brings it back.
