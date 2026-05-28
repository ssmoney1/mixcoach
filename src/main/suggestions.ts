// Rules engine: takes the local audio analysis payload and returns a list of
// concrete flagged issues. The renderer turns these into the "Suggested
// Changes" panel; the same list is also fed to Gemini for context.

export type Severity = 'critical' | 'warning'

export type Suggestion = {
  title: string
  message: string
  severity: Severity
}

// Mode the user selected before running an analysis. Drives which subset
// of issues is surfaced and how Gemini frames its response.
export type Mode = 'vocal' | 'beat' | 'both'

type AudioForRules = {
  ok?: boolean
  integrated_lufs?: number | null
  true_peak_db?: number | null
  clipping_detected?: boolean
  stereo_width?: number | null
  dominant_band?: string | null
  mud_ratio?: number | null
  harshness_ratio?: number | null
  sibilance_ratio?: number | null
  loudness_range_lra?: number | null
  mono_compatible?: boolean
  tonal_bands?: {
    sub?: number
    bass?: number
    low_mid?: number
    mid?: number
    high_mid?: number
    air?: number
  }
}

export function buildSuggestions(
  a: AudioForRules | null | undefined,
  mode: Mode = 'both'
): Suggestion[] {
  if (!a || a.ok === false) return []
  const out: Suggestion[] = []

  // Vocal mode tightens mud/harshness/sibilance thresholds because we
  // expect either a soloed vocal or vocal-dominant audio — buildups that
  // would be normal in a full mix become problems on a solo'd voice.
  // Beat mode loosens vocal-specific thresholds since there's no vocal.
  const mudThreshold = mode === 'vocal' ? 0.22 : mode === 'beat' ? 0.48 : 0.4
  const harshThreshold = mode === 'vocal' ? 0.22 : 0.35
  const sibilanceThreshold = mode === 'vocal' ? 0.18 : mode === 'beat' ? 0.45 : 0.3

  if (a.integrated_lufs != null) {
    if (a.integrated_lufs > -9) {
      out.push({
        title: 'Loudness',
        message: 'Your mix is too loud to be sent for mastering.',
        severity: 'warning'
      })
    } else if (a.integrated_lufs < -18 && mode !== 'vocal') {
      // A solo'd vocal at -18 LUFS is normal — only flag for beat/both.
      out.push({
        title: 'Loudness',
        message: 'Your mix may be too quiet, consider bringing up the gain.',
        severity: 'warning'
      })
    }
  }

  if (a.true_peak_db != null && a.true_peak_db > -1) {
    out.push({
      title: 'True Peak',
      message: 'Your true peak is clipping, bring your master fader down.',
      severity: 'critical'
    })
  }

  if (a.clipping_detected === true) {
    out.push({
      title: 'Clipping',
      message: 'Digital clipping detected, find and fix the source.',
      severity: 'critical'
    })
  }

  if (a.stereo_width != null && a.stereo_width < 0.3 && mode !== 'vocal') {
    // Vocals are usually centered — don't flag a narrow stereo field on a
    // soloed lead.
    out.push({
      title: 'Stereo Field',
      message: 'Your mix is too narrow, consider widening the stereo image.',
      severity: 'warning'
    })
  }

  if (
    a.dominant_band != null &&
    a.dominant_band !== 'bass' &&
    mode !== 'vocal'
  ) {
    // A vocal-dominant spectrum will sit in mid / high_mid — not a problem.
    out.push({
      title: 'Tonal Profile',
      message: 'Bass frequencies are not dominant, check your low end balance.',
      severity: 'warning'
    })
  }

  if (a.mud_ratio != null && a.mud_ratio > mudThreshold) {
    out.push({
      title: 'Low Mid Buildup',
      message:
        mode === 'vocal'
          ? 'Excess 250-500 Hz energy on the vocal — high-pass around 100 Hz and consider a 2-3 dB cut at 300 Hz with a narrow Q.'
          : 'Excess energy in the 250-500hz mud zone, high pass or cut there.',
      severity: 'warning'
    })
  }

  if (a.harshness_ratio != null && a.harshness_ratio > harshThreshold) {
    out.push({
      title: 'Harshness',
      message:
        mode === 'vocal'
          ? 'Vocal is harsh in the 2-5 kHz range — try a dynamic EQ cut around 3 kHz or pull back the upper-mid presence boost.'
          : 'Too much 2-5khz energy, this will cause ear fatigue.',
      severity: 'warning'
    })
  }

  if (a.sibilance_ratio != null && a.sibilance_ratio > sibilanceThreshold) {
    out.push({
      title: 'Sibilance',
      message:
        mode === 'vocal'
          ? 'Heavy 6-10 kHz sibilance — insert a de-esser (e.g. Pro-DS or Sibilance) before the limiter and target 6.5-8 kHz at -4 to -6 dB threshold.'
          : 'High 6-10khz sibilance detected, consider a de-esser.',
      severity: 'warning'
    })
  }

  if (a.loudness_range_lra != null && a.loudness_range_lra < 4 && mode !== 'vocal') {
    // Vocal compression is supposed to crush LRA — that's the point.
    out.push({
      title: 'Dynamic Range',
      message: 'Your track has limited dynamic range, ease up on compression.',
      severity: 'warning'
    })
  }

  if (a.mono_compatible === false) {
    out.push({
      title: 'Phase Issues',
      message: 'Phase problems detected, your mix may sound bad in mono.',
      severity: 'critical'
    })
  }

  // Vocal-mode-specific: flag a dull / missing-presence vocal explicitly
  // since "lack of clarity" is just as much a problem as mud.
  if (mode === 'vocal') {
    const air = a.tonal_bands?.air
    if (air != null && air < -30) {
      out.push({
        title: 'Lacking Air',
        message: `Air band (10+ kHz) sits at ${air.toFixed(1)} dBFS — vocal will read as dull. Add Fresh Air or a +2 dB high shelf around 12 kHz.`,
        severity: 'warning'
      })
    }
    const lowMid = a.tonal_bands?.low_mid
    const highMid = a.tonal_bands?.high_mid
    if (
      lowMid != null &&
      highMid != null &&
      lowMid - highMid > 8 &&
      (a.mud_ratio ?? 0) <= mudThreshold
    ) {
      out.push({
        title: 'Tilted Low-Mid Heavy',
        message: `Low-mid (${lowMid.toFixed(1)} dBFS) is significantly hotter than high-mid (${highMid.toFixed(1)} dBFS) — vocal will sound thick / boxy even though the 300 Hz band looks clean. Try a wide -2 dB cut at 500 Hz.`,
        severity: 'warning'
      })
    }
  }

  return out
}

// ────────────────────────────────────────────────────────────────────
// Vocal clarity verdict — a one-line plain-English read on the vocal
// (only computed when mode includes vocal). The renderer surfaces this
// at the top of the result panel and Gemini receives it as context.
// ────────────────────────────────────────────────────────────────────

export type VocalVerdict = {
  // Short label suitable for a UI badge: 'Clear', 'Muddy', 'Harsh',
  // 'Sibilant', 'Dull', or a compound like 'Muddy + harsh'.
  headline: string
  // Overall clarity score 0-100 (100 = pristine). Useful for color-coding.
  clarity_score: number
  // Plain-English problems, one per line.
  issues: string[]
  // Concrete fix suggestions tied to each issue.
  fixes: string[]
}

export function buildVocalVerdict(
  a: AudioForRules | null | undefined,
  mode: Mode
): VocalVerdict | null {
  if (mode === 'beat') return null
  if (!a || a.ok === false) return null

  const issues: string[] = []
  const fixes: string[] = []
  let penalty = 0

  const mud = a.mud_ratio
  if (mud != null) {
    if (mud > 0.32) {
      issues.push(
        `muddy — 250-500 Hz holds ${(mud * 100).toFixed(0)}% of total energy (clear vocal sits <22%)`
      )
      fixes.push(
        'High-pass at 100 Hz with 12 dB/oct slope, then narrow -3 dB cut at 300 Hz on Pro-Q 3.'
      )
      penalty += 30
    } else if (mud > 0.22) {
      issues.push(`slightly muddy — 250-500 Hz at ${(mud * 100).toFixed(0)}% of total energy`)
      fixes.push('Light -1.5 dB cut at 250-300 Hz with a wide Q on Pro-Q 3.')
      penalty += 12
    }
  }

  const harsh = a.harshness_ratio
  if (harsh != null) {
    if (harsh > 0.28) {
      issues.push(`harsh — 2-5 kHz ratio ${harsh.toFixed(2)} (ear fatigue territory)`)
      fixes.push('Dynamic EQ cut at 3-4 kHz with Pro-MB, threshold around -18 dB.')
      penalty += 25
    } else if (harsh > 0.20) {
      issues.push(`mildly harsh — 2-5 kHz ratio ${harsh.toFixed(2)}`)
      fixes.push('Pull the upper-mid presence boost back by 1-2 dB.')
      penalty += 10
    }
  }

  const sib = a.sibilance_ratio
  if (sib != null) {
    if (sib > 0.22) {
      issues.push(`sibilant — 6-10 kHz ratio ${sib.toFixed(2)}, "S" sounds will stab`)
      fixes.push('Insert Pro-DS or Sibilance, target 7 kHz, threshold -6 dB.')
      penalty += 20
    } else if (sib > 0.16) {
      issues.push(`slightly sibilant — 6-10 kHz ratio ${sib.toFixed(2)}`)
      fixes.push('Gentle de-esser at 7-8 kHz with a 3 dB max gain reduction.')
      penalty += 8
    }
  }

  const air = a.tonal_bands?.air
  if (air != null) {
    if (air < -32) {
      issues.push(`dull / lacks presence — air band (10+ kHz) at ${air.toFixed(1)} dBFS`)
      fixes.push('Add Fresh Air (or a +2 dB high shelf at 12 kHz on Pro-Q 3) for openness.')
      penalty += 18
    } else if (air < -28) {
      issues.push(`slightly closed — air band at ${air.toFixed(1)} dBFS, could use openness`)
      fixes.push('+1 dB high shelf at 12 kHz, or a light pass of Fresh Air at 25%.')
      penalty += 8
    }
  }

  const claritScore = Math.max(0, Math.min(100, 100 - penalty))

  let headline: string
  if (issues.length === 0) {
    headline = 'Clear'
  } else {
    // Take the first 2-3 issue keywords and join.
    const keywords = issues.map((s) => s.split(' — ')[0].split(/[, ]/)[0])
    const unique: string[] = []
    for (const k of keywords) {
      if (!unique.find((u) => u.toLowerCase() === k.toLowerCase())) unique.push(k)
    }
    headline = unique.slice(0, 3).join(' + ')
    headline = headline.charAt(0).toUpperCase() + headline.slice(1)
  }

  return { headline, clarity_score: claritScore, issues, fixes }
}
