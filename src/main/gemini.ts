import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { Suggestion, Mode, VocalVerdict } from './suggestions'
import type { ReferenceAudio, Comparison } from './reference'

// ─────────────────────────────────────────────────────────────────────
// Vocal chain routing — list the mixer insert numbers your vocal signal
// passes through, in order. Used to focus Gemini on the chain that
// actually shapes the vocal. Change this (or reorder it) when you switch
// templates. Indices match FL Studio's mixer numbering.
// ─────────────────────────────────────────────────────────────────────
export const VOCAL_CHAIN_BUSES: number[] = [13, 16, 5, 8]

// ─────────────────────────────────────────────────────────────────────
// Edit your gear here. This block is injected into the system prompt at
// runtime — no other file needs to change when you update it.
// ─────────────────────────────────────────────────────────────────────
export const YOUR_GEAR = {
  monitors: 'Yamaha HS7 (primary), Yamaha C80 (secondary)',
  interface: 'Universal Audio Apollo Solo',
  daw: 'FL Studio 21',
  // Keep this neutral. Treat every session as its own song with its own
  // aesthetic — don't pin the analysis to any one artist's sound.
  genre:
    'Modern hip-hop / trap / melodic rap (no fixed reference artist — judge each song on its own terms)',
  skill_level:
    'Intermediate - understands signal flow, still developing ear for subtle issues',
  // Scanned from the user's FL Studio plugin database
  // (Presets\Plugin database\Installed\Effects\{Fruity,VST,VST3}).
  // Deduped across VST2/VST3 and Mono/Stereo variants. Update by re-running
  // the scanner — see scripts/scan_plugins.py.
  plugins_owned: [
    'Abbey Road Chambers', 'Abbey Road RS124', 'API-2500',
    'Auto-Key', 'Auto-Tune Pro',
    'AVOX ARTICULATOR', 'AVOX ASPIRE', 'AVOX CHOIR', 'AVOX DUO',
    'AVOX MUTATOR', 'AVOX PUNCH', 'AVOX SYBIL', 'AVOX THROAT', 'AVOX WARM',
    'BritChannel',
    'C1 comp', 'C1 comp-gate', 'C1 comp-sc', 'C1 gate', 'C4',
    'CLA-2A', 'CLA-76',
    'Clarity Vx', 'Clarity Vx Pro',
    'Crystallizer',
    'Cymatics Deja Vu', 'Cymatics Diablo Lite', 'Cymatics Memory', 'Cymatics Space Lite',
    'dearVR MIX-SE',
    'DeBreath', 'Decapitator', 'DeepGliss', 'DeEsser',
    'DevilLoc', 'DevilLocDeluxe',
    'Distructor', 'Doubler2', 'Doubler4',
    'EchoBoy', 'Effector', 'EQUO',
    'F6', 'F6-RTA',
    'FilterFreak1', 'FilterFreak2', 'FIN-MICRO',
    'Frequency Shifter', 'Frequency Splitter', 'Fresh Air',
    'Fruity 7 Band EQ', 'Fruity Bass Boost', 'Fruity Blood Overdrive',
    'Fruity Chorus', 'Fruity Compressor', 'Fruity Convolver',
    'Fruity Delay', 'Fruity Delay 2', 'Fruity Delay 3', 'Fruity Delay Bank',
    'Fruity Fast Dist', 'Fruity Fast LP', 'Fruity Filter',
    'Fruity Flanger', 'Fruity Flangus', 'Fruity Free Filter',
    'Fruity Limiter', 'Fruity Love Philter',
    'Fruity Multiband Compressor', 'Fruity PanOMatic',
    'Fruity Parametric EQ', 'Fruity Parametric EQ 2',
    'Fruity Phaser', 'Fruity Reeverb', 'Fruity Reeverb 2',
    'Fruity Soft Clipper', 'Fruity Squeeze',
    'Fruity Stereo Enhancer', 'Fruity Stereo Shaper',
    'Fruity Vocoder', 'Fruity WaveShaper',
    'Graillon 2', 'Gross Beat', 'Guitar Rig 7',
    'H-Delay', 'H-Reverb', 'HalfTime', 'Hardcore', 'Hyper Chorus',
    'J37', 'JUNO-60 CHORUS',
    'kHs 3-Band EQ', 'kHs Bitcrush', 'kHs Channel Mixer', 'kHs Chorus',
    'kHs Comb Filter', 'kHs Compressor', 'kHs Delay', 'kHs Distortion',
    'kHs Dual Delay', 'kHs Dynamics', 'kHs Ensemble', 'kHs Filter',
    'kHs Flanger', 'kHs Formant Filter', 'kHs Frequency Shifter',
    'kHs Gain', 'kHs Gate', 'kHs Haas', 'kHs Ladder Filter',
    'kHs Limiter', 'kHs Nonlinear Filter', 'kHs Phaser',
    'kHs Pitch Shifter', 'kHs Resonator', 'kHs Reverb', 'kHs Ring Mod',
    'kHs Transient Shaper',
    'LALA', 'LittleAlterBoy', 'LittleMicroShift', 'LittlePrimalTap',
    'LittleRadiator', 'Low Lifter', 'Luxeverb',
    'Maximus', 'MetaFlanger', 'Mic Mod', 'Micro', 'MicroShift',
    'Multiband Delay', 'NS1',
    'Ozone 11 Equalizer', 'Ozone Imager 2',
    'PanCake2', 'PanMan', 'PhaseMistress',
    'Pitch Shifter', 'Pitcher', 'Portal', 'PrimalTap',
    'Pro-C 2', 'Pro-DS', 'Pro-G', 'Pro-L 2', 'Pro-MB',
    'Pro-Q 3', 'Pro-R', 'Pro-R 2',
    'PuigChild 660', 'PuigChild 670',
    'Q1', 'Q10', 'Q2', 'Q3', 'Q4', 'Q6', 'Q8',
    'Radiator', 'RC-20 Retro Color', 'RCompressor', 'ReLife',
    'REQ 2', 'REQ 4', 'REQ 6',
    'ReValver', 'RVerb', 'RVox',
    'S1 Imager', 'S1 MS Matrix', 'S1 Shuffler',
    'Saturn 2', 'Scheps 73', 'SerumFX',
    'Sibilance', 'Silk Vocal', 'Simplon', 'soothe2',
    'Soundgoodizer', 'Soundly Place it', 'Spreader', 'SSLGChannel',
    'TAL-Chorus-LX', 'The God Particle', 'Timeless 3',
    'Transient Processor', 'Tremolator', 'TrueVerb', 'Tube-Tech CL 1B',
    'UltraPitch 3 Voices', 'UltraPitch 6 Voices', 'UltraPitch Shift',
    'ValhallaDelay', 'ValhallaFreqEcho', 'ValhallaPlate',
    'ValhallaRoom', 'ValhallaShimmer', 'ValhallaSpaceModulator',
    'ValhallaSupermassive', 'ValhallaUberMod', 'ValhallaVintageVerb',
    'Vintage Chorus', 'Vintage Phaser', 'Vinyl',
    'Vocal Doubler', 'Vocal Rider', 'Vocodex', 'Volcano 3',
    'Waves Tune Real-Time', 'WNS',
    'Xvox Comp', 'Xvox DS', 'Xvox Pro', 'Xvox SFX', 'Xvox Space', 'Xvox Tone'
  ]
}

// ─────────────────────────────────────────────────────────────────────
// Model + generation config. Audio understanding + multi-input reasoning
// are strongest on Pro, so we default there now that MixCoach sends the
// actual audio clips (mix + reference) for an A/B. Switch to
// 'gemini-2.5-flash' if billing isn't enabled (Pro's free tier is limit:0).
// ─────────────────────────────────────────────────────────────────────
// NOTE: 'gemini-2.5-pro' is the better listener/reasoner, but its FREE tier
// is limit:0 — on a non-billing key the request hangs instead of returning
// (endless "Generating AI analysis" spinner). Default to flash, which is
// free-tier-safe and also audio-capable. Switch to 'gemini-2.5-pro' once
// billing is enabled on the GEMINI_API_KEY's project.
const MODEL = 'gemini-2.5-flash'
// Generous output budget so the full move-by-move answer + Final Tweaks
// checklist never truncates. Thinking tokens are budgeted separately below.
const MAX_OUTPUT_TOKENS = 16384
// A real thinking budget — Pro reasons over the two audio clips, the delta
// table, and the FLP chain before answering. (-1 = let the
// model decide dynamically; a fixed number caps it.)
const THINKING_BUDGET = 8192

export type FlpData = {
  ok: boolean
  error?: string | null
  flp_path?: string | null
  project?: { name?: string | null; bpm?: number | null }
  mixer?: Array<{
    index: number
    name: string | null
    volume: number | null
    pan: number | null
    muted: boolean | null
    plugins: Array<{
      slot: number
      name: string | null
      enabled: boolean | null
      mix: number | null
    }>
  }>
  sends?: Array<{ from: number; to: number; volume: number | null }>
}

// ROEX_DISABLED — original AudioData shape included roex-specific fields
// (true_peak_dbtp, dynamic_range, frequency_balance, feedback, roex_error,
// source: 'roex' | 'local'). The active shape below is local-only.
export type TonalBands = {
  sub?: number
  bass?: number
  low_mid?: number
  mid?: number
  high_mid?: number
  air?: number
}

export type AudioData = {
  ok: boolean
  error?: string | null
  source?: 'local'
  sample_rate?: number | null
  bit_depth?: number | null
  integrated_lufs?: number | null
  true_peak_db?: number | null
  loudness_range_lra?: number | null
  clipping_detected?: boolean
  clipping_sample_count?: number
  mono_compatible?: boolean
  phase_correlation?: number
  stereo_width?: number | null
  crest_factor_db?: number | null
  tonal_bands?: TonalBands
  dominant_band?: string | null
  mud_ratio?: number | null
  harshness_ratio?: number | null
  sibilance_ratio?: number | null
  key?: string | null
  key_confidence?: number | null
  bpm?: number | null
  bpm_stability_pct?: number | null
  wav_path?: string | null
}

function promptsRoot(): string {
  return is.dev
    ? join(app.getAppPath(), 'prompts')
    : join(process.resourcesPath, 'prompts')
}

function modeFocusText(mode: Mode): string {
  if (mode === 'vocal') {
    return [
      'SCOPE: This capture is focused on the VOCAL TRACK (soloed or vocal-dominant audio).',
      'Center every problem and every fix on the vocal: clarity, presence, sibilance, mud at 250-500 Hz, harshness at 2-5 kHz, breath handling, depth, dynamics, de-essing, and how the vocal chain in the FLP data shapes the signal.',
      'The vocal chain section is the canonical context. Do NOT give mix-bus or beat-balance advice in this mode — there is no instrumental in the capture (or it is intentionally absent).',
      'When discussing clarity, use the VOCAL VERDICT block as the ground truth for muddiness / harshness / sibilance / dullness rather than guessing.'
    ].join('\n')
  }
  if (mode === 'beat') {
    return [
      'SCOPE: This capture is focused on the BEAT / INSTRUMENTAL (no vocal, or vocal muted).',
      'Center every problem and every fix on the instrumental: kick-bass relationship in the 30-150 Hz region, low-mid mud at 250-500 Hz from synths and 808s, transient impact, drum bus glue compression, master headroom that leaves room for a vocal on top, stereo width and mono compatibility, mix-bus tonal balance.',
      'Ignore vocal-specific advice (sibilance, de-essing, vocal chain insert numbers) — there is no vocal in this capture. If the vocal chain section is present, you can still note whether the chain is set up correctly for when a vocal is added, but do not centre the response on it.'
    ].join('\n')
  }
  return [
    'SCOPE: This capture is the FULL MIX (vocal + instrumental together).',
    'Address how the vocal sits on top of the beat: masking between low-mid vocal energy and bass/synths, kick-vocal energy conflicts in the 200-400 Hz region, whether the vocal cuts through the upper-mids, sibilance against busy hi-hats, sidechain/ducking opportunities, and overall mix-bus balance.',
    'The vocal chain section shows the vocal processing; the rest of the mixer is the beat. Tie every fix to whichever side of the mix it lives on.'
  ].join('\n')
}

async function loadPrompt(filename: string, mode: Mode = 'both'): Promise<string> {
  const raw = await readFile(join(promptsRoot(), filename), 'utf8')
  return raw
    .replaceAll('{{DAW}}', YOUR_GEAR.daw)
    .replaceAll('{{MONITORS}}', YOUR_GEAR.monitors)
    .replaceAll('{{INTERFACE}}', YOUR_GEAR.interface)
    .replaceAll('{{GENRE}}', YOUR_GEAR.genre)
    .replaceAll('{{SKILL_LEVEL}}', YOUR_GEAR.skill_level)
    .replaceAll('{{PLUGINS}}', YOUR_GEAR.plugins_owned.join(', '))
    .replaceAll('{{MODE}}', mode)
    .replaceAll('{{MODE_FOCUS}}', modeFocusText(mode))
}

async function loadSystemPrompt(mode: Mode): Promise<string> {
  return loadPrompt('system.md', mode)
}

async function loadChatPrompt(mode: Mode): Promise<string> {
  return loadPrompt('chat.md', mode)
}

function formatVocalVerdict(v: VocalVerdict | null | undefined): string {
  if (!v) return ''
  const lines: string[] = []
  lines.push(`VOCAL VERDICT: ${v.headline} (clarity ${v.clarity_score}/100)`)
  if (v.issues.length) {
    lines.push('Issues:')
    for (const i of v.issues) lines.push(`  - ${i}`)
  } else {
    lines.push('Issues: none — vocal reads as clean across mud/harshness/sibilance/air.')
  }
  if (v.fixes.length) {
    lines.push('Concrete fixes (informational; weave the relevant ones into your own response):')
    for (const f of v.fixes) lines.push(`  - ${f}`)
  }
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────
// Reference delta TABLE — the spine of every reference-anchored analysis.
// Renders my-mix vs reference vs delta vs "direction to move" for every
// measured dimension, and pre-computes a per-band EQ-move hint. The deltas
// are GROUND TRUTH for which way to move; Gemini refines them into exact
// plugin moves and must not contradict the measured direction.
// ─────────────────────────────────────────────────────────────────────
const TABLE_BAND_HZ: Record<keyof TonalBands, number> = {
  sub: 40,
  bass: 120,
  low_mid: 350,
  mid: 1000,
  high_mid: 4000,
  air: 12000
}
const TABLE_BAND_LABEL: Record<keyof TonalBands, string> = {
  sub: 'sub (20-60 Hz)',
  bass: 'bass (60-250 Hz)',
  low_mid: 'low-mid (250-500 Hz)',
  mid: 'mid (500-2k Hz)',
  high_mid: 'high-mid (2-8k Hz)',
  air: 'air (8-20k Hz)'
}

function bandEqHint(band: keyof TonalBands, deltaDb: number): string {
  // deltaDb = my mix − reference. Positive = I'm hotter → cut. Negative =
  // I'm thinner → boost. Capped at 4 dB so we never suggest a wild move.
  const hz = TABLE_BAND_HZ[band]
  const amt = Math.min(Math.abs(deltaDb), 4)
  const lo = Math.max(1, Math.round(amt - 0.5))
  const hi = Math.max(lo, Math.round(amt + 0.5))
  const range = lo === hi ? `${lo} dB` : `${lo}-${hi} dB`
  const shape = band === 'air' ? 'high shelf @ ~10-12 kHz' : band === 'sub' ? 'low shelf @ ~40-60 Hz' : `bell @ ~${hz} Hz`
  return deltaDb > 0 ? `cut ${shape} by ${range}` : `boost ${shape} by ${range}`
}

function num(v: number | null | undefined, digits = 1): string {
  return v == null || !isFinite(v) ? 'n/a' : v.toFixed(digits)
}

function formatReferenceTable(
  audio: AudioData | null | undefined,
  reference: ReferenceAudio | null | undefined,
  comparison: Comparison | null | undefined
): string {
  if (!reference?.ok) return ''
  const lines: string[] = []
  lines.push(
    `REFERENCE A/B — your mix vs "${reference.filename}"` +
      (reference.startSec != null ? ` (15s segment from ${formatClock(reference.startSec)})` : '')
  )
  lines.push(
    'The Delta column is GROUND TRUTH for the DIRECTION to move each dimension. Refine the hints into exact plugin moves; never recommend moving a frequency the opposite way from its measured delta.'
  )
  lines.push('')

  if (!audio?.ok) {
    // No current-mix numbers (analysis failed) — still give the reference
    // targets so Gemini can A/B by ear against measured goals.
    lines.push('My-mix measurements unavailable this run; reference targets only:')
    lines.push(`  loudness ${num(reference.integrated_lufs)} LUFS · peak ${num(reference.true_peak_db)} dBTP · LRA ${num(reference.loudness_range_lra)} LU · width ${num(reference.stereo_width, 3)}`)
    return lines.join('\n')
  }

  lines.push('| Dimension | My mix | Reference | Delta | Move toward ref |')
  lines.push('|---|---|---|---|---|')
  const row = (dim: string, mine: string, ref: string, delta: string, move: string): void => {
    lines.push(`| ${dim} | ${mine} | ${ref} | ${delta} | ${move} |`)
  }
  const signed = (v: number, digits = 1, unit = ''): string =>
    `${v >= 0 ? '+' : ''}${v.toFixed(digits)}${unit ? ' ' + unit : ''}`

  // Loudness
  if (audio.integrated_lufs != null && reference.integrated_lufs != null) {
    const d = audio.integrated_lufs - reference.integrated_lufs
    row(
      'Integrated LUFS',
      `${num(audio.integrated_lufs)} LUFS`,
      `${num(reference.integrated_lufs)} LUFS`,
      signed(d, 1, 'LU'),
      d < 0 ? 'push loudness up (limiter input)' : 'pull master gain / limiter input down'
    )
  }
  // True peak
  if (audio.true_peak_db != null && reference.true_peak_db != null) {
    const d = audio.true_peak_db - reference.true_peak_db
    row(
      'True peak',
      `${num(audio.true_peak_db)} dBTP`,
      `${num(reference.true_peak_db)} dBTP`,
      signed(d, 1, 'dB'),
      d > 0 ? 'lower ceiling for headroom' : 'matched / safe'
    )
  }
  // LRA
  if (audio.loudness_range_lra != null && reference.loudness_range_lra != null) {
    const d = audio.loudness_range_lra - reference.loudness_range_lra
    row(
      'LRA (dynamics)',
      `${num(audio.loudness_range_lra)} LU`,
      `${num(reference.loudness_range_lra)} LU`,
      signed(d, 1, 'LU'),
      d > 0 ? 'tighten / glue (more compression)' : 'ease compression / let it breathe'
    )
  }
  // Stereo width
  if (audio.stereo_width != null && reference.stereo_width != null) {
    const d = audio.stereo_width - reference.stereo_width
    row(
      'Stereo width',
      num(audio.stereo_width, 3),
      num(reference.stereo_width, 3),
      signed(d, 3),
      d < 0 ? 'widen sides (keep low end mono)' : 'narrow the sides'
    )
  }
  // Six tonal bands with pre-computed EQ hints
  const myBands = audio.tonal_bands ?? {}
  const refBands = reference.tonal_bands ?? {}
  for (const band of Object.keys(TABLE_BAND_HZ) as Array<keyof TonalBands>) {
    const mine = myBands[band]
    const ref = refBands[band]
    if (typeof mine !== 'number' || typeof ref !== 'number') continue
    const d = mine - ref
    const move = Math.abs(d) < 1 ? 'matched' : bandEqHint(band, d)
    row(TABLE_BAND_LABEL[band], `${num(mine)} dBFS`, `${num(ref)} dBFS`, signed(d, 1, 'dB'), move)
  }
  // Energy ratios
  if (audio.mud_ratio != null && reference.mud_ratio != null) {
    const d = audio.mud_ratio - reference.mud_ratio
    row('Mud ratio (250-500)', num(audio.mud_ratio, 3), num(reference.mud_ratio, 3), signed(d, 3), d > 0 ? 'cut low-mid (see band rows)' : 'add low-mid warmth')
  }
  if (audio.harshness_ratio != null && reference.harshness_ratio != null) {
    const d = audio.harshness_ratio - reference.harshness_ratio
    row('Harshness (2-5k)', num(audio.harshness_ratio, 3), num(reference.harshness_ratio, 3), signed(d, 3), d > 0 ? 'tame 2-5 kHz (dynamic EQ)' : 'add presence ~3 kHz')
  }
  if (audio.sibilance_ratio != null && reference.sibilance_ratio != null) {
    const d = audio.sibilance_ratio - reference.sibilance_ratio
    row('Sibilance (6-10k)', num(audio.sibilance_ratio, 3), num(reference.sibilance_ratio, 3), signed(d, 3), d > 0 ? 'de-ess harder ~7 kHz' : 'a touch brighter / more air')
  }

  if (comparison?.summary.length) {
    lines.push('')
    lines.push('Biggest measured gaps, priority order:')
    for (const s of comparison.summary.slice(0, 5)) lines.push(`  - ${s}`)
  }
  return lines.join('\n')
}

// mm:ss formatter for clip-start timestamps.
function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

type ChainInsert = NonNullable<FlpData['mixer']>[number]

// Extract the vocal-chain inserts from a parsed FLP.
// First tries VOCAL_CHAIN_BUSES; if none of those channels have plugins,
// falls back to auto-detecting every insert that has at least one plugin
// (excluding the special iid ≤ 0 channels like Master and "current").
export function extractVocalChain(
  flp: FlpData | null,
  buses: number[] = VOCAL_CHAIN_BUSES
): Array<{ bus: number; insert: ChainInsert | null }> {
  if (!flp || !flp.ok || !flp.mixer) return buses.map((bus) => ({ bus, insert: null }))
  const byIndex = new Map<number, ChainInsert>()
  for (const ins of flp.mixer) byIndex.set(ins.index, ins)

  const configured = buses.map((bus) => ({ bus, insert: byIndex.get(bus) ?? null }))
  const hasPlugins = configured.some((c) => c.insert?.plugins?.length)
  if (hasPlugins) return configured

  // Auto-detect: every regular insert (iid > 0) that has at least one plugin,
  // sorted by channel number so the signal flow reads left-to-right.
  const active = flp.mixer
    .filter((ins) => ins.index > 0 && Array.isArray(ins.plugins) && ins.plugins.length > 0)
    .sort((a, b) => a.index - b.index)

  if (active.length === 0) return configured
  return active.map((ins) => ({ bus: ins.index, insert: ins }))
}

function formatVocalChain(
  chain: Array<{ bus: number; insert: ChainInsert | null }>
): string {
  const order = chain.map((c) => `Insert ${c.bus}`).join(' → ')
  const lines: string[] = []
  lines.push(`Signal flow (in order): ${order}`)
  lines.push('')
  for (let step = 0; step < chain.length; step++) {
    const { bus, insert } = chain[step]
    const header = `Step ${step + 1}: Insert ${bus}`
    if (!insert) {
      lines.push(`${header} — not present in FLP (template mismatch?)`)
      lines.push('')
      continue
    }
    const name = insert.name ?? `(unnamed)`
    const vol = insert.volume == null ? '' : ` vol=${insert.volume.toFixed(2)}`
    const pan = insert.pan == null ? '' : ` pan=${insert.pan.toFixed(2)}`
    const muted = insert.muted ? ' [MUTED]' : ''
    lines.push(`${header}: ${name}${vol}${pan}${muted}`)
    // Only enabled plugins influence the audio, so that's all we hand
    // to Gemini. Slot numbers are 1-indexed for prompt + UI parity with
    // what FL Studio displays in the mixer rack.
    const active = insert.plugins
      .filter((p) => p.enabled !== false)
      .slice()
      .sort((a, b) => a.slot - b.slot)
    if (!active.length) {
      lines.push('  (no enabled plugins on this insert)')
    } else {
      for (const p of active) {
        const mix =
          typeof p.mix === 'number' && isFinite(p.mix) ? ` mix=${p.mix.toFixed(0)}%` : ''
        lines.push(`  slot ${p.slot + 1}: ${p.name ?? '(unknown)'}${mix}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

function formatFlp(flp: FlpData | null): string {
  if (!flp) return 'FLP DATA: unavailable.'
  if (!flp.ok) {
    return `FLP DATA: unavailable (${flp.error ?? 'unknown error'}).`
  }
  const lines: string[] = []
  const project = flp.project ?? {}
  lines.push(
    `Project: ${project.name ?? 'unknown'} @ ${project.bpm ?? '??'} BPM (${flp.flp_path ?? ''})`
  )
  lines.push('')
  for (const insert of flp.mixer ?? []) {
    const muted = insert.muted ? ' [MUTED]' : ''
    const vol = insert.volume == null ? '' : ` vol=${insert.volume.toFixed(2)}`
    const pan = insert.pan == null ? '' : ` pan=${insert.pan.toFixed(2)}`
    lines.push(`Insert ${insert.index}: ${insert.name ?? '(unnamed)'}${vol}${pan}${muted}`)
    const active = insert.plugins.filter((p) => p.enabled !== false)
    if (!active.length) {
      lines.push('  (no enabled plugins)')
    } else {
      for (const p of active) {
        const mix =
          typeof p.mix === 'number' && isFinite(p.mix) ? ` mix=${p.mix.toFixed(0)}%` : ''
        lines.push(`  slot ${p.slot + 1}: ${p.name}${mix}`)
      }
    }
  }
  if (flp.sends && flp.sends.length) {
    lines.push('')
    lines.push('Sends:')
    for (const s of flp.sends) {
      const vol = s.volume == null ? '' : ` (${s.volume.toFixed(2)})`
      lines.push(`  Insert ${s.from} → Insert ${s.to}${vol}`)
    }
  }
  return lines.join('\n')
}

function fmt(value: unknown, unit = ''): string {
  if (value == null) return 'n/a'
  if (typeof value === 'number') {
    return `${value.toFixed(2)}${unit ? ' ' + unit : ''}`
  }
  return String(value)
}

function formatAudio(a: AudioData | null): string {
  if (!a) return 'AUDIO ANALYSIS: unavailable.'
  if (!a.ok) {
    return `AUDIO ANALYSIS: unavailable (${a.error ?? 'unknown error'}).`
  }
  const lines: string[] = []
  lines.push(`Source: ${a.source ?? 'local'} analysis (pyloudnorm + librosa)`)
  if (a.sample_rate != null) lines.push(`Sample rate: ${a.sample_rate} Hz`)
  if (a.bit_depth != null) lines.push(`Bit depth: ${a.bit_depth}-bit`)
  lines.push(`Integrated loudness: ${fmt(a.integrated_lufs, 'LUFS')}`)
  lines.push(`True peak: ${fmt(a.true_peak_db, 'dBTP')}`)
  if (a.loudness_range_lra != null)
    lines.push(`Loudness range (LRA): ${fmt(a.loudness_range_lra, 'LU')}`)
  if (a.crest_factor_db != null) lines.push(`Crest factor: ${fmt(a.crest_factor_db, 'dB')}`)
  if (a.clipping_detected !== undefined) {
    lines.push(
      `Clipping: ${a.clipping_detected ? `yes (${a.clipping_sample_count ?? 0} samples > 0.99)` : 'no'}`
    )
  }
  if (a.mono_compatible !== undefined) {
    lines.push(
      `Mono compatibility: ${a.mono_compatible ? 'ok' : 'phase issues'} (correlation = ${fmt(a.phase_correlation)})`
    )
  }
  if (a.stereo_width != null) lines.push(`Stereo width (mid/side): ${fmt(a.stereo_width)}`)
  if (a.tonal_bands && typeof a.tonal_bands === 'object') {
    lines.push('Tonal bands (dBFS):')
    for (const [band, db] of Object.entries(a.tonal_bands)) {
      lines.push(`  ${band}: ${fmt(db, 'dBFS')}`)
    }
  }
  if (a.dominant_band) lines.push(`Dominant band: ${a.dominant_band}`)
  if (a.mud_ratio != null)
    lines.push(`Mud ratio (250-500 Hz / total power): ${fmt(a.mud_ratio)}`)
  if (a.harshness_ratio != null)
    lines.push(`Harshness ratio (2-5 kHz / total power): ${fmt(a.harshness_ratio)}`)
  if (a.sibilance_ratio != null)
    lines.push(`Sibilance ratio (6-10 kHz / total power): ${fmt(a.sibilance_ratio)}`)
  if (a.key)
    lines.push(`Detected key: ${a.key}${a.key_confidence != null ? ` (confidence ${(a.key_confidence * 100).toFixed(0)}%)` : ''}`)
  if (a.bpm != null)
    lines.push(`Detected tempo: ${a.bpm.toFixed(1)} BPM${a.bpm_stability_pct != null ? ` (stability ±${a.bpm_stability_pct.toFixed(2)}%)` : ''}`)
  return lines.join('\n')
}

function formatSuggestions(suggestions: Suggestion[]): string {
  if (!suggestions.length) {
    return 'FLAGGED ISSUES:\n  (none — the automated checks all passed)'
  }
  const lines = ['Automated analysis flagged these specific issues:']
  for (const s of suggestions) {
    lines.push(`- ${s.title}: ${s.message} (severity: ${s.severity})`)
  }
  return lines.join('\n')
}

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
  error?: { message?: string }
}

// Read a WAV from disk and wrap it as a Gemini inline audio part. 15s clips
// are ~2-3 MB, well under the inline request ceiling, so base64 is fine.
// Returns null (and logs) if the file is missing/empty so the pipeline never
// breaks just because audio couldn't be attached.
async function readAudioInlinePart(
  path: string | null | undefined,
  label: string
): Promise<GeminiPart | null> {
  if (!path) return null
  try {
    const buf = await readFile(path)
    if (!buf.length) {
      console.warn(`[gemini] ${label} audio at ${path} was empty — skipping attach`)
      return null
    }
    return { inline_data: { mime_type: 'audio/wav', data: buf.toString('base64') } }
  } catch (err) {
    console.warn(`[gemini] could not attach ${label} audio (${path}): ${(err as Error).message}`)
    return null
  }
}

// Log a one-line manifest of the request parts so we can confirm — in the
// terminal — that the audio clips are actually attached.
function logParts(label: string, parts: GeminiPart[]): void {
  const manifest = parts.map((p) => {
    if ('inline_data' in p) {
      const kb = Math.round((p.inline_data.data.length * 0.75) / 1024)
      return `[${p.inline_data.mime_type} ${kb}KB]`
    }
    const head = p.text.split('\n', 1)[0].slice(0, 32)
    return `[text ${p.text.length}c "${head}…"]`
  })
  const audioCount = parts.filter((p) => 'inline_data' in p && p.inline_data.mime_type.startsWith('audio/')).length
  const imgCount = parts.filter((p) => 'inline_data' in p && p.inline_data.mime_type.startsWith('image/')).length
  console.log(`[gemini] ${label}: ${parts.length} parts (${audioCount} audio, ${imgCount} image) → ${manifest.join(' ')}`)
}

// ─────────────────────────────────────────────────────────────────────
// Retry policy. Gemini's most common failure on a busy day is a transient
// 503 "the model is overloaded" (a.k.a. "spike in usage") — the request
// never gets processed and clears on its own within seconds. 429 (rate
// limit) and 500/502/504 (gateway hiccups) are the same kind of "try again"
// signal. A single one of these used to throw away the whole 15s capture;
// now we back off and retry instead.
// ─────────────────────────────────────────────────────────────────────
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 4
const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000
// Per-attempt hard timeout so a stalled upload/response can never hang the
// pipeline forever. The user's cancel signal still aborts immediately.
const TIMEOUT_MS = 90_000

// Reported to the caller before each backoff so the UI can show a live
// "Gemini busy, retrying…" state instead of a frozen spinner. status === 0
// means a network error / timeout (no HTTP response).
export type RetryInfo = {
  attempt: number
  maxAttempts: number
  waitMs: number
  status: number
}

// Exponential backoff for attempt N (1-indexed): 1s, 2s, 4s, … capped.
function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
}

// Honor a server-sent Retry-After (delta-seconds form) when present, capped
// so a hostile/huge value can't strand the user. Returns null for the
// HTTP-date form or anything unparseable, so we fall back to plain backoff.
function parseRetryAfter(res: Awaited<ReturnType<typeof fetch>>): number | null {
  const h = res.headers.get('retry-after')
  if (!h) return null
  const secs = Number(h)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_BACKOFF_MS)
  return null
}

// Sleep that rejects with an AbortError the instant the user cancels, so a
// pending backoff never delays a cancellation. (index.ts treats AbortError
// as a clean cancel.)
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}

async function geminiRequest(
  apiKey: string,
  systemPrompt: string,
  userParts: GeminiPart[],
  signal?: AbortSignal,
  onRetry?: (info: RetryInfo) => void
): Promise<string> {
  const body = {
    systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.5,
      thinkingConfig: { thinkingBudget: THINKING_BUDGET }
    }
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`

  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Fresh per-attempt timeout controller, chained to the user's cancel.
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const forwardAbort = (): void => ctrl.abort()
    if (signal) {
      if (signal.aborted) ctrl.abort()
      else signal.addEventListener('abort', forwardAbort, { once: true })
    }

    let res: Awaited<ReturnType<typeof fetch>> | null = null
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      })
    } catch (err) {
      // A user-initiated cancel propagates immediately — never retried.
      if (signal?.aborted) throw err
      // Our own timeout, or a network error (DNS/reset) — both transient.
      lastErr = ctrl.signal.aborted
        ? new Error(`Gemini request timed out after ${TIMEOUT_MS / 1000}s`)
        : (err as Error)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }

    // No HTTP response (timeout / network) → back off and retry, or give up.
    if (!res) {
      if (attempt < MAX_ATTEMPTS) {
        const waitMs = backoffMs(attempt)
        console.warn(`[gemini] ${lastErr?.message ?? 'request failed'} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${waitMs}ms`)
        onRetry?.({ attempt, maxAttempts: MAX_ATTEMPTS, waitMs, status: 0 })
        await abortableSleep(waitMs, signal)
        continue
      }
      break
    }

    const json = (await res.json()) as GeminiResponse
    if (!res.ok) {
      const status = res.status
      const msg = json.error?.message ?? 'request failed'
      // Transient server-side status → back off and retry.
      if (RETRYABLE_STATUS.has(status) && attempt < MAX_ATTEMPTS) {
        lastErr = new Error(`Gemini ${status}: ${msg}`)
        const waitMs = parseRetryAfter(res) ?? backoffMs(attempt)
        console.warn(`[gemini] ${status}: ${msg} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${waitMs}ms`)
        onRetry?.({ attempt, maxAttempts: MAX_ATTEMPTS, waitMs, status })
        await abortableSleep(waitMs, signal)
        continue
      }
      // Non-retryable (e.g. 400/401/403) or out of attempts → fail now.
      throw new Error(`Gemini ${status}: ${msg}`)
    }

    const blocked = json.promptFeedback?.blockReason
    if (blocked) throw new Error(`Gemini blocked the request: ${blocked}`)
    const candidate = json.candidates?.[0]
    const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    if (!text.trim()) {
      throw new Error('Gemini returned an empty response')
    }
    const finish = candidate?.finishReason
    if (finish && finish !== 'STOP') {
      console.warn(`[gemini] finishReason=${finish} (response may be incomplete)`)
      if (finish === 'MAX_TOKENS') {
        return text.trim() + '\n\n_(response truncated at token limit — raise MAX_OUTPUT_TOKENS)_'
      }
    }
    return text.trim()
  }

  // Every attempt hit a transient failure.
  throw lastErr ??
    new Error(`Gemini unavailable after ${MAX_ATTEMPTS} attempts (the model stayed overloaded — try again in a minute)`)
}

export async function callGemini(args: {
  flp: FlpData | null
  audio: AudioData | null
  suggestions: Suggestion[]
  mode: Mode
  vocalVerdict: VocalVerdict | null
  reference: ReferenceAudio | null
  comparison: Comparison | null
  // Path to the recorded 15s mix WAV (capture_and_analyze persists it). Sent
  // to Gemini as "AUDIO 1" so it can hear the mix, not just read the numbers.
  mixWavPath: string | null
  // Live plugin settings read from FL over MIDI (Pro-Q 3 EQ moves, etc.).
  // Null when no supported plugin is found or the FL bridge is offline.
  pluginEqText?: string | null
  signal?: AbortSignal
  // Called before each backoff when Gemini returns a transient error, so the
  // pipeline can surface a live "busy, retrying…" status to the UI.
  onRetry?: (info: RetryInfo) => void
}): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')

  const systemPrompt = await loadSystemPrompt(args.mode)
  const flpText = formatFlp(args.flp)
  const audioText = formatAudio(args.audio)
  const suggestionsText = formatSuggestions(args.suggestions)
  const vocalChainText = formatVocalChain(extractVocalChain(args.flp))
  const verdictText = formatVocalVerdict(args.vocalVerdict)
  const referenceTable = formatReferenceTable(args.audio, args.reference, args.comparison)
  const modeBanner = `ANALYSIS MODE: ${args.mode.toUpperCase()}`

  // Attach the actual audio. AUDIO 1 = my mix, AUDIO 2 = the reference clip.
  const mixPart = await readAudioInlinePart(args.mixWavPath, 'mix')
  const refClipPath = args.reference?.ok ? args.reference.clipPath : null
  const refPart = await readAudioInlinePart(refClipPath, 'reference')

  const parts: GeminiPart[] = []
  parts.push({ text: modeBanner })

  // 1. Reference delta table first — it's the spine of the response.
  if (referenceTable) parts.push({ text: referenceTable })

  // 2. The audio itself, clearly labeled so Gemini can A/B the two clips.
  if (mixPart) {
    parts.push({
      text: 'AUDIO 1 — MY MIX: the 15-second capture you are coaching. LISTEN to this for tonal/perceptual calls (mud, harshness, vocal clarity, balance, arrangement). For stereo width, true peak, LUFS and mono compatibility, trust the DSP numbers below — the audio is mono-downsampled and you cannot hear those from it.'
    })
    parts.push(mixPart)
  } else {
    parts.push({ text: 'AUDIO 1 — MY MIX: unavailable (could not attach the captured WAV). Work from the DSP numbers.' })
  }
  if (refPart) {
    const ref = args.reference as ReferenceAudio
    const where = ref.startSec != null ? ` (15s from ${formatClock(ref.startSec)})` : ''
    parts.push({
      text: `AUDIO 2 — THE REFERENCE "${ref.filename}"${where}: the sonic target. A/B it against AUDIO 1 by ear AND against the delta table. Describe the specific differences you hear, then translate each into an exact move.`
    })
    parts.push(refPart)
  }

  // 3. Live plugin settings — the EXACT EQ moves already dialed in (when the
  // FL bridge is online and a supported plugin is present).
  if (args.pluginEqText) parts.push({ text: args.pluginEqText })

  // 4. Verdict + full chain context + DSP numbers + flagged issues.
  if (verdictText) parts.push({ text: verdictText })
  parts.push({ text: `VOCAL CHAIN (in routing order):\n${vocalChainText}` })
  parts.push({ text: `FULL FLP MIXER (every insert, every plugin in slot order):\n${flpText}` })
  parts.push({ text: `AUDIO ANALYSIS (DSP numbers — authoritative for level/stereo facts):\n${audioText}` })
  parts.push({ text: suggestionsText })

  logParts('analysis', parts)
  return await geminiRequest(apiKey, systemPrompt, parts, args.signal, args.onRetry)
}

// ─────────────────────────────────────────────────────────────────────
// Chat — follow-up Q&A with the same Gemini engineer, grounded in the
// last analysis context (FLP + audio + suggestions + vocal chain +
// previous analysis text).
// ─────────────────────────────────────────────────────────────────────

export type ChatMessage = { role: 'user' | 'assistant'; text: string }

export type ChatContext = {
  flp: FlpData | null
  audio: AudioData | null
  suggestions: Suggestion[]
  analysisText: string | null
  mode: Mode
  vocalVerdict: VocalVerdict | null
  reference: ReferenceAudio | null
  comparison: Comparison | null
  // Audio paths so follow-up chat can still HEAR the clips (e.g. "what about
  // the hi-hats"). Mix = the recorded capture; reference = the 15s segment.
  mixWavPath: string | null
  referenceClipPath: string | null
  // Live plugin EQ settings block (same one fed to the analysis), so follow-up
  // chat can reference the producer's actual moves. Null when unavailable.
  pluginEqText: string | null
}

function formatChatContext(ctx: ChatContext): string {
  const flpText = formatFlp(ctx.flp)
  const audioText = formatAudio(ctx.audio)
  const suggestionsText = formatSuggestions(ctx.suggestions)
  const vocalChainText = formatVocalChain(extractVocalChain(ctx.flp))
  const verdictText = formatVocalVerdict(ctx.vocalVerdict)
  const referenceTable = formatReferenceTable(ctx.audio, ctx.reference, ctx.comparison)
  const analysis = ctx.analysisText?.trim() || '(no prior analysis — chat started without a run)'
  const blocks: string[] = [`ANALYSIS MODE: ${ctx.mode.toUpperCase()}`]
  if (verdictText) blocks.push(verdictText)
  if (referenceTable) blocks.push(referenceTable)
  if (ctx.pluginEqText) blocks.push(ctx.pluginEqText)
  blocks.push(
    `VOCAL CHAIN (in routing order):\n${vocalChainText}`,
    `FULL FLP MIXER:\n${flpText}`,
    `AUDIO ANALYSIS (DSP numbers):\n${audioText}`,
    suggestionsText,
    `PRIOR AI ANALYSIS (already shown to the producer):\n${analysis}`
  )
  return blocks.join('\n\n')
}

export async function callGeminiChat(args: {
  messages: ChatMessage[]
  context: ChatContext
  signal?: AbortSignal
}): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')
  if (!args.messages.length) throw new Error('No chat messages provided')

  const chatPrompt = await loadChatPrompt(args.context.mode)
  const contextBlock = formatChatContext(args.context)
  const systemPrompt = `${chatPrompt}\n\n---\nCURRENT SESSION CONTEXT (ground truth for every reply):\n${contextBlock}`

  // Keep the audio in context: lead with a user turn carrying both clips +
  // a model ack, so the engineer can still "hear" the mix/reference when the
  // producer asks perceptual follow-ups ("what about the hi-hats?").
  const mixPart = await readAudioInlinePart(args.context.mixWavPath, 'chat-mix')
  const refPart = args.context.reference?.ok
    ? await readAudioInlinePart(args.context.referenceClipPath, 'chat-reference')
    : null

  type ChatTurn = { role: 'user' | 'model'; parts: GeminiPart[] }
  const contents: ChatTurn[] = []
  if (mixPart || refPart) {
    const lead: GeminiPart[] = []
    if (mixPart) {
      lead.push({ text: 'AUDIO 1 — MY MIX (the captured clip for this session):' })
      lead.push(mixPart)
    }
    if (refPart) {
      lead.push({ text: `AUDIO 2 — THE REFERENCE "${(args.context.reference as ReferenceAudio).filename}":` })
      lead.push(refPart)
    }
    lead.push({ text: 'Keep these clips in mind for follow-up questions about the sound.' })
    contents.push({ role: 'user', parts: lead })
    contents.push({
      role: 'model',
      parts: [
        {
          text: `Got it — I can hear your mix${refPart ? ' and the reference' : ''} and I have the session data. Ask away.`
        }
      ]
    })
  }
  for (const m of args.messages) {
    contents.push({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] })
  }

  if (mixPart || refPart) {
    logParts('chat-context', [...(contents[0]?.parts ?? [])])
  }

  const body = {
    systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.7,
      thinkingConfig: { thinkingBudget: THINKING_BUDGET }
    }
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: args.signal
  })
  const json = (await res.json()) as GeminiResponse
  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${json.error?.message ?? 'request failed'}`)
  }
  const blocked = json.promptFeedback?.blockReason
  if (blocked) throw new Error(`Gemini blocked the request: ${blocked}`)
  const candidate = json.candidates?.[0]
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text.trim()) throw new Error('Gemini returned an empty response')
  return text.trim()
}
