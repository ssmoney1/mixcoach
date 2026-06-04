// proq3_map.ts — FabFilter Pro-Q 3 interpreter (Phase 3, READ-ONLY).
//
// Takes the raw parameter dump from the FL bridge (flbridge.readPlugin) and
// distills it into a concise, human-readable EQ state. ALL FabFilter-specific
// knowledge lives here so other plugins can be added later without touching
// the bridge or the pipeline.
//
// Design notes:
//   - We match on parameter NAMES (getParamName), never hardcoded indexes —
//     FabFilter shifts indexes between versions, and FL Studio pads every
//     plugin with thousands of generic "MIDI CC #N" / "MIDI Channel N …"
//     params we must ignore. Only "Band N …" + a few globals matter.
//   - We prefer FabFilter's display strings ("89.5 Hz", "-3.0 dB", "Low Cut")
//     which are authoritative. Pro-Q's normalized 0–1 values use an internal
//     mapping we can't reliably invert, so when a display string is missing
//     (FL occasionally returns "" on a cold first read) we surface that via
//     `displaysMissing` rather than guessing.
//   - Low Cut / High Cut shaped bands ARE Pro-Q's HP/LP, so we route them to
//     `hp` / `lp` and keep bell/shelf/notch/etc. in `bands`.
//   - Unused, disabled (bypassed), and default-flat bands are skipped so the
//     summary stays tight.

import type { PluginParam, ReadPluginResult } from './flbridge'

export interface ProQ3Band {
  n: number
  type: string // 'bell' | 'low shelf' | 'high shelf' | 'notch' | 'band pass' | 'tilt shelf' | 'flat tilt' | 'unknown'
  freq: string | null // display, e.g. "300 Hz"
  freqHz: number | null // parsed numeric Hz
  gain: string | null // display, e.g. "-3.0 dB"
  gainDb: number | null // parsed numeric dB
  q: number | null // parsed numeric Q
  slope: string | null // shelf/tilt slope display if any
  enabled: boolean
  dynamic: boolean // dynamic EQ engaged on this band
}

export interface ProQ3Cut {
  n: number
  freq: string | null
  freqHz: number | null
  slope: string | null // "24 dB/oct"
}

export interface ProQ3State {
  plugin: string
  bands: ProQ3Band[]
  hp: ProQ3Cut | null // low-cut band → high-pass
  lp: ProQ3Cut | null // high-cut band → low-pass
  output: string | null // output gain display
  activeBandCount: number
  displaysMissing: boolean // true if FL returned empty display strings (cold read — re-read)
}

// ── Plugin identity ───────────────────────────────────────────────────
export function isProQ3(pluginName: string | null | undefined): boolean {
  if (!pluginName) return false
  return /pro-?\s*q\s*3/i.test(pluginName)
}

// ── Display-string parsers ────────────────────────────────────────────
function parseHz(s: string | null | undefined): number | null {
  if (!s) return null
  const m = /(-?\d+(?:\.\d+)?)\s*(k?)\s*hz/i.exec(s)
  if (!m) return null
  let v = parseFloat(m[1])
  if (m[2]) v *= 1000
  return Number.isFinite(v) ? v : null
}

function parseDb(s: string | null | undefined): number | null {
  if (!s) return null
  const m = /([+-]?\d+(?:\.\d+)?)\s*db/i.exec(s)
  return m ? parseFloat(m[1]) : null
}

function parseNum(s: string | null | undefined): number | null {
  if (!s) return null
  const m = /(-?\d+(?:\.\d+)?)/.exec(s)
  return m ? parseFloat(m[1]) : null
}

function cleanStr(s: string | null | undefined): string | null {
  if (s == null) return null
  const t = s.trim()
  return t.length ? t : null
}

// Toggle params are read from their DISPLAY STRING, not the normalized value.
// Pro-Q 3 readback through FL reports e.g. "Used"/"Unused", "Enabled" — and the
// normalized `val` for these is unreliable (often a constant), so the string is
// the source of truth. Falls back to `val` only when the string is unhelpful.
function isOn(p: PluginParam | undefined): boolean {
  if (!p) return false
  const s = (p.str ?? '').trim().toLowerCase()
  if (s) {
    // Check negatives first — "Unused" contains the substring "used".
    if (/^(unused|disabled|bypassed|off|no|none|normal|0)$/.test(s)) return false
    if (/^(used|enabled|on|yes|1)$/.test(s)) return true
    if (/disabl|bypass|unused|\boff\b/.test(s)) return false
    if (/enabl|\bused\b|\bon\b/.test(s)) return true
  }
  return p.val >= 0.5
}

function normalizeType(shapeStr: string | null): string {
  const t = cleanStr(shapeStr)
  if (!t) return 'unknown'
  return t.toLowerCase().replace(/\s+/g, ' ')
}

// ── Main interpreter ──────────────────────────────────────────────────
export function mapProQ3(dump: ReadPluginResult): ProQ3State {
  const params = dump.params ?? []

  // Group "Band N <key>" params by band number; collect non-band params
  // (we only look up a couple of globals from these).
  const bands = new Map<number, Record<string, PluginParam>>()
  const globals: Record<string, PluginParam> = {}
  const bandRe = /^Band\s+(\d+)\s+(.+?)\s*$/i

  for (const p of params) {
    const m = bandRe.exec(p.name)
    if (m) {
      const n = parseInt(m[1], 10)
      const key = m[2].trim().toLowerCase()
      let bucket = bands.get(n)
      if (!bucket) {
        bucket = {}
        bands.set(n, bucket)
      }
      bucket[key] = p
    } else {
      // Skip FL's generic MIDI block early; keep only plausible globals.
      if (!/^midi\b/i.test(p.name)) {
        globals[p.name.trim().toLowerCase()] = p
      }
    }
  }

  const outBands: ProQ3Band[] = []
  let hp: ProQ3Cut | null = null
  let lp: ProQ3Cut | null = null
  let displaysMissing = false

  for (const n of [...bands.keys()].sort((a, b) => a - b)) {
    const b = bands.get(n)!

    const usedP = b['used']
    const enabledP = b['enabled']
    const used = usedP ? isOn(usedP) : isOn(enabledP)
    if (!used) continue // band slot not in use

    const enabled = isOn(enabledP)
    const type = normalizeType(b['shape']?.str ?? null)

    const freq = cleanStr(b['frequency']?.str)
    const gain = cleanStr(b['gain']?.str)
    const slope = cleanStr(b['slope']?.str)
    const freqHz = parseHz(freq)
    const gainDb = parseDb(gain)
    const q = parseNum(cleanStr(b['q']?.str))
    // A band is "doing dynamics" only when its Dynamic Range is non-zero —
    // "Dynamics Enabled" can read on while the range (and thus the audible
    // effect) is 0 dB, so the range is the signal that actually matters.
    const dynRangeDb = parseDb(cleanStr(b['dynamic range']?.str))
    const dynamic =
      isOn(b['dynamics enabled']) && dynRangeDb != null && Math.abs(dynRangeDb) >= 0.1

    // FL cold-read: a used band whose frequency display is empty means the
    // dump's display strings haven't populated — flag for a re-read.
    if (b['frequency'] && !freq) displaysMissing = true

    // Skip disabled (bypassed) bands — they aren't shaping the sound.
    if (!enabled) continue

    // Route low/high cuts to HP/LP.
    if (type === 'low cut') {
      if (!hp) hp = { n, freq, freqHz, slope }
      else outBands.push(makeBand(n, type, freq, freqHz, gain, gainDb, q, slope, enabled, dynamic))
      continue
    }
    if (type === 'high cut') {
      if (!lp) lp = { n, freq, freqHz, slope }
      else outBands.push(makeBand(n, type, freq, freqHz, gain, gainDb, q, slope, enabled, dynamic))
      continue
    }

    // Skip default-flat bell/shelf/tilt bands (gain ≈ 0 and no dynamics).
    // Notch / band pass shape regardless of gain, so never treat them as flat.
    const shapesByGain = !/notch|band\s*pass|pass/.test(type)
    if (shapesByGain && !dynamic && gainDb != null && Math.abs(gainDb) < 0.1) continue

    outBands.push(makeBand(n, type, freq, freqHz, gain, gainDb, q, slope, enabled, dynamic))
  }

  // Output gain: find a global named like "Output Gain" / "Gain".
  const outputParam =
    findGlobal(globals, /^output\s*gain$/) ??
    findGlobal(globals, /output.*(gain|level)/) ??
    findGlobal(globals, /^gain$/)
  const output = cleanStr(outputParam?.str)

  return {
    plugin: dump.plugin ?? 'FabFilter Pro-Q 3',
    bands: outBands,
    hp,
    lp,
    output,
    activeBandCount: outBands.length + (hp ? 1 : 0) + (lp ? 1 : 0),
    displaysMissing
  }
}

function makeBand(
  n: number,
  type: string,
  freq: string | null,
  freqHz: number | null,
  gain: string | null,
  gainDb: number | null,
  q: number | null,
  slope: string | null,
  enabled: boolean,
  dynamic: boolean
): ProQ3Band {
  return { n, type, freq, freqHz, gain, gainDb, q, slope, enabled, dynamic }
}

function findGlobal(
  globals: Record<string, PluginParam>,
  re: RegExp
): PluginParam | undefined {
  for (const key of Object.keys(globals)) {
    if (re.test(key)) return globals[key]
  }
  return undefined
}

// ── Human/Gemini-facing summary ───────────────────────────────────────
// FabFilter-specific formatting lives here too. Produces a single line like:
//   "ACTUAL Pro-Q 3 on Insert 2: HP 80 Hz (24 dB/oct), Band 2 bell -3.0 dB @ 300 Hz Q1.0, …"
export function formatProQ3ForPrompt(state: ProQ3State, insert?: number): string {
  const where = insert != null ? ` on Insert ${insert}` : ''
  const parts: string[] = []

  if (state.hp) {
    parts.push(`HP ${state.hp.freq ?? '?'}${state.hp.slope ? ` (${state.hp.slope})` : ''}`)
  }
  for (const b of state.bands) {
    const bits: string[] = [`Band ${b.n} ${b.type}`]
    if (b.gain) bits.push(b.gain)
    if (b.freq) bits.push(`@ ${b.freq}`)
    if (b.q != null) bits.push(`Q${b.q}`)
    if (b.dynamic) bits.push('(dynamic)')
    parts.push(bits.join(' '))
  }
  if (state.lp) {
    parts.push(`LP ${state.lp.freq ?? '?'}${state.lp.slope ? ` (${state.lp.slope})` : ''}`)
  }
  if (state.output) parts.push(`Output ${state.output}`)

  if (!parts.length) {
    return `ACTUAL ${state.plugin}${where}: loaded but no active EQ moves detected.`
  }
  return `ACTUAL ${state.plugin}${where}: ${parts.join(', ')}`
}
