import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { captureScreenshot, Screenshot } from './screenshot'
import {
  callGemini,
  FlpData,
  AudioData,
  extractVocalChain,
  VOCAL_CHAIN_BUSES,
  ChatContext
} from './gemini'
import { buildSuggestions, buildVocalVerdict, Suggestion, Mode, VocalVerdict } from './suggestions'
import {
  getReference,
  compareToReference,
  ReferenceAudio,
  Comparison
} from './reference'

type ChainStep = ReturnType<typeof extractVocalChain>[number]

export function lastWavPath(): string {
  return join(app.getPath('userData'), 'last_capture.wav')
}

// Cached after each pipeline run so the chat handler can ground replies
// in the exact same data the producer is looking at on screen.
let lastChatContext: ChatContext | null = null

export function getLastChatContext(): ChatContext | null {
  return lastChatContext
}

export function setChatMode(mode: Mode): void {
  // Allow the renderer to update the mode for in-flight chats even when
  // no analysis has run yet (so chat questions don't crash and stay
  // scoped correctly when the user toggles the mode between runs).
  if (lastChatContext) {
    lastChatContext = { ...lastChatContext, mode }
  } else {
    lastChatContext = {
      flp: null,
      audio: null,
      suggestions: [],
      analysisText: null,
      mode,
      vocalVerdict: null,
      reference: null,
      comparison: null
    }
  }
}

export type Status =
  | { phase: 'screenshot'; seconds_remaining: number }
  | { phase: 'recording'; seconds_remaining: number }
  | { phase: 'analyzing' }
  // ROEX_DISABLED — was `'roex'` while waiting on the cloud API.
  | { phase: 'flp' }
  | { phase: 'gemini' }
  | { phase: 'done' }
  | { phase: 'busy' }

export type PipelineResult = {
  ok: true
  text: string
  timestamp: string
  audio: AudioData | null
  suggestions: Suggestion[]
  audioSource: AudioData['source'] | null
  flpOk: boolean
  screenshotOk: boolean
  wavPath: string | null
  vocalChain: ChainStep[]
  vocalChainBuses: number[]
  mode: Mode
  vocalVerdict: VocalVerdict | null
  reference: ReferenceAudio | null
  comparison: Comparison | null
}

export function pythonExecutable(): string {
  return (
    process.env.MIXCOACH_PYTHON ??
    (process.platform === 'win32' ? 'python' : 'python3')
  )
}

export function pythonRoot(): string {
  return is.dev
    ? join(app.getAppPath(), 'python')
    : join(process.resourcesPath, 'python')
}

export class CancelledError extends Error {
  readonly cancelled = true
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

function runPython<T>(
  script: string,
  extraEnv: Record<string, string> = {},
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError())
    const proc = spawn(pythonExecutable(), [script], {
      cwd: pythonRoot(),
      env: { ...process.env, PYTHONUNBUFFERED: '1', ...extraEnv },
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let cancelled = false
    const onAbort = (): void => {
      cancelled = true
      try {
        proc.kill()
      } catch {
        // ignore
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    proc.stdout.on('data', (b) => (stdout += b.toString()))
    proc.stderr.on('data', (b) => (stderr += b.toString()))
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      if (cancelled) return reject(new CancelledError())
      reject(err)
    })
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (cancelled) return reject(new CancelledError())
      if (code !== 0) {
        return reject(
          new Error(`${script} exited ${code}: ${stderr.trim() || stdout.trim()}`)
        )
      }
      const firstBrace = stdout.indexOf('{')
      const lastBrace = stdout.lastIndexOf('}')
      if (firstBrace === -1 || lastBrace === -1) {
        return reject(new Error(`${script} produced no JSON: ${stdout}`))
      }
      try {
        resolve(JSON.parse(stdout.slice(firstBrace, lastBrace + 1)) as T)
      } catch (err) {
        reject(new Error(`${script} JSON parse failed: ${(err as Error).message}`))
      }
    })
  })
}

function runWithStatus<T>(
  script: string,
  startStatus: Status,
  onStatus: (s: Status) => void,
  extraEnv: Record<string, string> = {},
  signal?: AbortSignal
): Promise<T> {
  onStatus(startStatus)
  return runPython<T>(script, extraEnv, signal)
}

function isCancel(err: unknown): boolean {
  return (
    err instanceof CancelledError ||
    (typeof err === 'object' && err !== null && (err as { cancelled?: boolean }).cancelled === true)
  )
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError())
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new CancelledError())
      },
      { once: true }
    )
  })
}

export async function runPipeline(
  onStatus: (s: Status) => void,
  signal?: AbortSignal,
  mode: Mode = 'both'
): Promise<PipelineResult> {
  // 5-second screenshot prep countdown — gives the producer time to bring
  // FL Studio to the front and queue up the moment they want captured before
  // audio recording / screenshotting fire.
  for (let s = 5; s >= 1; s--) {
    if (signal?.aborted) throw new CancelledError()
    onStatus({ phase: 'screenshot', seconds_remaining: s })
    await abortableDelay(1000, signal)
  }

  // Audio capture is the long pole (15s). Start it first.
  onStatus({ phase: 'recording', seconds_remaining: 15 })
  const wavDest = lastWavPath()
  const audioPromise = runPython<AudioData>(
    'capture_and_analyze.py',
    { MIXCOACH_LAST_WAV: wavDest },
    signal
  ).catch((err): AudioData => {
    if (isCancel(err)) throw err
    return { ok: false, error: (err as Error).message, source: 'local' }
  })

  // Countdown ticker: when the 15s window elapses, flip the phase to
  // 'analyzing' so the UI shows the (brief) local DSP stage.
  let secondsLeft = 14
  const countdown = setInterval(() => {
    if (secondsLeft > 0) {
      onStatus({ phase: 'recording', seconds_remaining: secondsLeft })
      secondsLeft -= 1
    } else {
      onStatus({ phase: 'analyzing' })
    }
  }, 1000)

  const screenshotPromise: Promise<Screenshot> = captureScreenshot().catch(
    (err) =>
      ({
        ok: false,
        base64: null,
        mimeType: 'image/png',
        error: (err as Error).message
      }) as Screenshot
  )

  const flpPromise = runWithStatus<FlpData>(
    'parse_flp.py',
    { phase: 'flp' },
    onStatus,
    {},
    signal
  ).catch((err): FlpData => {
    if (isCancel(err)) throw err
    return {
      ok: false,
      error: (err as Error).message,
      project: { name: null, bpm: null },
      mixer: [],
      sends: []
    }
  })

  let screenshot: Screenshot
  let flp: FlpData
  let audio: AudioData
  try {
    ;[screenshot, flp, audio] = await Promise.all([
      screenshotPromise,
      flpPromise,
      audioPromise
    ])
  } finally {
    clearInterval(countdown)
  }
  if (signal?.aborted) throw new CancelledError()

  const suggestions = buildSuggestions(audio.ok ? audio : null, mode)
  const vocalVerdict = buildVocalVerdict(audio.ok ? audio : null, mode)
  const reference = getReference()
  const comparison = compareToReference(audio.ok ? audio : null, reference)

  onStatus({ phase: 'gemini' })
  const text = await callGemini({
    screenshot,
    flp,
    audio,
    suggestions,
    mode,
    vocalVerdict,
    reference,
    comparison,
    signal
  })

  onStatus({ phase: 'done' })

  lastChatContext = {
    flp: flp.ok ? flp : null,
    audio: audio.ok ? audio : null,
    suggestions,
    analysisText: text,
    mode,
    vocalVerdict,
    reference,
    comparison
  }

  return {
    ok: true,
    text,
    timestamp: new Date().toISOString(),
    audio,
    suggestions,
    audioSource: audio.source ?? null,
    flpOk: !!flp.ok,
    screenshotOk: !!screenshot.ok,
    wavPath: audio.ok && typeof audio.wav_path === 'string' ? audio.wav_path : null,
    vocalChain: extractVocalChain(flp),
    vocalChainBuses: [...VOCAL_CHAIN_BUSES],
    mode,
    vocalVerdict,
    reference,
    comparison
  }
}
