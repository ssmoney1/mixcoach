import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, shell } from 'electron'
import { config as loadEnv } from 'dotenv'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { electronApp, is } from '@electron-toolkit/utils'
import {
  runPipeline,
  Status,
  lastWavPath,
  pythonExecutable,
  pythonRoot,
  CancelledError,
  getLastChatContext,
  setChatMode
} from './pipeline'
import { callGeminiChat, ChatMessage } from './gemini'
import type { Mode } from './suggestions'
import { setReferenceFromFile, getReference, clearReference } from './reference'

function asMode(value: unknown): Mode {
  return value === 'vocal' || value === 'beat' ? value : 'both'
}

loadEnv({ path: join(app.getAppPath(), '.env') })

const HOTKEY = 'CommandOrControl+Alt+M'
const WIN_WIDTH = 1280
const WIN_HEIGHT = 800

let mainWindow: BrowserWindow | null = null
let pipelineRunning = false
let quitting = false
let activeAbort: AbortController | null = null
let meterProc: ChildProcessWithoutNullStreams | null = null
let meterBuf = ''

function startMeter(): void {
  if (meterProc || !mainWindow || mainWindow.isDestroyed()) return
  try {
    meterProc = spawn(pythonExecutable(), ['meter.py'], {
      cwd: pythonRoot(),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      windowsHide: true
    })
  } catch (err) {
    emit('mc:meter', { error: (err as Error).message })
    meterProc = null
    return
  }
  meterBuf = ''
  meterProc.stdout.on('data', (b: Buffer) => {
    meterBuf += b.toString()
    let nl = meterBuf.indexOf('\n')
    while (nl !== -1) {
      const line = meterBuf.slice(0, nl).trim()
      meterBuf = meterBuf.slice(nl + 1)
      if (line) {
        try {
          emit('mc:meter', JSON.parse(line))
        } catch {
          // drop malformed line
        }
      }
      nl = meterBuf.indexOf('\n')
    }
  })
  meterProc.on('close', () => {
    meterProc = null
  })
  meterProc.on('error', (err) => {
    emit('mc:meter', { error: err.message })
    meterProc = null
  })
}

function stopMeter(): void {
  if (!meterProc) return
  try {
    meterProc.stdin.end()
  } catch {
    // ignore
  }
  try {
    meterProc.kill()
  } catch {
    // ignore
  }
  meterProc = null
}

function createWindow(): void {
  const display = screen.getPrimaryDisplay()
  const { workArea } = display
  // Center the dashboard window on the primary display rather than
  // hugging the top-right corner — at 1280×800 it's no longer an overlay.
  const x = Math.max(workArea.x, Math.round(workArea.x + (workArea.width - WIN_WIDTH) / 2))
  const y = Math.max(workArea.y, Math.round(workArea.y + (workArea.height - WIN_HEIGHT) / 2))

  mainWindow = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    minWidth: 1000,
    minHeight: 640,
    x,
    y,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: false,
    backgroundColor: '#0e0e0e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.setAlwaysOnTop(true, 'screen-saver')

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    startMeter()
  })
  mainWindow.on('show', () => startMeter())
  mainWindow.on('hide', () => stopMeter())
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function emit(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

async function trigger(mode: Mode = 'both'): Promise<void> {
  if (pipelineRunning) {
    emit('mc:status', { phase: 'busy' })
    showWindow()
    return
  }
  pipelineRunning = true
  showWindow()
  // Meter keeps running during capture — WASAPI shared-mode loopback
  // supports multiple consumers, so the meter and the 15s recorder can
  // tap the same device simultaneously.
  const controller = new AbortController()
  activeAbort = controller
  emit('mc:start', { startedAt: new Date().toISOString(), mode })

  try {
    const result = await runPipeline(
      (s: Status) => emit('mc:status', s),
      controller.signal,
      mode
    )
    emit('mc:result', result)
  } catch (err) {
    if (err instanceof CancelledError || (err as { name?: string })?.name === 'AbortError') {
      emit('mc:cancelled', { at: new Date().toISOString() })
    } else {
      // Surface the failure in the dev terminal — otherwise a Gemini error
      // (quota, bad key, timeout) only reaches the renderer and is easy to
      // miss while debugging a "stuck" UI.
      console.error('[mixcoach] pipeline error:', (err as Error).message)
      emit('mc:error', { message: (err as Error).message })
    }
  } finally {
    activeAbort = null
    pipelineRunning = false
  }
}

function cancel(): boolean {
  if (!activeAbort) return false
  activeAbort.abort()
  return true
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

app.on('second-instance', () => {
  showWindow()
  void trigger('both')
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.mixcoach.app')

  ipcMain.handle('mc:trigger', (_e, mode?: unknown) => trigger(asMode(mode)))
  ipcMain.handle('mc:setMode', (_e, mode?: unknown) => {
    setChatMode(asMode(mode))
    return true
  })
  ipcMain.handle('mc:cancel', () => cancel())
  ipcMain.handle('mc:hide', () => mainWindow?.hide())
  ipcMain.handle('mc:minimize', () => mainWindow?.minimize())
  ipcMain.handle('mc:quit', () => {
    quitting = true
    app.quit()
  })
  ipcMain.handle('mc:lastWav', async () => {
    try {
      const buf = await readFile(lastWavPath())
      // Return ArrayBuffer slice so the renderer can wrap it in a Blob
      // without copying through Node Buffer semantics.
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    } catch {
      return null
    }
  })
  ipcMain.handle('mc:pickReference', async (_e, startSec?: unknown) => {
    if (!mainWindow) return { ok: false, error: 'window not ready' }
    // Raw start-time string from the UI (`90` or `1:30`). Python parses and
    // clamps it; empty → 50% into the file.
    const start =
      typeof startSec === 'string'
        ? startSec
        : typeof startSec === 'number'
          ? String(startSec)
          : undefined
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose reference track',
      buttonLabel: 'Use as reference',
      properties: ['openFile'],
      filters: [
        {
          name: 'Audio',
          extensions: ['wav', 'flac', 'aiff', 'aif', 'mp3', 'm4a', 'ogg', 'opus']
        }
      ]
    })
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, cancelled: true }
    }
    try {
      const ref = await setReferenceFromFile(result.filePaths[0], start)
      return { ok: true, reference: ref }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  // Live plugin EQ scan (for the Plugins tab) — dynamic import so the native
  // MIDI module is only touched on demand and failures stay contained.
  ipcMain.handle('mc:scanPlugins', async () => {
    try {
      const mod = await import('./flplugins')
      return await mod.scanPluginEq({ perCommandTimeoutMs: 4000 })
    } catch (err) {
      return { available: false, states: [], error: (err as Error).message }
    }
  })
  // Phase 5 WRITE — apply one Pro-Q 3 change. Only invoked when the user
  // clicks Apply in the UI; never automatic.
  ipcMain.handle('mc:applyProQ3', async (_e, op: unknown) => {
    try {
      const mod = await import('./flplugins')
      return await mod.applyProQ3Op(op as Parameters<typeof mod.applyProQ3Op>[0])
    } catch (err) {
      return { ok: false, op, applied: [], error: (err as Error).message }
    }
  })
  ipcMain.handle('mc:getReference', () => getReference())
  ipcMain.handle('mc:clearReference', () => {
    clearReference()
    return true
  })
  ipcMain.handle('mc:chat', async (_e, messages: ChatMessage[]) => {
    if (!Array.isArray(messages) || !messages.length) {
      throw new Error('No chat messages provided')
    }
    const context = getLastChatContext() ?? {
      flp: null,
      audio: null,
      suggestions: [],
      analysisText: null,
      mode: 'both' as const,
      vocalVerdict: null,
      reference: getReference(),
      comparison: null,
      mixWavPath: null,
      referenceClipPath: getReference()?.clipPath ?? null,
      pluginEqText: null
    }
    return await callGeminiChat({ messages, context })
  })

  createWindow()

  const registered = globalShortcut.register(HOTKEY, () => {
    // Global hotkey can't read renderer state — default to 'both'. The
    // in-window Analyze button still passes the user's selected mode.
    void trigger('both')
  })
  if (!registered) {
    console.error(`Failed to register global shortcut ${HOTKEY}`)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopMeter()
  // Release the FL MIDI bridge ports if it was ever opened. Dynamic import so
  // the native module is only touched if flplugins was actually loaded.
  import('./flplugins')
    .then((m) => m.closeFlBridge())
    .catch(() => {
      /* bridge never loaded — nothing to close */
    })
})

app.on('window-all-closed', () => {
  // Keep app running in background — it's hotkey-driven. Quit explicitly via
  // tray / menu / mc:quit IPC if needed.
  if (process.platform !== 'darwin' && quitting) app.quit()
})

app.on('before-quit', () => {
  quitting = true
})
