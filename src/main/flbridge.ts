// flbridge.ts — Electron-side MIDI bridge to the MixCoach FL Studio controller
// script (Phase 2, READ-ONLY).
//
// The FL controller script (fl_script/device_MixCoach.py) runs inside FL's
// sandboxed Python host and exposes plugin parameters over two loopMIDI ports.
// This module speaks the exact same SysEx wire protocol from the Node side.
//
//   "MixCoach In"   we SEND here (app -> FL)   — opened as a MIDI Output
//   "MixCoach Out"  we LISTEN here (FL -> app) — opened as a MIDI Input
//
// Wire protocol (payload is 7-bit ASCII JSON):
//   Command  (app -> FL):  F0 7D 4D 43 00 <ascii-json> F7
//   Response (FL -> app):  F0 7D 4D 43 01 <idxHi> <idxLo> <totHi> <totLo> <chunk> F7
//     idx/tot are 14-bit (hi<<7 | lo). Concatenate chunk payloads in idx order
//     until `tot` chunks arrive, then JSON-parse.
//
// This file has NO electron imports so it can also be exercised directly from a
// standalone Node script (see fl_script/test_flbridge.ts) before being wired
// into the renderer.

import { Input, Output } from '@julusian/midi'

// Port names as they appear in loopMIDI. Matched case-insensitively, and by
// substring as a fallback (some setups append a digit, e.g. "MixCoach In 1").
const APP_SEND_PORT = 'MixCoach In' // app -> FL  (MIDI Output on our side)
const APP_LISTEN_PORT = 'MixCoach Out' // FL -> app (MIDI Input on our side)

const SYSEX_START = 0xf0
const SYSEX_END = 0xf7
const PRIVATE_ID = 0x7d // non-commercial SysEx manufacturer id
const TAG0 = 0x4d // 'M'
const TAG1 = 0x43 // 'C'
const MSG_COMMAND = 0x00 // app -> FL
const MSG_RESPONSE = 0x01 // FL -> app

const DEFAULT_TIMEOUT_MS = 5000

// ── Command / response shapes ─────────────────────────────────────────
export type FlCommand =
  | { action: 'ping'; id?: number }
  | { action: 'list_plugins'; id?: number }
  | { action: 'read_plugin'; mixer_track: number; slot: number; id?: number }

export interface PluginLocation {
  mixer_track: number
  slot: number
  name: string
}

export interface PluginParam {
  i: number
  name: string
  val: number // normalized 0.0–1.0
  str: string // display string, e.g. "300 Hz", "-3.0 dB"
}

export interface PingResult {
  ok: boolean
  action: 'ping'
  pong?: boolean
  id?: number
}

export interface ListPluginsResult {
  ok: boolean
  action: 'list_plugins'
  count: number
  plugins: PluginLocation[]
  id?: number
}

export interface ReadPluginResult {
  ok: boolean
  action: 'read_plugin'
  mixer_track: number
  slot: number
  plugin?: string
  param_count?: number
  params?: PluginParam[]
  error?: string
  id?: number
}

type Logger = (line: string) => void

interface Pending {
  action: string
  expectedId: number | undefined
  chunks: Map<number, string>
  total: number | null
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// ── Helpers ───────────────────────────────────────────────────────────
function asciiJson(obj: unknown): string {
  // Force pure-ASCII so every byte is SysEx-safe (7-bit), matching the FL
  // script's json.dumps(ensure_ascii=True). Any code point above 0x7f is
  // emitted as a \uXXXX escape (which is itself ASCII).
  const raw = JSON.stringify(obj)
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code > 0x7f) {
      out += '\\u' + code.toString(16).padStart(4, '0')
    } else {
      out += raw[i]
    }
  }
  return out
}

function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')
}

interface PortLike {
  getPortCount(): number
  getPortName(index: number): string
}

function listPortNames(port: PortLike): string[] {
  const out: string[] = []
  for (let i = 0; i < port.getPortCount(); i++) out.push(port.getPortName(i))
  return out
}

function findPortIndex(port: PortLike, name: string): number {
  const lower = name.toLowerCase()
  for (let i = 0; i < port.getPortCount(); i++) {
    if (port.getPortName(i) === name) return i
  }
  for (let i = 0; i < port.getPortCount(); i++) {
    if (port.getPortName(i).toLowerCase().includes(lower)) return i
  }
  return -1
}

// ── Bridge ────────────────────────────────────────────────────────────
export class FlBridge {
  private input: Input | null = null
  private output: Output | null = null
  private opened = false
  private pending: Pending | null = null
  // Serializes commands — chunked responses carry no command id in their
  // header, so only one command may be in flight at a time.
  private tail: Promise<unknown> = Promise.resolve()
  private idCounter = 0
  private readonly log: Logger
  private readonly verbose: boolean

  constructor(opts: { logger?: Logger; verbose?: boolean } = {}) {
    this.verbose = opts.verbose ?? true
    const sink = opts.logger ?? ((line: string) => console.log('[flbridge] ' + line))
    this.log = (line: string) => {
      if (this.verbose) sink(line)
    }
  }

  isOpen(): boolean {
    return this.opened
  }

  open(): void {
    if (this.opened) return
    const output = new Output()
    const input = new Input()

    const sendIdx = findPortIndex(output, APP_SEND_PORT)
    if (sendIdx < 0) {
      throw new Error(
        `MIDI output port "${APP_SEND_PORT}" not found. ` +
          `Available outputs: [${listPortNames(output).join(', ') || 'none'}]. ` +
          `Is loopMIDI running with the port created?`
      )
    }
    const listenIdx = findPortIndex(input, APP_LISTEN_PORT)
    if (listenIdx < 0) {
      throw new Error(
        `MIDI input port "${APP_LISTEN_PORT}" not found. ` +
          `Available inputs: [${listPortNames(input).join(', ') || 'none'}]. ` +
          `Is loopMIDI running with the port created?`
      )
    }

    // CRUCIAL: SysEx is ignored by default in node-midi. Enable SysEx
    // (first arg false), keep timing + active-sensing ignored.
    input.ignoreTypes(false, true, true)
    input.on('message', (delta, message) => this.onMessage(delta, message))

    output.openPort(sendIdx)
    input.openPort(listenIdx)

    this.output = output
    this.input = input
    this.opened = true
    this.log(
      `open: send → "${output.getPortName(sendIdx)}" (#${sendIdx}), ` +
        `listen → "${input.getPortName(listenIdx)}" (#${listenIdx})`
    )
  }

  close(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(new Error('FL bridge closed'))
      this.pending = null
    }
    try {
      this.input?.closePort()
    } catch {
      /* ignore */
    }
    try {
      this.output?.closePort()
    } catch {
      /* ignore */
    }
    this.input = null
    this.output = null
    this.opened = false
    this.log('closed')
  }

  private nextId(): number {
    this.idCounter = (this.idCounter + 1) & 0x7fffffff
    return this.idCounter
  }

  // ── Public commands ──────────────────────────────────────────────────
  ping(timeoutMs?: number): Promise<PingResult> {
    return this.sendCommand<PingResult>({ action: 'ping', id: this.nextId() }, timeoutMs)
  }

  listPlugins(timeoutMs?: number): Promise<ListPluginsResult> {
    return this.sendCommand<ListPluginsResult>(
      { action: 'list_plugins', id: this.nextId() },
      timeoutMs
    )
  }

  readPlugin(insert: number, slot: number, timeoutMs?: number): Promise<ReadPluginResult> {
    return this.sendCommand<ReadPluginResult>(
      { action: 'read_plugin', mixer_track: insert, slot, id: this.nextId() },
      timeoutMs
    )
  }

  // ── Core send/receive ────────────────────────────────────────────────
  sendCommand<T = unknown>(cmd: FlCommand, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const exec = (): Promise<T> => this.execOne<T>(cmd, timeoutMs)
    // Chain regardless of whether the previous command resolved or rejected,
    // so one failure doesn't wedge the queue.
    const result = this.tail.then(exec, exec)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private execOne<T>(cmd: FlCommand, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.opened || !this.output) {
        reject(new Error('FL bridge is not open — call open() first'))
        return
      }

      const text = asciiJson(cmd)
      const bytes: number[] = [SYSEX_START, PRIVATE_ID, TAG0, TAG1, MSG_COMMAND]
      for (let k = 0; k < text.length; k++) bytes.push(text.charCodeAt(k) & 0x7f)
      bytes.push(SYSEX_END)

      const pending: Pending = {
        action: cmd.action,
        expectedId: cmd.id,
        chunks: new Map<number, string>(),
        total: null,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => {
          if (this.pending === pending) this.pending = null
          const got = pending.chunks.size
          const tot = pending.total ?? '?'
          reject(
            new Error(
              `FL bridge timeout after ${timeoutMs}ms for "${cmd.action}" ` +
                `(received ${got}/${tot} chunk(s)). Is FL open with the MixCoach ` +
                `controller assigned and the ports linked?`
            )
          )
        }, timeoutMs)
      }
      this.pending = pending

      this.log(`SEND ${cmd.action}  json=${text}`)
      this.log(`  hex=[${toHex(bytes)}]`)
      try {
        this.output.sendMessage(bytes)
      } catch (err) {
        clearTimeout(pending.timer)
        if (this.pending === pending) this.pending = null
        reject(new Error(`failed to send MIDI message: ${(err as Error).message}`))
      }
    })
  }

  private onMessage(_delta: number, msg: number[]): void {
    // Ignore anything that isn't a complete MixCoach response SysEx.
    if (msg.length < 10) return
    if (msg[0] !== SYSEX_START || msg[msg.length - 1] !== SYSEX_END) return
    if (msg[1] !== PRIVATE_ID || msg[2] !== TAG0 || msg[3] !== TAG1) return
    if (msg[4] !== MSG_RESPONSE) return

    const idx = (msg[5] << 7) | msg[6]
    const total = (msg[7] << 7) | msg[8]
    const payload = msg.slice(9, msg.length - 1)
    let chunkText = ''
    for (const b of payload) chunkText += String.fromCharCode(b)

    this.log(`RECV chunk ${idx + 1}/${total} (${payload.length} bytes)  hex=[${toHex(msg)}]`)

    const p = this.pending
    if (!p) {
      this.log(`RECV chunk ${idx + 1}/${total} with no command pending — ignoring`)
      return
    }
    // idx 0 marks the start of a response. If a partial buffer is already in
    // progress (e.g. a stale/incomplete prior response), start fresh.
    if (idx === 0 && p.chunks.size > 0) {
      this.log('RECV new response boundary (idx 0) — discarding partial buffer')
      p.chunks.clear()
    }
    p.chunks.set(idx, chunkText)
    p.total = total
    if (p.chunks.size < total) return

    // All chunks in — reassemble in index order.
    let full = ''
    for (let i = 0; i < total; i++) full += p.chunks.get(i) ?? ''

    let obj: unknown
    try {
      obj = JSON.parse(full)
    } catch (err) {
      // A corrupt reassembly (e.g. interleaved foreign chunks) — drop it and
      // keep waiting until the command's real response arrives or it times out.
      this.log(`RECV reassembly was not valid JSON (${(err as Error).message}) — discarding`)
      p.chunks.clear()
      p.total = null
      return
    }

    // The FL script echoes the command's "id". If this response is for a
    // different (stale/foreign) command, ignore it and keep waiting — chunked
    // responses carry no id in their header, so this is our correlation guard.
    const respId =
      obj && typeof obj === 'object' && 'id' in obj
        ? (obj as { id?: unknown }).id
        : undefined
    if (
      p.expectedId !== undefined &&
      typeof respId === 'number' &&
      respId !== p.expectedId
    ) {
      this.log(
        `RECV stale/foreign response id=${respId} (awaiting id=${p.expectedId}) — discarding`
      )
      p.chunks.clear()
      p.total = null
      return
    }

    // Accepted — finalize.
    clearTimeout(p.timer)
    this.pending = null
    const preview = full.length > 400 ? full.slice(0, 400) + '…' : full
    this.log(`RECV complete for "${p.action}" (${full.length} bytes)  json=${preview}`)
    p.resolve(obj)
  }
}

// ── Singleton accessor ────────────────────────────────────────────────
let _bridge: FlBridge | null = null

export function getFlBridge(opts?: { logger?: Logger; verbose?: boolean }): FlBridge {
  if (!_bridge) _bridge = new FlBridge(opts)
  return _bridge
}
