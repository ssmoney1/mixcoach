// Reference track management — runs python/analyze_file.py against an
// uploaded mastered track, caches the resulting AudioData in memory, and
// computes a comparison (delta) against the user's current run so the AI
// can tell them what to change to sound more like the reference.

import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import type { AudioData } from './gemini'
import { pythonExecutable, pythonRoot, CancelledError } from './pipeline'

export type ReferenceAudio = AudioData & {
  filename: string
  filepath: string
}

let cachedReference: ReferenceAudio | null = null

export function getReference(): ReferenceAudio | null {
  return cachedReference
}

export function clearReference(): void {
  cachedReference = null
}

export async function setReferenceFromFile(
  filePath: string,
  signal?: AbortSignal
): Promise<ReferenceAudio> {
  const audio = await runAnalyzeFile(filePath, signal)
  if (!audio.ok) {
    throw new Error(audio.error ?? 'reference analysis failed')
  }
  const ref: ReferenceAudio = {
    ...audio,
    filename: basename(filePath),
    filepath: filePath
  }
  cachedReference = ref
  return ref
}

function runAnalyzeFile(filePath: string, signal?: AbortSignal): Promise<AudioData> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError())
    const proc = spawn(pythonExecutable(), ['analyze_file.py'], {
      cwd: pythonRoot(),
      env: { ...process.env, PYTHONUNBUFFERED: '1', MIXCOACH_REF_PATH: filePath },
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
          new Error(`analyze_file.py exited ${code}: ${stderr.trim() || stdout.trim()}`)
        )
      }
      const firstBrace = stdout.indexOf('{')
      const lastBrace = stdout.lastIndexOf('}')
      if (firstBrace === -1 || lastBrace === -1) {
        return reject(new Error(`analyze_file.py produced no JSON: ${stdout}`))
      }
      try {
        resolve(JSON.parse(stdout.slice(firstBrace, lastBrace + 1)) as AudioData)
      } catch (err) {
        reject(new Error(`analyze_file.py JSON parse failed: ${(err as Error).message}`))
      }
    })
  })
}

// ─────────────────────────────────────────────────────────────────────
// Comparison — produces a delta between the user's current run and the
// reference, plus a list of human-readable summary lines that get
// surfaced to the AI prompt and the UI.
// ─────────────────────────────────────────────────────────────────────

export type BandDiffs = {
  sub: number | null
  bass: number | null
  low_mid: number | null
  mid: number | null
  high_mid: number | null
  air: number | null
}

export type Comparison = {
  reference_filename: string
  lufs_diff: number | null
  true_peak_diff: number | null
  lra_diff: number | null
  stereo_width_diff: number | null
  crest_factor_diff: number | null
  mud_diff: number | null
  harshness_diff: number | null
  sibilance_diff: number | null
  tonal_band_diffs: BandDiffs
  // Plain-English diff lines, sorted with biggest gaps first.
  summary: string[]
  // Concrete "do this" guidance derived purely from the deltas; the AI
  // is told it can adopt or override these.
  fixes: string[]
}

function diff(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null) return null
  if (!isFinite(a) || !isFinite(b)) return null
  return a - b
}

function bandDiffs(
  user: AudioData['tonal_bands'] | undefined | null,
  ref: AudioData['tonal_bands'] | undefined | null
): BandDiffs {
  const keys: Array<keyof BandDiffs> = ['sub', 'bass', 'low_mid', 'mid', 'high_mid', 'air']
  const out: BandDiffs = {
    sub: null,
    bass: null,
    low_mid: null,
    mid: null,
    high_mid: null,
    air: null
  }
  if (!user || !ref) return out
  for (const k of keys) {
    out[k] = diff(user[k as keyof typeof user] as number, ref[k as keyof typeof ref] as number)
  }
  return out
}

const BAND_LABEL: Record<keyof BandDiffs, string> = {
  sub: 'sub (20-60 Hz)',
  bass: 'bass (60-250 Hz)',
  low_mid: 'low-mid (250-500 Hz)',
  mid: 'mid (500-2k Hz)',
  high_mid: 'high-mid (2-8k Hz)',
  air: 'air (8-20k Hz)'
}

export function compareToReference(
  user: AudioData | null | undefined,
  ref: ReferenceAudio | null | undefined
): Comparison | null {
  if (!user?.ok || !ref?.ok) return null

  const lufs_diff = diff(user.integrated_lufs, ref.integrated_lufs)
  const true_peak_diff = diff(user.true_peak_db, ref.true_peak_db)
  const lra_diff = diff(user.loudness_range_lra, ref.loudness_range_lra)
  const stereo_width_diff = diff(user.stereo_width, ref.stereo_width)
  const crest_factor_diff = diff(user.crest_factor_db, ref.crest_factor_db)
  const mud_diff = diff(user.mud_ratio, ref.mud_ratio)
  const harshness_diff = diff(user.harshness_ratio, ref.harshness_ratio)
  const sibilance_diff = diff(user.sibilance_ratio, ref.sibilance_ratio)
  const tonal_band_diffs = bandDiffs(user.tonal_bands, ref.tonal_bands)

  // Each tuple: (magnitude for sorting, summary line, optional fix line).
  type Line = { weight: number; summary: string; fix?: string }
  const lines: Line[] = []

  if (lufs_diff != null && Math.abs(lufs_diff) >= 1) {
    const dir = lufs_diff < 0 ? 'quieter' : 'louder'
    const abs = Math.abs(lufs_diff).toFixed(1)
    lines.push({
      weight: Math.abs(lufs_diff) * 4, // loudness is the biggest perceived gap
      summary: `Loudness: your mix is ${abs} LU ${dir} (${user.integrated_lufs?.toFixed(1)} LUFS vs reference ${ref.integrated_lufs?.toFixed(1)} LUFS)`,
      fix:
        lufs_diff < 0
          ? `Push the master ${abs} dB through Pro-L 2 (ceiling -1 dBTP) to match reference loudness.`
          : `Pull master gain down ${abs} dB; you're hotter than the reference and will lose dynamic range vs it.`
    })
  }

  if (true_peak_diff != null && Math.abs(true_peak_diff) >= 1) {
    const dir = true_peak_diff < 0 ? 'lower' : 'higher'
    lines.push({
      weight: Math.abs(true_peak_diff),
      summary: `True peak: ${Math.abs(true_peak_diff).toFixed(1)} dB ${dir} than reference (${user.true_peak_db?.toFixed(1)} vs ${ref.true_peak_db?.toFixed(1)} dBTP)`
    })
  }

  if (lra_diff != null && Math.abs(lra_diff) >= 1.5) {
    const dir = lra_diff < 0 ? 'tighter / more compressed' : 'looser / less compressed'
    lines.push({
      weight: Math.abs(lra_diff) * 1.2,
      summary: `Dynamics: your mix is ${Math.abs(lra_diff).toFixed(1)} LU ${dir} than reference (LRA ${user.loudness_range_lra?.toFixed(1)} vs ${ref.loudness_range_lra?.toFixed(1)})`,
      fix:
        lra_diff > 0
          ? 'Reference is more compressed — add bus glue compression (SSLGChannel, 2:1, 2 dB GR) before the limiter.'
          : 'Reference breathes more — ease off compression / lower limiter input by 1-2 dB.'
    })
  }

  if (stereo_width_diff != null && Math.abs(stereo_width_diff) >= 0.05) {
    const dir = stereo_width_diff < 0 ? 'narrower' : 'wider'
    lines.push({
      weight: Math.abs(stereo_width_diff) * 30,
      summary: `Stereo image: your mix is ${dir} than reference (width ${user.stereo_width?.toFixed(2)} vs ${ref.stereo_width?.toFixed(2)})`,
      fix:
        stereo_width_diff < 0
          ? 'Widen background elements with S1 Imager or MicroShift on synth/pad sends, keep kick + bass + lead vocal mono.'
          : 'Reference is more centred — pull back stereo enhancers / narrow the high band with S1 Imager.'
    })
  }

  // Tonal-balance diffs (per-band dBFS deltas). Flag bands that differ by
  // more than ~3 dB — that's the threshold where it's actually audible.
  for (const k of Object.keys(tonal_band_diffs) as Array<keyof BandDiffs>) {
    const d = tonal_band_diffs[k]
    if (d == null || Math.abs(d) < 3) continue
    const dir = d < 0 ? 'thinner / quieter' : 'hotter / heavier'
    const abs = Math.abs(d).toFixed(1)
    lines.push({
      weight: Math.abs(d) * 1.5,
      summary: `${BAND_LABEL[k]}: ${abs} dB ${dir} than reference`,
      fix:
        d > 0
          ? `Cut ${abs > '3' ? '3' : abs} dB at ${midOf(k)} Hz with Pro-Q 3 (wide Q) to match the reference.`
          : `Lift ${abs > '3' ? '3' : abs} dB at ${midOf(k)} Hz with Pro-Q 3 (wide Q) to match the reference.`
    })
  }

  if (mud_diff != null && Math.abs(mud_diff) >= 0.05) {
    lines.push({
      weight: Math.abs(mud_diff) * 100,
      summary:
        mud_diff > 0
          ? `Mud (250-500 Hz): you have ${(mud_diff * 100).toFixed(0)}% more low-mid energy than reference — your mix sounds boxier`
          : `Mud (250-500 Hz): you have ${(Math.abs(mud_diff) * 100).toFixed(0)}% less low-mid energy than reference — your mix may sound thinner / less warm`,
      fix:
        mud_diff > 0
          ? 'Narrow -2 dB cut at 300 Hz on the busiest tracks; high-pass non-bass elements at 100 Hz.'
          : 'Gentle +1 dB shelf around 200-300 Hz on the master bus for warmth.'
    })
  }

  if (harshness_diff != null && Math.abs(harshness_diff) >= 0.04) {
    lines.push({
      weight: Math.abs(harshness_diff) * 100,
      summary:
        harshness_diff > 0
          ? `Harshness (2-5 kHz): ${(harshness_diff * 100).toFixed(0)}% hotter than reference — yours will fatigue ears faster`
          : `Upper-mid presence: ${(Math.abs(harshness_diff) * 100).toFixed(0)}% lower than reference — yours may lack bite`,
      fix:
        harshness_diff > 0
          ? 'Dynamic EQ cut at 3-4 kHz with Pro-MB, threshold -18 dB, range 3 dB.'
          : '+1.5 dB shelf at 3 kHz on the vocal / lead bus to match presence.'
    })
  }

  if (sibilance_diff != null && Math.abs(sibilance_diff) >= 0.04) {
    lines.push({
      weight: Math.abs(sibilance_diff) * 100,
      summary:
        sibilance_diff > 0
          ? `Sibilance (6-10 kHz): ${(sibilance_diff * 100).toFixed(0)}% hotter than reference`
          : `Air (6-10 kHz): ${(Math.abs(sibilance_diff) * 100).toFixed(0)}% lower than reference — yours may sound dull`,
      fix:
        sibilance_diff > 0
          ? 'Insert Pro-DS on the vocal, target 7 kHz, threshold -6 dB.'
          : 'Add Fresh Air or a +1.5 dB shelf at 10 kHz on the mix bus.'
    })
  }

  lines.sort((a, b) => b.weight - a.weight)
  const summary = lines.map((l) => l.summary)
  const fixes = lines.flatMap((l) => (l.fix ? [l.fix] : []))

  return {
    reference_filename: ref.filename,
    lufs_diff,
    true_peak_diff,
    lra_diff,
    stereo_width_diff,
    crest_factor_diff,
    mud_diff,
    harshness_diff,
    sibilance_diff,
    tonal_band_diffs,
    summary,
    fixes
  }
}

function midOf(band: keyof BandDiffs): number {
  switch (band) {
    case 'sub':
      return 40
    case 'bass':
      return 120
    case 'low_mid':
      return 350
    case 'mid':
      return 1000
    case 'high_mid':
      return 4000
    case 'air':
      return 12000
  }
}
