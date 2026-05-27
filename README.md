# MixCoach

Electron + React (TypeScript) desktop app with a Python sidecar process.

## Stack

- **Electron + electron-vite** — desktop shell
- **React 18 + Vite + TypeScript** — renderer UI
- **Python 3.11** — sidecar process spawned by Electron main, talks over stdio (newline-delimited JSON)

## Layout

```
mixcoach/
├─ src/
│  ├─ main/              Electron main process (TS)
│  │  ├─ index.ts        BrowserWindow + lifecycle
│  │  └─ python.ts       Python sidecar spawn + stdio JSON-RPC
│  ├─ preload/           Context-isolated IPC bridge
│  └─ renderer/          React UI (Vite)
├─ python/
│  ├─ main.py            Sidecar entry (stdin loop)
│  ├─ requirements.txt
│  └─ src/mixcoach/      Python package
├─ electron.vite.config.ts
├─ electron-builder.yml
└─ package.json
```

## Setup

```powershell
npm install
python -m venv python\.venv
python\.venv\Scripts\Activate.ps1
pip install -r python\requirements.txt
```

## Dev

```powershell
npm run dev
```

This starts Vite for the renderer, builds main + preload, and launches Electron.
The main process spawns `python python/main.py` as a sidecar; click "Ping Python"
in the UI to verify the IPC round-trip.

## Build

```powershell
npm run build:win    # NSIS installer
npm run build:mac    # DMG (run on macOS)
npm run build:linux  # AppImage
```

The Python folder is packaged via `extraResources` in `electron-builder.yml`.
Bundling a Python runtime for distribution is a separate problem — for now
end users need Python 3.11 on PATH, or set `MIXCOACH_PYTHON` to a specific interpreter.
