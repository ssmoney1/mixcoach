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

// gemini-1.5-pro was retired by Google. gemini-2.5-pro is paid-only (free
// tier has limit:0), so default to gemini-2.5-flash — vision-capable, fast,
// and generous on the free tier. Bump to 2.5-pro if/when billing is enabled.
const MODEL = 'gemini-2.5-flash'
// 8192 is gemini-2.5-flash's per-response cap (free tier respects the same
// cap). With THINKING_BUDGET=0 below, internal reasoning tokens don't eat
// this budget, so the full response always fits.
const MAX_OUTPUT_TOKENS = 8192
// gemini-2.5-flash burns "thinking" tokens against the same output budget
// by default — that's what was truncating responses at 2048. Setting the
// thinking budget to 0 disables the reasoning step entirely so every
// token in the budget goes to the actual answer.
const THINKING_BUDGET = 0

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

export type ScreenshotData = {
  ok: boolean
  base64: string | null
  mimeType: 'image/png'
  error: string | null
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
      'When discussing clarity, use the VOCAL VERDICT block as the ground truth for muddiness / harshness / sibilance / dullness rather than guessing from the screenshot.'
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

function formatReferenceBlock(
  reference: ReferenceAudio | null | undefined,
  comparison: Comparison | null | undefined
): string {
  if (!reference?.ok) return ''
  const lines: string[] = []
  lines.push(`REFERENCE TRACK: "${reference.filename}"`)
  lines.push('Reference measurements (the sonic target the producer wants to match):')
  if (reference.integrated_lufs != null)
    lines.push(`  integrated loudness: ${reference.integrated_lufs.toFixed(2)} LUFS`)
  if (reference.true_peak_db != null)
    lines.push(`  true peak: ${reference.true_peak_db.toFixed(2)} dBTP`)
  if (reference.loudness_range_lra != null)
    lines.push(`  LRA: ${reference.loudness_range_lra.toFixed(2)} LU`)
  if (reference.crest_factor_db != null)
    lines.push(`  crest factor: ${reference.crest_factor_db.toFixed(2)} dB`)
  if (reference.stereo_width != null)
    lines.push(`  stereo width: ${reference.stereo_width.toFixed(3)}`)
  if (reference.tonal_bands) {
    lines.push('  tonal bands (dBFS):')
    for (const [band, db] of Object.entries(reference.tonal_bands)) {
      if (typeof db === 'number') lines.push(`    ${band}: ${db.toFixed(1)}`)
    }
  }
  if (reference.mud_ratio != null)
    lines.push(`  mud ratio (250-500 Hz): ${reference.mud_ratio.toFixed(3)}`)
  if (reference.harshness_ratio != null)
    lines.push(`  harshness ratio (2-5 kHz): ${reference.harshness_ratio.toFixed(3)}`)
  if (reference.sibilance_ratio != null)
    lines.push(`  sibilance ratio (6-10 kHz): ${reference.sibilance_ratio.toFixed(3)}`)

  if (comparison) {
    lines.push('')
    lines.push(`COMPARISON (your mix → reference "${comparison.reference_filename}"):`)
    if (comparison.summary.length) {
      for (const s of comparison.summary) lines.push(`  - ${s}`)
    } else {
      lines.push('  - Your mix is already in the same ballpark as the reference on every measured dimension.')
    }
    if (comparison.fixes.length) {
      lines.push('')
      lines.push('Reference-driven fix candidates (informational — adopt the ones that match what you hear in the screenshot):')
      for (const f of comparison.fixes) lines.push(`  - ${f}`)
    }
  }
  return lines.join('\n')
}

type ChainInsert = NonNullable<FlpData['mixer']>[number]

// Extract the configured vocal-chain inserts from a parsed FLP, returning
// them in the same order as VOCAL_CHAIN_BUSES. Missing inserts are
// reported as null so the prompt can flag them explicitly.
export function extractVocalChain(
  flp: FlpData | null,
  buses: number[] = VOCAL_CHAIN_BUSES
): Array<{ bus: number; insert: ChainInsert | null }> {
  if (!flp || !flp.ok || !flp.mixer) return buses.map((bus) => ({ bus, insert: null }))
  const byIndex = new Map<number, ChainInsert>()
  for (const ins of flp.mixer) byIndex.set(ins.index, ins)
  return buses.map((bus) => ({ bus, insert: byIndex.get(bus) ?? null }))
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

async function geminiRequest(
  apiKey: string,
  systemPrompt: string,
  userParts: GeminiPart[],
  signal?: AbortSignal
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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  const json = (await res.json()) as GeminiResponse
  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${json.error?.message ?? 'request failed'}`)
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

export async function callGemini(args: {
  screenshot: ScreenshotData | null
  flp: FlpData | null
  audio: AudioData | null
  suggestions: Suggestion[]
  mode: Mode
  vocalVerdict: VocalVerdict | null
  reference: ReferenceAudio | null
  comparison: Comparison | null
  signal?: AbortSignal
}): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')

  const systemPrompt = await loadSystemPrompt(args.mode)
  const flpText = formatFlp(args.flp)
  const audioText = formatAudio(args.audio)
  const suggestionsText = formatSuggestions(args.suggestions)
  const vocalChainText = formatVocalChain(extractVocalChain(args.flp))
  const verdictText = formatVocalVerdict(args.vocalVerdict)
  const referenceText = formatReferenceBlock(args.reference, args.comparison)
  const modeBanner = `ANALYSIS MODE: ${args.mode.toUpperCase()}`

  const parts: GeminiPart[] = []
  parts.push({ text: modeBanner })
  if (args.screenshot?.ok && args.screenshot.base64) {
    parts.push({
      inline_data: { mime_type: args.screenshot.mimeType, data: args.screenshot.base64 }
    })
  } else {
    parts.push({ text: 'SCREENSHOT: unavailable.' })
  }
  if (verdictText) parts.push({ text: verdictText })
  if (referenceText) parts.push({ text: referenceText })
  parts.push({ text: `VOCAL CHAIN (in routing order):\n${vocalChainText}` })
  parts.push({ text: `FLP CHAIN:\n${flpText}` })
  parts.push({ text: `AUDIO ANALYSIS:\n${audioText}` })
  parts.push({ text: suggestionsText })

  return await geminiRequest(apiKey, systemPrompt, parts, args.signal)
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
}

function formatChatContext(ctx: ChatContext): string {
  const flpText = formatFlp(ctx.flp)
  const audioText = formatAudio(ctx.audio)
  const suggestionsText = formatSuggestions(ctx.suggestions)
  const vocalChainText = formatVocalChain(extractVocalChain(ctx.flp))
  const verdictText = formatVocalVerdict(ctx.vocalVerdict)
  const referenceText = formatReferenceBlock(ctx.reference, ctx.comparison)
  const analysis = ctx.analysisText?.trim() || '(no prior analysis — chat started without a run)'
  const blocks: string[] = [`ANALYSIS MODE: ${ctx.mode.toUpperCase()}`]
  if (verdictText) blocks.push(verdictText)
  if (referenceText) blocks.push(referenceText)
  blocks.push(
    `VOCAL CHAIN (in routing order):\n${vocalChainText}`,
    `FLP CHAIN:\n${flpText}`,
    `AUDIO ANALYSIS:\n${audioText}`,
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

  const contents = args.messages.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.text }]
  }))

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
