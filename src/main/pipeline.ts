import { spawn } from 'node:child_process'
import { join, basename } from 'node:path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
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
// Type-only import — erased at runtime, so the native @julusian/midi binary is
// NOT loaded by importing this type. The actual scan module is loaded lazily
// via dynamic import in scanFlPluginsSafe().
import type { PluginEqState } from './flplugins'

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
      comparison: null,
      mixWavPath: null,
      referenceClipPath: null,
      pluginEqText: null
    }
  }
}

export type Status =
  | { phase: 'countdown'; seconds_remaining: number }
  | { phase: 'recording'; seconds_remaining: number }
  | { phase: 'analyzing' }
  // ROEX_DISABLED — was `'roex'` while waiting on the cloud API.
  | { phase: 'flp' }
  // `retry` is present only while waiting out a transient Gemini error
  // (e.g. a 503 "spike in usage"), so the UI can show a countdown instead
  // of a frozen "Generating analysis…" spinner.
  | { phase: 'gemini'; retry?: { attempt: number; maxAttempts: number; status: number; waitMs: number } }
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
  flpName: string | null
  flpPath: string | null
  wavPath: string | null
  vocalChain: ChainStep[]
  vocalChainBuses: number[]
  mode: Mode
  vocalVerdict: VocalVerdict | null
  reference: ReferenceAudio | null
  comparison: Comparison | null
  // Live plugin EQ read from FL over MIDI (Phase 4). Empty when the FL bridge
  // is offline or no supported plugin was found.
  flPluginEq: PluginEqState[]
  flBridgeAvailable: boolean
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

// Read live plugin EQ from FL over MIDI, fully isolated and bounded. The
// flplugins module (and its native @julusian/midi dependency) is loaded only
// here, via dynamic import, so a missing/broken binary or an offline bridge
// can never crash or stall the pipeline — it just returns no EQ data.
async function scanFlPluginsSafe(): Promise<{
  text: string | null
  states: PluginEqState[]
  available: boolean
}> {
  const empty = { text: null, states: [] as PluginEqState[], available: false }
  try {
    const mod = await import('./flplugins')
    const result = await Promise.race([
      mod.scanPluginEq({ perCommandTimeoutMs: 4000 }),
      new Promise<{ available: boolean; states: PluginEqState[] }>((resolve) =>
        // Hard ceiling so plugin reading never delays Gemini past the audio
        // window, even if FL responds to some commands but stalls on others.
        setTimeout(() => resolve({ available: false, states: [] }), 12000)
      )
    ])
    return {
      text: mod.buildPluginEqPromptText(result.states),
      states: result.states,
      available: result.available
    }
  } catch (err) {
    console.error('[flplugins] scan unavailable:', (err as Error).message)
    return empty
  }
}

export async function runPipeline(
  onStatus: (s: Status) => void,
  signal?: AbortSignal,
  mode: Mode = 'both'
): Promise<PipelineResult> {
  // 3-second countdown — gives the producer a moment to start playback in
  // FL Studio and queue up the section they want analyzed before the 15s
  // audio recording fires.
  for (let s = 3; s >= 1; s--) {
    if (signal?.aborted) throw new CancelledError()
    onStatus({ phase: 'countdown', seconds_remaining: s })
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

  // Read live FL plugin EQ in parallel with the 15s capture (it's MIDI I/O in
  // the main process, independent of the audio/FLP subprocesses). Never throws.
  const flPluginsPromise = scanFlPluginsSafe()

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

  let flp: FlpData
  let audio: AudioData
  try {
    ;[flp, audio] = await Promise.all([flpPromise, audioPromise])
  } finally {
    clearInterval(countdown)
  }
  if (signal?.aborted) throw new CancelledError()

  const suggestions = buildSuggestions(audio.ok ? audio : null, mode)
  const vocalVerdict = buildVocalVerdict(audio.ok ? audio : null, mode)
  const reference = getReference()
  const comparison = compareToReference(audio.ok ? audio : null, reference)

  // The mix WAV that capture_and_analyze persisted — attached to Gemini as
  // AUDIO 1 (only when the capture/analysis succeeded and the file exists).
  const mixWavPath = audio.ok ? lastWavPath() : null

  // Already running since the capture started — collect its result now.
  const flPlugins = await flPluginsPromise

  onStatus({ phase: 'gemini' })
  const text = await callGemini({
    flp,
    audio,
    suggestions,
    mode,
    vocalVerdict,
    reference,
    comparison,
    mixWavPath,
    pluginEqText: flPlugins.text,
    signal,
    onRetry: (info) => onStatus({ phase: 'gemini', retry: info })
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
    comparison,
    mixWavPath,
    referenceClipPath: reference?.ok ? reference.clipPath : null,
    pluginEqText: flPlugins.text
  }

  return {
    ok: true,
    text,
    timestamp: new Date().toISOString(),
    audio,
    suggestions,
    audioSource: audio.source ?? null,
    flpOk: !!flp.ok,
    flpPath: flp.ok && typeof flp.flp_path === 'string' ? flp.flp_path : null,
    flpName:
      flp.ok && typeof flp.flp_path === 'string' ? basename(flp.flp_path) : null,
    wavPath: audio.ok && typeof audio.wav_path === 'string' ? audio.wav_path : null,
    vocalChain: extractVocalChain(flp),
    vocalChainBuses: [...VOCAL_CHAIN_BUSES],
    mode,
    vocalVerdict,
    reference,
    comparison,
    flPluginEq: flPlugins.states,
    flBridgeAvailable: flPlugins.available
  }
}
