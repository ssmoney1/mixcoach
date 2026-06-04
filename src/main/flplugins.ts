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
