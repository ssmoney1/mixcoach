// flplugins.ts — Phase 4 orchestration (READ-ONLY). Bridges the live FL MIDI
// reader (flbridge) and the plugin interpreters (proq3_map) for the analysis
// pipeline. Finds Pro-Q 3 instances, reads them, and produces a labeled prompt
// block of the actual EQ moves currently dialed in.
//
// Everything degrades gracefully: if loopMIDI/FL isn't running, the bridge
// can't open, or a read fails, this returns an empty result and the pipeline
// falls back to its prior behavior. The native @julusian/midi dependency is
// reached only through this module, which the pipeline imports dynamically —
// so a missing/broken native binary can never crash the main process.

import { getFlBridge } from './flbridge'
import { isProQ3, mapProQ3, formatProQ3ForPrompt, type ProQ3State } from './proq3_map'

export interface PluginEqState {
  insert: number
  slot: number
  pluginName: string
  proq3: ProQ3State | null
  summary: string
}

export interface FlScanResult {
  available: boolean // bridge opened (FL + loopMIDI reachable)
  states: PluginEqState[]
  error?: string
}

// Only log the "bridge offline" notice once per offline streak, so a producer
// running without loopMIDI/FL doesn't get a warning on every analysis.
let warnedOffline = false

export async function scanPluginEq(opts?: {
  perCommandTimeoutMs?: number
  log?: (s: string) => void
}): Promise<FlScanResult> {
  const log = opts?.log ?? ((s: string) => console.log('[flplugins] ' + s))
  const timeoutMs = opts?.perCommandTimeoutMs ?? 4000

  let bridge: ReturnType<typeof getFlBridge>
  try {
    bridge = getFlBridge({ verbose: false })
    if (!bridge.isOpen()) bridge.open() // throws if loopMIDI ports are missing
    warnedOffline = false
  } catch (err) {
    if (!warnedOffline) {
      log(`FL bridge offline (${(err as Error).message}) — skipping live plugin read`)
      warnedOffline = true
    }
    return { available: false, states: [], error: (err as Error).message }
  }

  try {
    const list = await bridge.listPlugins(timeoutMs)
    const locs = list.plugins.filter((p) => isProQ3(p.name))
    log(`found ${locs.length} Pro-Q 3 instance(s) of ${list.count} plugin(s)`)

    const states: PluginEqState[] = []
    for (const loc of locs) {
      try {
        // FL returns empty display strings on a cold read of a plugin, so do a
        // throwaway warm-up read, then the real one; re-read once if displays
        // still haven't populated.
        await bridge.readPlugin(loc.mixer_track, loc.slot, timeoutMs)
        let dump = await bridge.readPlugin(loc.mixer_track, loc.slot, timeoutMs)
        let state = mapProQ3(dump)
        if (state.displaysMissing) {
          dump = await bridge.readPlugin(loc.mixer_track, loc.slot, timeoutMs)
          state = mapProQ3(dump)
        }
        const summary = formatProQ3ForPrompt(state, loc.mixer_track)
        log(summary)
        states.push({
          insert: loc.mixer_track,
          slot: loc.slot,
          pluginName: loc.name,
          proq3: state,
          summary
        })
      } catch (err) {
        log(`read failed for insert ${loc.mixer_track}/slot ${loc.slot}: ${(err as Error).message}`)
      }
    }
    return { available: true, states }
  } catch (err) {
    // Bridge opened but a command failed/timed out — treat as no data.
    log(`scan failed: ${(err as Error).message}`)
    return { available: true, states: [], error: (err as Error).message }
  }
}

// Assemble the labeled prompt block from scanned states (null if nothing
// usable was read).
export function buildPluginEqPromptText(states: PluginEqState[]): string | null {
  const lines = states.map((s) => s.summary).filter(Boolean)
  if (!lines.length) return null
  return (
    'ACTUAL PLUGIN SETTINGS (read live from FL Studio over MIDI — these are the ' +
    'EXACT EQ moves the producer already has dialed in right now). Critique THESE ' +
    "specific settings; do not suggest moves they have already made:\n" +
    lines.map((l) => `- ${l}`).join('\n')
  )
}

export function closeFlBridge(): void {
  try {
    getFlBridge().close()
  } catch {
    /* ignore */
  }
}

// ── Phase 5: APPLY (write) ────────────────────────────────────────────
// A single proposed change to one existing Pro-Q 3 band. Targets are in real
// units (Hz / dB / Q); we calibrate the normalized value to hit them, because
// Pro-Q 3's normalized readback is unreliable (display strings are truth).
export interface ProQ3Op {
  insert: number
  slot: number
  band: number // existing band number (1-based) to modify
  freqHz?: number
  gainDb?: number
  q?: number
  label?: string
}

export interface ApplyResult {
  ok: boolean
  op: ProQ3Op
  applied: string[] // human notes of what was set, e.g. "gain -2.50 dB"
  error?: string
}

function pHz(s: string | undefined): number | null {
  if (!s) return null
  const m = /(-?\d+(?:\.\d+)?)\s*(k?)\s*hz/i.exec(s)
  if (!m) return null
  return parseFloat(m[1]) * (m[2] ? 1000 : 1)
}
function pDb(s: string | undefined): number | null {
  if (!s) return null
  const m = /([+-]?\d+(?:\.\d+)?)\s*db/i.exec(s)
  return m ? parseFloat(m[1]) : null
}
function pNum(s: string | undefined): number | null {
  if (!s) return null
  const m = /(-?\d+(?:\.\d+)?)/.exec(s)
  return m ? parseFloat(m[1]) : null
}

// Binary-search the normalized value (0..1) until the read-back display hits
// `target` within `tol`. Assumes the display rises monotonically with the
// normalized value (true for Pro-Q 3 frequency / gain / Q).
async function calibrate(
  bridge: ReturnType<typeof getFlBridge>,
  op: ProQ3Op,
  paramIndex: number,
  target: number,
  parse: (s: string | undefined) => number | null,
  tol: number,
  log: (s: string) => void
): Promise<{ ok: boolean; got: number | null; str: string }> {
  let lo = 0
  let hi = 1
  let lastStr = ''
  let got: number | null = null
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2
    const res = await bridge.setParam(op.insert, op.slot, paramIndex, mid, 3000)
    lastStr = res.str ?? ''
    got = parse(res.str)
    if (got == null) return { ok: false, got: null, str: lastStr }
    if (Math.abs(got - target) <= tol) {
      log(`  param ${paramIndex}: ${got} (target ${target}) in ${i + 1} steps`)
      return { ok: true, got, str: lastStr }
    }
    if (got < target) lo = mid
    else hi = mid
  }
  return { ok: Math.abs((got ?? Infinity) - target) <= tol * 3, got, str: lastStr }
}

// Apply one op by reading the plugin, resolving the band's param indices by
// NAME, then calibrating each requested target. Read-only on everything it
// doesn't touch. Returns what was actually set.
export async function applyProQ3Op(op: ProQ3Op): Promise<ApplyResult> {
  const log = (s: string): void => console.log('[flplugins] apply: ' + s)
  let bridge: ReturnType<typeof getFlBridge>
  try {
    bridge = getFlBridge({ verbose: false })
    if (!bridge.isOpen()) bridge.open()
  } catch (err) {
    return { ok: false, op, applied: [], error: `FL bridge offline: ${(err as Error).message}` }
  }

  try {
    const dump = await bridge.readPlugin(op.insert, op.slot, 5000)
    if (!dump.ok || !dump.params) {
      return { ok: false, op, applied: [], error: dump.error || 'could not read plugin' }
    }
    // Resolve "Band <n> <key>" → param index for the target band.
    const idx: Record<string, number> = {}
    const re = new RegExp(`^Band\\s+${op.band}\\s+(.+?)\\s*$`, 'i')
    for (const p of dump.params) {
      const m = re.exec(p.name)
      if (m) idx[m[1].trim().toLowerCase()] = p.i
    }
    if (idx['gain'] == null && idx['frequency'] == null && idx['q'] == null) {
      return { ok: false, op, applied: [], error: `band ${op.band} not found on this plugin` }
    }

    // Make sure the band is on before changing it (normalized 1.0 = on).
    if (idx['used'] != null) await bridge.setParam(op.insert, op.slot, idx['used'], 1.0, 3000)
    if (idx['enabled'] != null) await bridge.setParam(op.insert, op.slot, idx['enabled'], 1.0, 3000)

    const applied: string[] = []
    if (op.gainDb != null && idx['gain'] != null) {
      const r = await calibrate(bridge, op, idx['gain'], op.gainDb, pDb, 0.15, log)
      applied.push(`gain → ${r.str.trim() || op.gainDb + ' dB'}${r.ok ? '' : ' (approx)'}`)
    }
    if (op.freqHz != null && idx['frequency'] != null) {
      const tol = Math.max(1, op.freqHz * 0.01)
      const r = await calibrate(bridge, op, idx['frequency'], op.freqHz, pHz, tol, log)
      applied.push(`freq → ${r.str.trim() || op.freqHz + ' Hz'}${r.ok ? '' : ' (approx)'}`)
    }
    if (op.q != null && idx['q'] != null) {
      const r = await calibrate(bridge, op, idx['q'], op.q, pNum, 0.03, log)
      applied.push(`Q → ${r.str.trim() || String(op.q)}${r.ok ? '' : ' (approx)'}`)
    }
    log(`band ${op.band} on insert ${op.insert}: ${applied.join(', ')}`)
    return { ok: true, op, applied }
  } catch (err) {
    return { ok: false, op, applied: [], error: (err as Error).message }
  }
}
