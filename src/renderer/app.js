// MixCoach renderer — vanilla JS. The preload bridge exposes `window.mc`.

const $ = (id) => document.getElementById(id)

// ─── Browser preview mode ───────────────────────────────────────────
// When opened in a plain browser (http://localhost:5173) instead of Electron,
// `window.mc` (the preload bridge) doesn't exist. Install a mock with a full
// sample analysis so the whole UI — especially the AI Analysis tab — renders
// with realistic data for design review. No-op inside Electron (preload sets
// window.mc before this runs).
function installPreviewMock() {
  // Sample AI response — single-quoted lines so backticks pass through as
  // literal markdown; only apostrophes are escaped.
  const SAMPLE_TEXT = [
    '## Problem 1: [MUD] Boxy low-mids',
    '**Problem:** 808 + vocal stack at `250-500 Hz`. `+2.8 dB` hotter than ref (mud `0.31` vs `0.19`).',
    '**Fix:** `Pro-Q 3` on `Insert 13`: `-2.5 dB` bell @ `310 Hz`, `Q 1.4`. `Pro-MB` on 808 `Insert 3`: `-2 dB` @ `200-350 Hz`, dynamic.',
    '**Does:** Clears the boxiness — vocal reads open like the reference.',
    '',
    '## Problem 2: [DYNAMICS] Vocal rides unevenly',
    '**Problem:** Vocal jumps front-to-back. `LRA 7.5` vs ref `5.0` — `2.5 LU` too dynamic.',
    '**Fix:** Add `CLA-2A` before `CLA-76` on `Insert 13` (`2-3 dB` leveling). Set `CLA-76`: `4:1`, atk `~3`, rel `6-7`, `3-4 dB GR`.',
    '**Does:** Vocal sits steady and glued, every line.',
    '',
    '## Problem 3: [SIBILANCE] De-esser in the wrong spot',
    '**Problem:** Esses stab. Sibilance `0.28` vs `0.18`. `Pro-DS` sits BEFORE the comp on `Insert 13`.',
    '**Fix:** Move `Pro-DS` to end of chain (after `CLA-76`). Target `7.2 kHz`, `4-5 dB`.',
    '**Does:** Comp stops re-lifting the esses you just removed.',
    '',
    '## Problem 4: [AIR] Dull + dry vocal',
    '**Problem:** Veiled, no space. Air `-30 dBFS` vs ref `-24` (`6 dB` darker).',
    '**Fix:** `Pro-Q 3`: `+2 dB` shelf @ `11 kHz`, `+2.5 dB` @ `3 kHz`. `Pro-R` on `Insert 5`: plate, `1.2 s`.',
    '**Does:** Vocal opens up and sits back in a room like the ref.',
    '',
    '## Closing the gap to "midnight_drive_master.wav"',
    '',
    '1. **Dynamics (`+2.5 LU LRA`):** two-stage vocal compression (Problem 2) + master glue.',
    '2. **Loudness (`-2.2 LU`, `-11.2` vs `-9.0`):** quieter AND peaking hotter (`-0.4` vs `-1.0 dBTP`) — a headroom problem, fixed at the master.',
    '3. **Tonal:** mud (Problem 1) and air (`-6 dB` darker — `+2 dB` shelf at `11 kHz`).',
    '4. **Width (`-0.12`, `0.22` vs `0.34`):** reference is wider — widen background sends.',
    '',
    '## Plugin chain changes',
    '- `Add Insert 13 slot 3: CLA-2A — slow leveling before CLA-76 to tame the ride (LRA 7.5 → ~5 LU)`',
    '- `Reorder Insert 13: 2 -> 6 — Pro-DS — de-ess after the compressors so they don\'t re-lift the esses`',
    '- `Setting: Insert 13 CLA-76 — ratio 4:1, attack ~3, release 6-7, 3-4 dB GR (peaks only)`',
    '- `Setting: Insert 13 Pro-Q 3 — -2.5 dB @ 310 Hz Q1.4, +2.5 dB @ 3 kHz Q1.0, +2 dB shelf @ 11 kHz`',
    '- `Add Insert 3 slot 3: Pro-MB — dynamic -2 dB at 200-350 Hz on the 808 to clear vocal mud`',
    '- `Setting: Master Pro-L 2 — ceiling -1.0 dBTP, push input ~2 dB to close the -2.2 LU loudness gap`',
    '',
    '## Final Tweaks',
    '',
    '**Lead vocal (Insert 13)**',
    '- Add `CLA-2A` (slot 3) — `Compress`, `2-3 dB` leveling',
    '- Set `CLA-76` — `4:1`, attack `~3`, release `6-7`, `3-4 dB GR`',
    '- Move `Pro-DS` to the end of the chain — target `7.2 kHz`, `4-5 dB`',
    '- `Pro-Q 3` — `-2.5 dB @ 310 Hz`, `+2.5 dB @ 3 kHz`, `+2 dB shelf @ 11 kHz`',
    '- `Saturn 2` — light tube/tape, `Mix ~15%`',
    '',
    '**Backgrounds / beat**',
    '- `Pro-MB` on 808 (Insert 3) — `-2 dB @ 200-350 Hz` dynamic',
    '- `S1 Imager` on synth/pad sends — widen `0.22 → ~0.32` (keep kick, 808, lead mono)',
    '',
    '**Master**',
    '- `SSLGChannel` — `2:1`, `~2 dB GR` to tighten LRA toward `5 LU`',
    '- `Pro-L 2` — ceiling `-1.0 dBTP`, input `+2 dB` to reach `~-9 LUFS`',
    '',
    '**Working well:** Your vocal tuning and 808 tone are genuinely solid — this is a dynamics-and-brightness fix, not a re-mix.',
    '',
    '```mixcoach-eq',
    '[{"insert":2,"slot":1,"band":2,"gainDb":-2.5,"label":"Insert 2 Pro-Q 3 — deepen the 156 Hz bell to -2.5 dB to clear the boxiness"},{"insert":2,"slot":1,"band":5,"gainDb":1.0,"q":1.4,"label":"Insert 2 Pro-Q 3 — ease the 9.6 kHz boost to +1.0 dB, tighten Q to 1.4"}]',
    '```'
  ].join('\n')

  const SAMPLE_AUDIO = {
    ok: true, source: 'local', sample_rate: 44100, bit_depth: 16,
    integrated_lufs: -11.2, true_peak_db: -0.4, loudness_range_lra: 7.5,
    clipping_detected: false, clipping_sample_count: 0,
    mono_compatible: true, phase_correlation: 0.62, stereo_width: 0.22,
    crest_factor_db: 11.2,
    tonal_bands: { sub: -16, bass: -10, low_mid: -9.5, mid: -12, high_mid: -16, air: -30 },
    dominant_band: 'low_mid', mud_ratio: 0.31, harshness_ratio: 0.16, sibilance_ratio: 0.28,
    key: 'F minor', key_confidence: 0.71, bpm: 140.0, bpm_stability_pct: 1.8, wav_path: null
  }
  const SAMPLE_REFERENCE = {
    ok: true, source: 'local', filename: 'midnight_drive_master.wav',
    reference_filename: 'midnight_drive_master.wav',
    reference_path: 'C:\\Music\\refs\\midnight_drive_master.wav',
    clipPath: 'preview', startSec: 75, durationSec: 210, reference_duration_sec: 210,
    integrated_lufs: -9.0, true_peak_db: -1.0, loudness_range_lra: 5.0,
    stereo_width: 0.34, crest_factor_db: 9.0,
    tonal_bands: { sub: -15, bass: -9, low_mid: -12.3, mid: -12, high_mid: -13, air: -24 },
    mud_ratio: 0.19, harshness_ratio: 0.20, sibilance_ratio: 0.18
  }
  const SAMPLE_COMPARISON = {
    reference_filename: 'midnight_drive_master.wav',
    lufs_diff: -2.2, true_peak_diff: 0.6, lra_diff: 2.5, stereo_width_diff: -0.12,
    crest_factor_diff: 2.2, mud_diff: 0.12, harshness_diff: -0.04, sibilance_diff: 0.10,
    tonal_band_diffs: { sub: -1, bass: -1, low_mid: 2.8, mid: 0, high_mid: -3, air: -6 },
    summary: [
      'Loudness: your mix is 2.2 LU quieter (-11.2 LUFS vs reference -9.0 LUFS)',
      'air (8-20k Hz): 6.0 dB thinner / quieter than reference',
      'Dynamics: your mix is 2.5 LU looser / less compressed than reference',
      'low-mid (250-500 Hz): 2.8 dB hotter / heavier than reference'
    ],
    fixes: [
      'Push the master 2.2 dB through Pro-L 2 (ceiling -1 dBTP) to match reference loudness.',
      'Add Fresh Air or a +1.5 dB shelf at 10 kHz on the mix bus.',
      'Add bus glue compression (SSLGChannel, 2:1, 2 dB GR) before the limiter.'
    ]
  }
  const plug = (slot, name) => ({ slot, name, enabled: true, mix: 100 })
  const ins = (index, name, plugins) => ({ index, name, volume: 0, pan: 0, muted: false, plugins })
  const SAMPLE_CHAIN = [
    { bus: 13, insert: ins(13, 'LEAD VOX', [plug(0, 'Auto-Tune Pro'), plug(1, 'Pro-DS'), plug(2, 'CLA-76'), plug(3, 'Pro-Q 3')]) },
    { bus: 16, insert: ins(16, 'DOUBLES', [plug(0, 'Pro-Q 3'), plug(1, 'CLA-2A')]) },
    { bus: 5, insert: ins(5, 'VOX VERB', []) },
    { bus: 8, insert: ins(8, 'VOX DELAY', []) }
  ]
  const SAMPLE_RESULT = {
    ok: true, text: SAMPLE_TEXT, timestamp: '2026-06-03T12:00:00.000Z',
    audio: SAMPLE_AUDIO, audioSource: 'local',
    suggestions: [
      { title: 'Low Mid Buildup', message: 'Excess energy in the 250-500hz mud zone, high pass or cut there.', severity: 'warning' },
      { title: 'Sibilance', message: 'High 6-10khz sibilance detected, consider a de-esser.', severity: 'warning' },
      { title: 'Stereo Field', message: 'Your mix is too narrow, consider widening the stereo image.', severity: 'warning' }
    ],
    flpOk: true, flpName: 'midnight_drive.flp', flpPath: 'C:\\Music\\midnight_drive.flp',
    wavPath: null,
    vocalChain: SAMPLE_CHAIN, vocalChainBuses: [13, 16, 5, 8], mode: 'both',
    vocalVerdict: {
      headline: 'Dull', clarity_score: 82,
      issues: ['dull / lacks presence — air band (10+ kHz) at -30.0 dBFS'],
      fixes: ['Add Fresh Air (or a +2 dB high shelf at 12 kHz on Pro-Q 3) for openness.']
    },
    reference: SAMPLE_REFERENCE, comparison: SAMPLE_COMPARISON
  }

  const listeners = {}
  const on = (name) => (cb) => {
    ;(listeners[name] || (listeners[name] = [])).push(cb)
    return () => {}
  }
  const emit = (name, payload) => (listeners[name] || []).forEach((cb) => cb(payload))
  let ref = SAMPLE_REFERENCE

  const parseStart = (raw) => {
    if (!raw) return SAMPLE_REFERENCE.startSec
    const s = String(raw).trim()
    if (s.includes(':')) {
      const p = s.split(':').map(Number)
      return p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2]
    }
    const n = Number(s)
    return isFinite(n) ? n : SAMPLE_REFERENCE.startSec
  }

  window.__mixcoachPreview = true
  window.mc = {
    trigger: async () => {
      emit('mc:start', { startedAt: new Date().toISOString() })
      const phases = [
        { phase: 'countdown', seconds_remaining: 3 },
        { phase: 'countdown', seconds_remaining: 2 },
        { phase: 'countdown', seconds_remaining: 1 },
        { phase: 'recording', seconds_remaining: 3 },
        { phase: 'analyzing' },
        { phase: 'flp' },
        { phase: 'gemini' }
      ]
      phases.forEach((p, i) => setTimeout(() => emit('mc:status', p), 250 * (i + 1)))
      setTimeout(() => emit('mc:result', { ...SAMPLE_RESULT, reference: ref, mode: currentMode }), 250 * (phases.length + 1))
    },
    setMode: async () => true,
    cancel: async () => true,
    hide: async () => {},
    minimize: async () => {},
    quit: async () => {},
    getLastWav: async () => null,
    chat: async (msgs) => {
      const last = msgs[msgs.length - 1]?.text || ''
      return '_(preview mode — chat is mocked)_\n\nYou asked: **' + last + '**. In the real app I would answer grounded in the analysis above, citing exact inserts and values.'
    },
    pickReference: async (startSec) => {
      ref = { ...SAMPLE_REFERENCE, startSec: parseStart(startSec) }
      return { ok: true, reference: ref }
    },
    getReference: async () => ref,
    clearReference: async () => {
      ref = null
      return true
    },
    scanPlugins: async () => ({
      available: true,
      states: [
        {
          insert: 2,
          slot: 1,
          pluginName: 'FabFilter Pro-Q 3',
          proq3: {
            plugin: 'FabFilter Pro-Q 3',
            bands: [
              { n: 2, type: 'bell', freq: '156.09 Hz', gain: '-0.47 dB', q: 1.496 },
              { n: 3, type: 'bell', freq: '362.41 Hz', gain: '+0.81 dB', q: 1.324 },
              { n: 5, type: 'bell', freq: '9625.7 Hz', gain: '+2.29 dB', q: 1.108 }
            ],
            hp: { freq: '89.5 Hz', slope: '24 dB/oct' },
            lp: null,
            output: '0.00 dB'
          }
        }
      ]
    }),
    applyProQ3: async (op) => ({
      ok: true,
      applied: [`${op.gainDb != null ? `gain → ${op.gainDb} dB` : ''}`].filter(Boolean),
      op
    }),
    onStart: on('mc:start'),
    onStatus: on('mc:status'),
    onResult: on('mc:result'),
    onError: on('mc:error'),
    onCancelled: on('mc:cancelled'),
    onMeter: on('mc:meter')
  }

  // Visible badge + theme switcher + auto-load the sample so tabs populate.
  const THEME_CLASSES = ['theme-aurora', 'theme-console', 'theme-paper', 'theme-matrix']
  const THEMES = [
    ['', 'Default'],
    ['theme-aurora', '1 · Aurora'],
    ['theme-console', '2 · Console'],
    ['theme-paper', '3 · Paper'],
    ['theme-matrix', '4 · Matrix']
  ]
  const applyTheme = (cls) => {
    document.body.classList.remove(...THEME_CLASSES)
    if (cls) document.body.classList.add(cls)
    try { localStorage.setItem('mixcoach.previewTheme', cls) } catch {}
  }
  const showChrome = () => {
    if (!document.querySelector('.preview-banner')) {
      const b = document.createElement('div')
      b.className = 'preview-banner'
      b.textContent = 'DESIGN PREVIEW — mock data'
      document.body.appendChild(b)
    }
    if (!document.querySelector('.preview-themes')) {
      let saved = ''
      try { saved = localStorage.getItem('mixcoach.previewTheme') || '' } catch {}
      applyTheme(saved)
      let savedLayout = 'l4'
      try { savedLayout = localStorage.getItem('mixcoach.aiLayout') || 'l4' } catch {}
      window.__aiLayout = savedLayout

      const LAYOUTS = [
        ['classic', 'Classic'],
        ['l1', '1 · Cards'],
        ['l2', '2 · Ledger'],
        ['l3', '3 · Split'],
        ['l4', '4 · Steps']
      ]
      const wrap = document.createElement('div')
      wrap.className = 'preview-themes'
      wrap.innerHTML =
        '<div class="pt-title">THEME</div>' +
        THEMES.map(([cls, label]) => `<button data-theme="${cls}">${label}</button>`).join('') +
        '<div class="pt-title pt-title-2">AI LAYOUT</div>' +
        LAYOUTS.map(([id, label]) => `<button data-layout="${id}">${label}</button>`).join('')
      document.body.appendChild(wrap)

      const syncTheme = () =>
        wrap.querySelectorAll('[data-theme]').forEach((x) => {
          let t = ''
          try { t = localStorage.getItem('mixcoach.previewTheme') || '' } catch {}
          x.classList.toggle('active', x.dataset.theme === t)
        })
      const syncLayout = () =>
        wrap.querySelectorAll('[data-layout]').forEach((x) =>
          x.classList.toggle('active', x.dataset.layout === (window.__aiLayout || 'classic'))
        )
      wrap.querySelectorAll('[data-theme]').forEach((b) =>
        b.addEventListener('click', () => {
          applyTheme(b.dataset.theme)
          syncTheme()
        })
      )
      wrap.querySelectorAll('[data-layout]').forEach((b) =>
        b.addEventListener('click', () => {
          window.__aiLayout = b.dataset.layout
          try { localStorage.setItem('mixcoach.aiLayout', b.dataset.layout) } catch {}
          syncLayout()
          // Jump to the AI tab so the change is immediately visible.
          if (typeof setTab === 'function') setTab('ai')
          else if (typeof renderCurrentView === 'function') renderCurrentView()
        })
      )
      syncTheme()
      syncLayout()
    }
  }
  if (document.body) showChrome()
  else document.addEventListener('DOMContentLoaded', showChrome)
  // Deliver the sample result after app.js finishes wiring its listeners.
  setTimeout(() => emit('mc:result', { ...SAMPLE_RESULT, mode: currentMode }), 60)
}

if (!window.mc) installPreviewMock()

// ─── App theme (Settings tab) ───────────────────────────────────────
// Three user-selectable themes. Aurora is the default. Persisted to
// localStorage and applied app-wide via a body class. The browser preview
// theme switcher (preview only) is separate and owns the body class there.
const APP_THEME_KEY = 'mixcoach.theme'
const APP_THEMES = [
  { id: 'aurora', cls: 'theme-aurora', name: 'Aurora', desc: 'Synthwave glass — neon magenta + cyan on deep violet.', def: true },
  { id: 'matrix', cls: 'theme-matrix', name: 'Matrix', desc: 'Cyber terminal — electric blue monospace on black.' },
  { id: 'fl', cls: '', name: 'FL', desc: 'The original MixCoach look — teal on charcoal.' }
]
const ALL_THEME_CLASSES = ['theme-aurora', 'theme-console', 'theme-paper', 'theme-matrix']

function getAppTheme() {
  try {
    return localStorage.getItem(APP_THEME_KEY) || 'aurora'
  } catch {
    return 'aurora'
  }
}
function applyAppTheme(id) {
  const theme = APP_THEMES.find((t) => t.id === id) || APP_THEMES[0]
  document.body.classList.remove(...ALL_THEME_CLASSES)
  if (theme.cls) document.body.classList.add(theme.cls)
  try { localStorage.setItem(APP_THEME_KEY, theme.id) } catch {}
}

function renderSettingsTab(target) {
  const current = getAppTheme()
  const cards = APP_THEMES.map(
    (t) => `
      <button class="set-theme sw-${t.id} ${t.id === current ? 'active' : ''}" data-theme-id="${t.id}">
        <span class="set-swatch"></span>
        <span class="set-theme-info">
          <span class="set-theme-name">${escapeHtml(t.name)}${t.def ? '<em> · default</em>' : ''}</span>
          <span class="set-theme-desc">${escapeHtml(t.desc)}</span>
        </span>
        <span class="set-check">✓</span>
      </button>`
  ).join('')
  target.innerHTML = `
    <div class="settings-stack">
      <div class="widget">
        <h3 class="widget-h">Appearance <span class="widget-sub">theme</span></h3>
        <div class="widget-body"><div class="set-theme-list">${cards}</div></div>
      </div>
    </div>`
  target.querySelectorAll('[data-theme-id]').forEach((b) =>
    b.addEventListener('click', () => {
      applyAppTheme(b.dataset.themeId)
      renderSettingsTab(target)
    })
  )
}

// Apply the saved theme on startup (real app only — the browser preview's
// own switcher controls the body class there).
if (!window.__mixcoachPreview) applyAppTheme(getAppTheme())

// ─── Analysis mode (vocal / beat / both) ────────────────────────────
const MODE_KEY = 'mixcoach.mode'
const VALID_MODES = ['vocal', 'beat', 'both']
let currentMode = (() => {
  try {
    const stored = localStorage.getItem(MODE_KEY)
    if (stored && VALID_MODES.includes(stored)) return stored
  } catch {
    // localStorage can throw in restricted contexts — fall through
  }
  return 'both'
})()

function applyModeUI() {
  // Update every mode-opt button on the page (the header one + any inline
  // copies inside the empty-state).
  document.querySelectorAll('.mode-opt').forEach((btn) => {
    const isActive = btn.dataset.mode === currentMode
    btn.classList.toggle('active', isActive)
    btn.setAttribute('aria-checked', isActive ? 'true' : 'false')
  })
}

function setMode(mode) {
  if (!VALID_MODES.includes(mode)) return
  currentMode = mode
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    // ignore
  }
  applyModeUI()
  // Push the new mode to main so an empty (no-analysis-yet) chat is still
  // scoped correctly and reflects toggles between runs.
  window.mc.setMode?.(mode).catch(() => {})
}

// ─── View state ─────────────────────────────────────────────────────
// pipelineState drives what the main content area shows:
//   'idle'    → empty state (or last result, if we have one)
//   'loading' → spinner + status text
//   'error'   → error message + retry
//   'done'    → render the active tab against `lastResult`
let pipelineState = 'idle'
let lastStatus = null
let lastError = null
let lastResult = null
let cancelInFlight = false

let currentTab = 'dashboard'
const TAB_LABELS = {
  dashboard: 'Dashboard',
  ai: 'AI Analysis',
  extras: 'Extras',
  chain: 'Chain Edits',
  chat: 'Chat',
  keybpm: 'Key & BPM',
  compare: 'Compare',
  settings: 'Settings'
}

function setTab(name) {
  if (!TAB_LABELS[name]) return
  currentTab = name
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name)
  })
  const bc = $('bc-section')
  if (bc) bc.textContent = TAB_LABELS[name].toUpperCase()
  renderCurrentView()
}

function statusLine(s) {
  if (!s || typeof s !== 'object') return { text: 'Working…', detail: '' }
  switch (s.phase) {
    case 'countdown':
      return {
        text: 'Get ready…',
        detail: typeof s.seconds_remaining === 'number' ? `${s.seconds_remaining}…` : ''
      }
    case 'recording':
      return {
        text: 'Recording 15 seconds of audio…',
        detail: typeof s.seconds_remaining === 'number' ? `${s.seconds_remaining}s remaining` : ''
      }
    case 'analyzing':
      return { text: 'Analyzing audio locally…', detail: 'pyloudnorm + librosa' }
    case 'flp':
      return { text: 'Parsing FL Studio project…', detail: '' }
    case 'gemini':
      if (s.retry && typeof s.retry === 'object') {
        const r = s.retry
        const waitSec = Math.round((r.waitMs || 0) / 1000)
        const label = r.status === 503 ? 'Gemini busy (spike in usage)' : r.status ? `Gemini busy (${r.status})` : 'Connection hiccup'
        return {
          text: `${label} — retrying…`,
          detail: `attempt ${r.attempt} of ${r.maxAttempts}${waitSec ? `, retrying in ${waitSec}s` : ''}`
        }
      }
      return { text: 'Generating AI analysis…', detail: '' }
    case 'busy':
      return { text: 'Already analyzing… please wait.', detail: '' }
    case 'done':
      return { text: 'Done', detail: '' }
    default:
      return { text: String(s.phase ?? 'Working…'), detail: '' }
  }
}

// ─── Minimal markdown → HTML renderer ───────────────────────────────
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderMarkdown(md) {
  const lines = md.split('\n')
  const out = []
  let inList = false
  let inCode = false
  let codeBuf = []

  const closeList = () => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }

  const renderInline = (text) => {
    let s = escapeHtml(text)
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
    return s
  }

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (inCode) {
      if (line.trim().startsWith('```')) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
        codeBuf = []
        inCode = false
      } else {
        codeBuf.push(line)
      }
      continue
    }
    if (line.trim().startsWith('```')) {
      closeList()
      inCode = true
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      closeList()
      const level = Math.min(h[1].length + 1, 6)
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`)
      continue
    }
    const bullet = /^[\s]*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${renderInline(bullet[1])}</li>`)
      continue
    }
    if (!line.trim()) {
      closeList()
      out.push('')
      continue
    }
    closeList()
    out.push(`<p>${renderInline(line)}</p>`)
  }
  if (inList) out.push('</ul>')
  if (inCode) {
    out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
  }
  return out.join('\n')
}

function fmtTimestamp(iso) {
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso
  }
}

// ─── Tonal profile SVG ──────────────────────────────────────────────
// Target dBFS curve for a competitive melodic-trap / hip-hop master.
// `ideal` is the rough reference for the dashed overlay line; `min` is the
// "too low" threshold (bars below it color blue).
const BAND_ORDER = ['sub', 'bass', 'low_mid', 'mid', 'high_mid', 'air']
const BAND_LABEL = {
  sub: 'sub',
  bass: 'bass',
  low_mid: 'low mid',
  mid: 'mid',
  high_mid: 'high mid',
  air: 'air'
}
const BAND_TARGET = {
  sub: { ideal: -14, min: -22 },
  bass: { ideal: -8, min: -14 }, // should be tallest in this genre
  low_mid: { ideal: -16, min: -26 },
  mid: { ideal: -14, min: -22 },
  high_mid: { ideal: -18, min: -28 },
  air: { ideal: -22, min: -34 }
}

// Map flagged-issue titles to the band(s) they implicate.
const FLAG_TO_BANDS = {
  'Low Mid Buildup': ['low_mid'],
  Harshness: ['high_mid'],
  Sibilance: ['high_mid', 'air']
}

function flaggedBandSet(suggestions) {
  const set = new Set()
  for (const s of suggestions || []) {
    const bands = FLAG_TO_BANDS[s.title]
    if (bands) bands.forEach((b) => set.add(b))
  }
  return set
}

function renderTonalChart(audio, suggestions) {
  const bands = audio?.tonal_bands
  if (!bands || typeof bands !== 'object') return ''

  const W = 440
  const H = 200
  const padL = 38
  const padR = 12
  const padT = 14
  const padB = 42
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const yMin = -60
  const yMax = 0
  const yToPx = (v) => {
    const clamped = Math.max(yMin, Math.min(yMax, v))
    return padT + ((yMax - clamped) / (yMax - yMin)) * plotH
  }
  const slotW = plotW / BAND_ORDER.length
  const barW = slotW * 0.7

  const flagged = flaggedBandSet(suggestions)
  const parts = []
  parts.push(
    `<svg viewBox="0 0 ${W} ${H}" class="tonal-chart" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Tonal profile">`
  )
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#141414"/>`)

  // gridlines + y-axis labels every 12 dB
  for (let v = 0; v >= -60; v -= 12) {
    const y = yToPx(v)
    parts.push(
      `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#262626" stroke-width="1"/>`
    )
    parts.push(
      `<text x="${padL - 6}" y="${y + 3}" fill="#666" font-size="9" text-anchor="end" font-family="Consolas, monospace">${v}</text>`
    )
  }

  const targetPts = []
  BAND_ORDER.forEach((b, i) => {
    const raw = bands[b]
    const v = typeof raw === 'number' && isFinite(raw) ? raw : -60
    const target = BAND_TARGET[b]
    const x = padL + i * slotW + (slotW - barW) / 2
    const yTop = yToPx(v)
    const yBot = yToPx(yMin)

    let color = '#44ff88' // optimal
    if (flagged.has(b)) color = '#ff4444'
    else if (v < target.min) color = '#4488ff'

    parts.push(
      `<rect x="${x}" y="${yTop}" width="${barW}" height="${Math.max(0, yBot - yTop)}" fill="${color}" rx="2"/>`
    )
    parts.push(
      `<text x="${x + barW / 2}" y="${yTop - 4}" fill="#d0d0d0" font-size="10" text-anchor="middle" font-family="Consolas, monospace">${v.toFixed(1)}</text>`
    )
    parts.push(
      `<text x="${x + barW / 2}" y="${H - padB + 14}" fill="#bbb" font-size="10" text-anchor="middle">${BAND_LABEL[b]}</text>`
    )
    targetPts.push(`${padL + i * slotW + slotW / 2},${yToPx(target.ideal)}`)
  })

  // Reference target curve for the genre
  parts.push(
    `<polyline points="${targetPts.join(' ')}" fill="none" stroke="#ff6b35" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.85"/>`
  )
  parts.push(
    `<text x="${W - padR}" y="${H - padB + 30}" fill="#888" font-size="10" text-anchor="end">— — generic modern reference curve</text>`
  )
  parts.push('</svg>')
  return parts.join('')
}

// ─── Vocal Chain ────────────────────────────────────────────────────
function renderVocalChain(chain, buses) {
  if (!Array.isArray(chain) || chain.length === 0) return ''

  // Derive the flow header from the actual resolved chain (not the static
  // VOCAL_CHAIN_BUSES preference list) so the arrow always matches the tabs
  // and panels below — e.g. when extractVocalChain auto-detects real inserts.
  const flow = chain
    .map((c) => `Insert ${c.bus}`)
    .join(' <span class="chain-arrow">→</span> ')

  const tabs = chain
    .map((step, i) => {
      const cls = i === 0 ? 'chain-tab active' : 'chain-tab'
      const sel = i === 0 ? 'true' : 'false'
      return `<button class="${cls}" data-chain-tab="${i}" role="tab" aria-selected="${sel}">Insert ${step.bus}</button>`
    })
    .join('')

  const panels = chain
    .map((step, i) => {
      const ins = step.insert
      const header = `Insert ${step.bus}`
      const panelCls = i === 0 ? 'chain-step-panel active' : 'chain-step-panel'
      if (!ins) {
        return `
          <div class="${panelCls}" data-chain-panel="${i}">
            <div class="chain-step chain-step-missing">
              <div class="chain-step-h">
                <span class="chain-step-idx">${i + 1}.</span>
                <span class="chain-step-name">${escapeHtml(header)}</span>
                <span class="chain-step-status">not in FLP</span>
              </div>
            </div>
          </div>`
      }
      const name = ins.name ?? '(unnamed)'
      const vol = ins.volume == null ? '—' : ins.volume.toFixed(2)
      const pan = ins.pan == null ? null : ins.pan.toFixed(2)
      const muted = ins.muted === true
      // Only enabled plugins influence the audio; bypassed slots are hidden.
      // Slot numbers are 1-indexed to match what FL Studio displays.
      const plugins = (ins.plugins || [])
        .filter((p) => p.enabled === true)
        .slice()
        .sort((a, b) => a.slot - b.slot)
      const pluginHtml =
        plugins.length === 0
          ? `<div class="chain-empty">(no enabled plugins)</div>`
          : `<ol class="chain-plugins">${plugins
              .map((p) => {
                const mix =
                  typeof p.mix === 'number' && isFinite(p.mix)
                    ? `<span class="mix">${p.mix.toFixed(0)}%</span>`
                    : ''
                return `<li>
                    <span class="slot">slot ${p.slot + 1}</span>
                    <span class="plugin-name">${escapeHtml(p.name ?? '(unknown)')}</span>
                    ${mix}
                  </li>`
              })
              .join('')}</ol>`
      return `
        <div class="${panelCls}" data-chain-panel="${i}">
          <div class="chain-step ${muted ? 'chain-step-muted' : ''}">
            <div class="chain-step-h">
              <span class="chain-step-idx">${i + 1}.</span>
              <span class="chain-step-name">${escapeHtml(header)} — ${escapeHtml(name)}</span>
              <span class="chain-step-meta">vol ${vol}${pan != null ? ` · pan ${pan}` : ''}${muted ? ' · MUTED' : ''}</span>
            </div>
            ${pluginHtml}
          </div>
        </div>`
    })
    .join('')

  return `
    <div class="chain-flow">${flow}</div>
    <div class="chain-tabs" role="tablist">${tabs}</div>
    <div class="chain-steps">${panels}</div>`
}

function wireChainTabs(root) {
  const tabs = root.querySelectorAll('[data-chain-tab]')
  const panels = root.querySelectorAll('[data-chain-panel]')
  if (!tabs.length) return
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const idx = tab.dataset.chainTab
      tabs.forEach((t) => {
        const isActive = t.dataset.chainTab === idx
        t.classList.toggle('active', isActive)
        t.setAttribute('aria-selected', isActive ? 'true' : 'false')
      })
      panels.forEach((p) => {
        p.classList.toggle('active', p.dataset.chainPanel === idx)
      })
    })
  })
}

// ─── Reference Track + Comparison ───────────────────────────────────
// The reference is a finished, mastered song the user wants to sound
// like. It's analyzed once and cached in main; every Analyze run pulls
// a fresh comparison against it.

let cachedReference = null

async function refreshReferenceCard() {
  try {
    cachedReference = await window.mc.getReference?.()
  } catch {
    cachedReference = null
  }
  renderReferenceCard()
}

function renderReferenceCard() {
  // Lazy-look up the element each time — the Compare tab re-creates
  // #reference-card on tab switch, so a cached ref would go stale.
  const referenceCard = $('reference-card')
  if (!referenceCard) return
  if (!cachedReference || !cachedReference.ok) {
    referenceCard.innerHTML = `
      <div class="ref-empty">
        <div class="ref-empty-h">Reference Track</div>
        <div class="ref-empty-msg">Upload a finished, mastered track and MixCoach will compare every analysis against it so the AI can tell you exactly how to close the gap. MixCoach analyzes a 15-second segment and lets the AI <em>hear</em> it.</div>
        ${renderRefStartField()}
        <button id="btn-pick-ref" type="button" class="btn-ref-pick">Upload reference</button>
      </div>`
    const btn = $('btn-pick-ref')
    btn?.addEventListener('click', pickReference)
    return
  }
  const r = cachedReference
  const fmt = (v, unit = '') => (v == null ? '—' : `${v.toFixed(2)}${unit ? ' ' + unit : ''}`)
  const tonalRow = r.tonal_bands
    ? Object.entries(r.tonal_bands)
        .map(([band, db]) => `<span><strong>${band}</strong> ${typeof db === 'number' ? db.toFixed(1) : '—'} dBFS</span>`)
        .join('')
    : ''
  referenceCard.innerHTML = `
    <div class="ref-set">
      <div class="ref-set-head">
        <div>
          <div class="ref-label">Reference</div>
          <div class="ref-name" title="${escapeHtml(r.reference_path ?? '')}">${escapeHtml(r.filename ?? r.reference_filename ?? 'reference')}</div>
        </div>
        <div class="ref-actions">
          <button id="btn-replace-ref" type="button">Replace</button>
          <button id="btn-clear-ref" type="button" class="ref-clear">Clear</button>
        </div>
      </div>
      <div class="ref-stats">
        <span><strong>${fmt(r.integrated_lufs, 'LUFS')}</strong></span>
        <span><strong>${fmt(r.true_peak_db, 'dBTP')}</strong> peak</span>
        <span><strong>${fmt(r.loudness_range_lra, 'LU')}</strong> LRA</span>
        <span><strong>${fmt(r.stereo_width)}</strong> width</span>
      </div>
      ${tonalRow ? `<div class="ref-bands">${tonalRow}</div>` : ''}
      <div class="ref-clip-meta">${refClipMeta(r)}</div>
      ${renderRefStartField(r.startSec)}
    </div>`
  $('btn-replace-ref')?.addEventListener('click', pickReference)
  $('btn-clear-ref')?.addEventListener('click', clearReference)
}

// Start-time input: the producer types where the 15s analysis window begins
// (`1:30` or `90`). Empty → Python defaults to 50% into the file.
function renderRefStartField(currentSec) {
  const hint =
    currentSec != null && isFinite(currentSec)
      ? `currently ${fmtClock(currentSec)} — change + re-upload to move it`
      : 'optional · e.g. 1:30 or 90 · blank = middle of the song'
  return `
    <div class="ref-start-field">
      <label for="ref-start">Analyze from</label>
      <input id="ref-start" type="text" inputmode="numeric" placeholder="mm:ss" autocomplete="off" />
      <span class="ref-start-hint">${hint}</span>
    </div>`
}

function refClipMeta(r) {
  if (r.startSec == null) return ''
  const dur = r.reference_duration_sec
  const where = `15s segment from ${fmtClock(r.startSec)}`
  return typeof dur === 'number' && isFinite(dur) ? `${where} of ${fmtClock(dur)}` : where
}

function fmtClock(totalSec) {
  const s = Math.max(0, Math.round(totalSec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

async function pickReference() {
  const btn = $('btn-pick-ref') || $('btn-replace-ref')
  // Read the start-time the producer typed before we replace the DOM.
  const startSec = $('ref-start')?.value?.trim() || undefined
  if (btn) {
    btn.disabled = true
    btn.textContent = 'Analyzing…'
  }
  try {
    const res = await window.mc.pickReference?.(startSec)
    if (!res || res.cancelled) return
    if (!res.ok) {
      alert(`Reference failed: ${res.error || 'unknown error'}`)
      return
    }
    cachedReference = res.reference
    renderReferenceCard()
  } catch (err) {
    alert(`Reference failed: ${err?.message ?? err}`)
  } finally {
    // renderReferenceCard already replaced the DOM, so re-look up the
    // button by id (might be gone) and restore state if it still exists.
    const stillThere = $('btn-pick-ref')
    if (stillThere) {
      stillThere.disabled = false
      stillThere.textContent = 'Upload reference'
    }
  }
}

async function clearReference() {
  try {
    await window.mc.clearReference?.()
  } catch {
    // ignore
  }
  cachedReference = null
  renderReferenceCard()
}

function renderComparison(comparison) {
  if (!comparison) return ''
  const summaryItems = (comparison.summary || [])
    .map((s) => `<li>${escapeHtml(s)}</li>`)
    .join('')
  const fixItems = (comparison.fixes || [])
    .map((f) => `<li>${escapeHtml(f)}</li>`)
    .join('')
  const bars = renderComparisonBars(comparison)
  return `
    <div class="comp">
      <div class="comp-head">
        <div class="comp-label">Target</div>
        <div class="comp-target">${escapeHtml(comparison.reference_filename)}</div>
      </div>
      ${bars}
      ${summaryItems ? `<div class="comp-col-h">Biggest gaps</div><ul class="comp-list">${summaryItems}</ul>` : '<div class="comp-clean">Your mix already matches the reference on every measured dimension.</div>'}
      ${fixItems ? `<div class="comp-col-h">Suggested moves to close the gap</div><ul class="comp-list">${fixItems}</ul>` : ''}
    </div>`
}

function renderComparisonBars(comparison) {
  // Visual: one horizontal bar per dimension showing the deviation from
  // the reference (negative = below, positive = above). Centered at 0.
  const dims = [
    { key: 'lufs_diff', label: 'Loudness', unit: 'LU', scale: 6 },
    { key: 'true_peak_diff', label: 'Peak', unit: 'dB', scale: 4 },
    { key: 'lra_diff', label: 'Dynamics (LRA)', unit: 'LU', scale: 6 },
    { key: 'stereo_width_diff', label: 'Stereo width', unit: '', scale: 0.3 }
  ]
  const rows = dims
    .map((d) => {
      const v = comparison[d.key]
      if (v == null || !isFinite(v)) return ''
      const clamped = Math.max(-d.scale, Math.min(d.scale, v))
      const pct = (clamped / d.scale) * 50 // -50..+50%
      const fillLeft = pct < 0 ? `${50 + pct}%` : '50%'
      const fillWidth = `${Math.abs(pct)}%`
      const cls = Math.abs(v) < d.scale * 0.15 ? 'good' : Math.abs(v) < d.scale * 0.4 ? 'warn' : 'bad'
      const sign = v > 0 ? '+' : ''
      return `
        <div class="comp-bar-row">
          <div class="comp-bar-label">${escapeHtml(d.label)}</div>
          <div class="comp-bar-track">
            <div class="comp-bar-center"></div>
            <div class="comp-bar-fill comp-bar-fill-${cls}" style="left:${fillLeft}; width:${fillWidth};"></div>
          </div>
          <div class="comp-bar-value">${sign}${v.toFixed(2)}${d.unit ? ' ' + d.unit : ''}</div>
        </div>`
    })
    .join('')
  if (!rows) return ''
  return `<div class="comp-bars">${rows}<div class="comp-bars-legend"><span>↓ below reference</span><span>= reference</span><span>above reference ↑</span></div></div>`
}

// ─── Vocal Clarity Verdict ──────────────────────────────────────────
function verdictTone(score) {
  if (score >= 80) return 'good'
  if (score >= 55) return 'warn'
  return 'bad'
}

function renderVocalVerdict(verdict, mode) {
  if (!verdict || mode === 'beat') return ''
  const tone = verdictTone(verdict.clarity_score)
  const issues = (verdict.issues || [])
    .map((i) => `<li>${escapeHtml(i)}</li>`)
    .join('')
  const fixes = (verdict.fixes || [])
    .map((f) => `<li>${escapeHtml(f)}</li>`)
    .join('')
  const issuesBlock = issues
    ? `<div class="verdict-col"><div class="verdict-col-h">What's hurting clarity</div><ul>${issues}</ul></div>`
    : `<div class="verdict-col verdict-clean"><div class="verdict-col-h">Vocal reads clean</div><div class="verdict-clean-msg">Mud, harshness, sibilance, and air band are all in pocket. Nothing flagged.</div></div>`
  const fixesBlock = fixes
    ? `<div class="verdict-col"><div class="verdict-col-h">Quick fixes</div><ul>${fixes}</ul></div>`
    : ''
  return `
    <div class="verdict verdict-${tone}">
      <div class="verdict-head">
        <div class="verdict-headline">${escapeHtml(verdict.headline)}</div>
        <div class="verdict-score">clarity <strong>${verdict.clarity_score}</strong>/100</div>
      </div>
      <div class="verdict-cols">
        ${issuesBlock}
        ${fixesBlock}
      </div>
    </div>`
}

// ─── Suggested Changes ──────────────────────────────────────────────
function renderSuggestions(suggestions) {
  if (!suggestions || suggestions.length === 0) {
    return `<div class="no-issues">No major issues detected</div>`
  }
  return suggestions
    .map(
      (s) => `
        <div class="suggestion suggestion-${escapeHtml(s.severity)}" data-title="${escapeHtml(s.title)}">
          <button class="suggestion-head" type="button" aria-expanded="false">
            <span class="suggestion-dot"></span>
            <span class="suggestion-title">${escapeHtml(s.title)}</span>
            <span class="suggestion-sev">${escapeHtml(s.severity)}</span>
            <span class="suggestion-chevron">▸</span>
          </button>
          <div class="suggestion-body">${escapeHtml(s.message)}</div>
        </div>`
    )
    .join('')
}

function wireSuggestions(container) {
  container.querySelectorAll('.suggestion').forEach((el) => {
    const head = el.querySelector('.suggestion-head')
    head.addEventListener('click', () => {
      const wasExpanded = el.classList.toggle('expanded')
      head.setAttribute('aria-expanded', wasExpanded ? 'true' : 'false')
    })
  })
}

// ─── Integrated Chat ────────────────────────────────────────────────
// Chat with the same Gemini engineer, grounded in the current session
// context (FLP + audio + suggestions + vocal chain + the analysis above).
// The UI is inspired by the shadcn `chatgpt-prompt-input` — rounded
// prompt box, auto-grow textarea, circular send button — but built in
// vanilla JS to fit the existing renderer.

let chatHistory = []
let chatBusy = false

function renderChatSection() {
  return `
    <section class="result-section chat-section">
      <h3 class="section-h">Ask the Engineer</h3>
      <div id="chat-messages" class="chat-messages"></div>
      <form id="chat-form" class="chat-form" autocomplete="off">
        <div class="prompt-box">
          <textarea
            id="chat-input"
            class="prompt-textarea"
            rows="1"
            placeholder="Ask anything about this mix…"
          ></textarea>
          <div class="prompt-row">
            <span class="prompt-hint">Context: this analysis</span>
            <button
              id="chat-send"
              class="prompt-send"
              type="submit"
              disabled
              aria-label="Send message"
              title="Send"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5.25L12 18.75" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M18.75 12L12 5.25L5.25 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      </form>
    </section>`
}

function renderChatMessages() {
  const wrap = document.getElementById('chat-messages')
  if (!wrap) return
  if (!chatHistory.length && !chatBusy) {
    wrap.innerHTML = `<div class="chat-empty">Ask a follow-up about the analysis above — the engineer can see your FLP, audio measurements, flagged issues, and prior advice.</div>`
    return
  }
  const bubbles = chatHistory
    .map((m) => {
      const cls = m.role === 'user' ? 'chat-msg chat-msg-user' : 'chat-msg chat-msg-assistant'
      const html = m.role === 'assistant' ? renderMarkdown(m.text) : escapeHtml(m.text).replace(/\n/g, '<br>')
      return `<div class="${cls}"><div class="chat-bubble">${html}</div></div>`
    })
    .join('')
  const pending = chatBusy
    ? `<div class="chat-msg chat-msg-assistant"><div class="chat-bubble chat-bubble-pending"><span class="chat-dots"><span></span><span></span><span></span></span></div></div>`
    : ''
  wrap.innerHTML = bubbles + pending
  wrap.scrollTop = wrap.scrollHeight
}

function autoGrowTextarea(ta) {
  ta.style.height = 'auto'
  ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'
}

async function sendChat(text) {
  if (chatBusy) return
  const trimmed = text.trim()
  if (!trimmed) return
  chatHistory.push({ role: 'user', text: trimmed })
  chatBusy = true
  renderChatMessages()
  try {
    if (typeof window.mc.chat !== 'function') {
      // The built preload bundle is stale (the chat method was added in a
      // later edit). Preload changes can't HMR — Electron loads it once at
      // window creation. Tell the user exactly what to do.
      throw new Error(
        'Chat preload not loaded. Fully quit MixCoach and run `npm run dev` again — preload changes require a restart.'
      )
    }
    const reply = await window.mc.chat(chatHistory)
    chatHistory.push({ role: 'assistant', text: String(reply ?? '').trim() || '(empty response)' })
  } catch (err) {
    chatHistory.push({
      role: 'assistant',
      text: `_Error: ${err?.message ?? String(err)}_`
    })
  } finally {
    chatBusy = false
    renderChatMessages()
  }
}

function wireChat(container) {
  const form = container.querySelector('#chat-form')
  const input = container.querySelector('#chat-input')
  const send = container.querySelector('#chat-send')
  if (!form || !input || !send) return

  const updateSendState = () => {
    send.disabled = chatBusy || input.value.trim().length === 0
  }

  input.addEventListener('input', () => {
    autoGrowTextarea(input)
    updateSendState()
  })
  input.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter inserts a newline (same as the shadcn ref).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      form.requestSubmit()
    }
  })
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = input.value
    input.value = ''
    autoGrowTextarea(input)
    updateSendState()
    await sendChat(text)
    updateSendState()
  })
  updateSendState()
}

// ─── Trigger / error helpers ────────────────────────────────────────
async function trigger() {
  pipelineState = 'loading'
  lastStatus = { phase: 'countdown', seconds_remaining: 3 }
  lastError = null
  renderCurrentView()
  try {
    await window.mc.trigger(currentMode)
  } catch (err) {
    showError(String(err?.message ?? err))
  }
}

function showError(msg) {
  pipelineState = 'error'
  lastError = msg
  renderCurrentView()
}

// ─── Top-level view router ──────────────────────────────────────────
function renderCurrentView() {
  const target = $('tab-content')
  if (!target) return

  if (pipelineState === 'loading') {
    target.innerHTML = renderLoading()
    return
  }
  if (pipelineState === 'error') {
    target.innerHTML = renderError()
    $('btn-retry')?.addEventListener('click', () => trigger())
    return
  }
  if (!lastResult) {
    // Compare (reference picker) and Settings are usable BEFORE any analysis.
    if (currentTab === 'compare') {
      renderCompareTab(target, { comparison: null })
      return
    }
    if (currentTab === 'settings') {
      renderSettingsTab(target)
      return
    }
    // Plugins tab reads live from FL — usable before any analysis.
    if (currentTab === 'plugins') {
      renderPluginsTab(target, null)
      return
    }
    target.innerHTML = renderEmpty()
    target.querySelectorAll('.mode-opt').forEach((btn) => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode))
    })
    target.querySelector('#btn-empty-analyze')?.addEventListener('click', () => trigger())
    target.querySelector('#btn-empty-reference')?.addEventListener('click', () => setTab('compare'))
    applyModeUI()
    return
  }

  // Have a result → render the active tab.
  switch (currentTab) {
    case 'dashboard':
      renderDashboardTab(target, lastResult)
      break
    case 'ai':
      renderAITab(target, lastResult)
      injectApplyPanel(target)
      break
    case 'extras':
      renderExtrasTab(target, lastResult)
      break
    case 'chain':
      renderChainTab(target, lastResult)
      break
    case 'chat':
      renderChatTab(target, lastResult)
      break
    case 'keybpm':
      renderKeyBpmTab(target, lastResult)
      break
    case 'compare':
      renderCompareTab(target, lastResult)
      break
    case 'plugins':
      renderPluginsTab(target, lastResult)
      break
    case 'settings':
      renderSettingsTab(target)
      break
    default:
      renderPlaceholder(target, currentTab, '')
  }
}

// ─── Plugins tab (live FabFilter EQ) + Phase 5 apply ────────────────────
// Gemini emits applyable moves in a ```mixcoach-eq fenced JSON block.
function parseEqOps(text) {
  if (!text) return []
  const m = text.match(/```mixcoach-eq\s*([\s\S]*?)```/i)
  if (!m) return []
  try {
    const arr = JSON.parse(m[1].trim())
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (o) =>
        o &&
        typeof o.insert === 'number' &&
        typeof o.slot === 'number' &&
        typeof o.band === 'number'
    )
  } catch {
    return []
  }
}

function describeOp(o) {
  const bits = [`Insert ${o.insert} · Band ${o.band}`]
  if (o.gainDb != null) bits.push(`${o.gainDb > 0 ? '+' : ''}${o.gainDb} dB`)
  if (o.freqHz != null) bits.push(`@ ${o.freqHz} Hz`)
  if (o.q != null) bits.push(`Q ${o.q}`)
  return bits.join(' ')
}

function renderApplyPanel(ops) {
  if (!ops.length) return ''
  return `
    <div class="apply-panel">
      <div class="apply-title">⚡ Suggested EQ moves — click Apply to set it in FL</div>
      ${ops
        .map(
          (o, i) => `
        <div class="apply-row">
          <div class="apply-label">${escapeHtml(o.label || describeOp(o))}</div>
          <button class="btn-apply" data-op="${i}" type="button" title="Writes this move into Pro-Q 3 on insert ${o.insert}">Apply</button>
        </div>`
        )
        .join('')}
      <div class="apply-note">Nothing is written until you click. Modifies existing bands only.</div>
    </div>`
}

let __eqOps = []
function wireApplyButtons(scope) {
  __eqOps = parseEqOps(lastResult?.text)
  scope.querySelectorAll('.btn-apply').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const op = __eqOps[Number(btn.dataset.op)]
      if (!op || !window.mc?.applyProQ3) return
      btn.disabled = true
      btn.textContent = 'Applying…'
      try {
        const res = await window.mc.applyProQ3(op)
        if (res && res.ok) {
          btn.textContent = '✓ Applied'
          btn.classList.add('applied')
          if ($('plugins-body')) setTimeout(loadLivePlugins, 400)
        } else {
          btn.textContent = 'Failed'
          btn.title = res?.error || 'unknown error'
          btn.disabled = false
        }
      } catch (e) {
        btn.textContent = 'Failed'
        btn.title = String(e?.message || e)
        btn.disabled = false
      }
    })
  })
}

// Prepend the apply panel to the AI Analysis tab so moves sit by the analysis.
function injectApplyPanel(target) {
  const ops = parseEqOps(lastResult?.text)
  if (!ops.length) return
  const holder = document.createElement('div')
  holder.innerHTML = renderApplyPanel(ops)
  if (holder.firstElementChild) target.insertBefore(holder.firstElementChild, target.firstChild)
  wireApplyButtons(target)
}

function renderPluginsTab(target, r) {
  const ops = parseEqOps(r?.text)
  target.innerHTML = `
    <div class="plugins-tab">
      <div class="plugins-head">
        <h2>Live Plugins</h2>
        <button id="btn-refresh-plugins" class="btn-secondary" type="button">↻ Refresh from FL</button>
      </div>
      <div class="plugins-hint">FabFilter Pro-Q 3 instances on your mixer, read live from FL Studio over MIDI.</div>
      ${renderApplyPanel(ops)}
      <div id="plugins-body" class="plugins-body"><div class="plugins-loading">Reading plugins from FL…</div></div>
    </div>`
  target.querySelector('#btn-refresh-plugins')?.addEventListener('click', loadLivePlugins)
  wireApplyButtons(target)
  loadLivePlugins()
}

async function loadLivePlugins() {
  const body = $('plugins-body')
  if (!body || !window.mc?.scanPlugins) return
  body.innerHTML = '<div class="plugins-loading">Reading plugins from FL…</div>'
  let res
  try {
    res = await window.mc.scanPlugins()
  } catch (e) {
    body.innerHTML = `<div class="plugins-empty">Could not read plugins: ${escapeHtml(String(e?.message || e))}</div>`
    return
  }
  if (!res || !res.available) {
    body.innerHTML = `<div class="plugins-empty">FL bridge offline — open FL Studio + loopMIDI with the MixCoach controller assigned.${res?.error ? ` <span class="dim">(${escapeHtml(res.error)})</span>` : ''}</div>`
    return
  }
  const states = res.states || []
  if (!states.length) {
    body.innerHTML = '<div class="plugins-empty">No FabFilter Pro-Q 3 found on the mixer.</div>'
    return
  }
  body.innerHTML = states.map(renderProqCard).join('')
}

function renderProqCard(s) {
  const st = s.proq3
  if (!st) return ''
  const rows = (st.bands || [])
    .map(
      (b) =>
        `<tr><td>${b.n}</td><td>${escapeHtml(b.type)}</td><td>${escapeHtml(b.freq || '–')}</td><td>${escapeHtml(b.gain || '–')}</td><td>${b.q != null ? b.q : '–'}</td></tr>`
    )
    .join('')
  const cut = (label, c) =>
    c ? `<span class="proq-cut">${label} ${escapeHtml(c.freq || '?')}${c.slope ? ` · ${escapeHtml(c.slope)}` : ''}</span>` : ''
  return `
    <div class="proq-card">
      <div class="proq-head"><span class="proq-name">${escapeHtml(s.pluginName)}</span><span class="proq-loc">Insert ${s.insert} · slot ${s.slot}</span></div>
      <div class="proq-cuts">${cut('HP', st.hp)}${cut('LP', st.lp)}${st.output ? `<span class="proq-cut">Output ${escapeHtml(st.output)}</span>` : ''}</div>
      ${rows ? `<table class="proq-table"><thead><tr><th>Band</th><th>Type</th><th>Freq</th><th>Gain</th><th>Q</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="proq-empty">No active shaping bands.</div>'}
    </div>`
}

function renderEmpty() {
  return `
    <div class="empty-state">
      <h2>Start an analysis</h2>
      <p>MixCoach captures your .flp project, your live plugin settings, and 15 seconds of audio, then asks a veteran engineer what to fix.</p>
      <div class="empty-mode-bar" role="radiogroup" aria-label="Analysis mode">
        <button class="mode-opt" data-mode="vocal" role="radio" aria-checked="false">Vocal</button>
        <button class="mode-opt" data-mode="beat" role="radio" aria-checked="false">Beat</button>
        <button class="mode-opt" data-mode="both" role="radio" aria-checked="false">Both</button>
      </div>
      <button id="btn-empty-analyze" type="button" class="btn-big">ANALYZE</button>
      <button id="btn-empty-reference" type="button" class="btn-link-ref">＋ Load a reference track first</button>
    </div>`
}

function renderLoading() {
  // Before recording starts, show a big 3-2-1 countdown instead of the spinner.
  if (lastStatus && lastStatus.phase === 'countdown') {
    const n =
      typeof lastStatus.seconds_remaining === 'number' ? lastStatus.seconds_remaining : ''
    return `
      <div class="loading-state countdown-state">
        <div class="countdown-num">${escapeHtml(String(n))}</div>
        <div class="countdown-label">Get ready — recording starts in…</div>
        <div class="loading-actions">
          <button id="btn-cancel-inline" type="button">Cancel</button>
        </div>
      </div>`
  }
  const { text, detail } = statusLine(lastStatus)
  return `
    <div class="loading-state">
      <div class="spinner"></div>
      <div class="status-text">${escapeHtml(text)}</div>
      <div class="status-detail">${escapeHtml(detail)}</div>
      <div class="loading-actions">
        <button id="btn-cancel-inline" type="button">Cancel</button>
      </div>
    </div>`
}

function renderError() {
  return `
    <div class="error-state">
      <div class="error-label">Something went wrong</div>
      <pre>${escapeHtml(lastError ?? 'Unknown error')}</pre>
      <button id="btn-retry" type="button">Retry</button>
    </div>`
}

function renderPlaceholder(target, title, sub) {
  target.innerHTML = `
    <div class="tab-placeholder">
      <div class="ph-icon">▢</div>
      <div class="ph-title">${escapeHtml(title)}</div>
      <div class="ph-sub">${escapeHtml(sub)}</div>
    </div>`
}

// ─── AI response parsing ────────────────────────────────────────────
// The system prompt instructs Gemini to emit `## Problem N: [TYPE] Title`
// headers + a `## Plugin chain changes` section with structured bullets.
// These helpers extract them; both degrade gracefully when the model
// drifts (e.g. omits a [TYPE] tag or uses freeform Reorder/Add/Remove).

function parseProblems(text) {
  if (!text) return []
  // Split on lines that match `## Problem N: ...` keeping content between
  // headers. We bail at the first non-Problem `##` section (chain changes,
  // closing-the-gap, etc.) so those don't leak into problem cards.
  const lines = text.split(/\r?\n/)
  const problems = []
  let cur = null
  for (const line of lines) {
    const m = line.match(/^##\s*Problem\s*\d+\s*:\s*(.*)$/i)
    if (m) {
      if (cur) problems.push(cur)
      const rest = m[1].trim()
      const tagMatch = rest.match(/^\[([A-Z_]+)\]\s*(.*)$/)
      cur = {
        type: tagMatch ? tagMatch[1] : 'OTHER',
        title: tagMatch ? tagMatch[2].trim() : rest,
        body: ''
      }
      continue
    }
    // Any other H2 closes the problem run.
    if (/^##\s+/.test(line)) {
      if (cur) { problems.push(cur); cur = null }
      // Stop iterating problem sections.
      break
    }
    if (cur) cur.body += line + '\n'
  }
  if (cur) problems.push(cur)
  return problems.map((p) => ({ ...p, body: p.body.trim() }))
}

function parseChainChanges(text) {
  const out = { reorders: [], adds: [], removes: [], settings: [], acquires: [] }
  if (!text) return out
  // Find the section between `## Plugin chain changes` and the next `## ` (or EOF).
  const section = text.match(/##\s*Plugin\s*chain\s*changes\s*\n([\s\S]*?)(?=\n##\s|\n\*\*Working\s+well|$)/i)
  if (!section) return out
  // Separator class: a literal space + (em-dash | en-dash | hyphen) + space.
  // We intentionally do NOT allow bare hyphens because plugin names contain
  // them (e.g. "Pro-Q 3", "CLA-76") — only a space-dash-space splits fields.
  const SEP = `\\s+[—–-]\\s+`
  const lines = section[1].split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.replace(/^[-*]\s*/, '').trim()
    if (!line) continue
    let m
    if ((m = line.match(new RegExp(`^Reorder\\s+Insert\\s+(\\d+)\\s*:\\s*(\\d+)\\s*->\\s*(\\d+)${SEP}(.+?)${SEP}(.+)$`, 'i')))) {
      out.reorders.push({ insert: +m[1], from: +m[2], to: +m[3], plugin: m[4].trim(), why: m[5].trim() })
    } else if ((m = line.match(/^Reorder\s*:\s*(.+)$/i))) {
      // Fallback: model used the old freeform `Reorder:` style. Treat as a setting-like note.
      out.settings.push(`Reorder — ${m[1].trim()}`)
    } else if ((m = line.match(new RegExp(`^Add\\s+Insert\\s+(\\d+)\\s+slot\\s+(\\d+)\\s*:\\s*(.+?)${SEP}(.+)$`, 'i')))) {
      out.adds.push({ insert: +m[1], slot: +m[2], plugin: m[3].trim(), why: m[4].trim() })
    } else if ((m = line.match(/^Add\s*:\s*(.+)$/i))) {
      out.settings.push(`Add — ${m[1].trim()}`)
    } else if ((m = line.match(new RegExp(`^Remove\\s+Insert\\s+(\\d+)\\s+slot\\s+(\\d+)\\s*:\\s*(.+?)${SEP}(.+)$`, 'i')))) {
      out.removes.push({ insert: +m[1], slot: +m[2], plugin: m[3].trim(), why: m[4].trim() })
    } else if ((m = line.match(/^Remove\s*:\s*(.+)$/i))) {
      out.settings.push(`Remove — ${m[1].trim()}`)
    } else if ((m = line.match(/^Setting\s*:\s*(.+)$/i))) {
      out.settings.push(m[1].trim())
    } else if ((m = line.match(new RegExp(`^Acquire\\s*:\\s*(.+?)${SEP}(.+)$`, 'i')))) {
      out.acquires.push({ plugin: m[1].trim(), why: m[2].trim() })
    } else if ((m = line.match(/^Acquire\s*:\s*(.+)$/i))) {
      out.acquires.push({ plugin: m[1].trim(), why: '' })
    } else if (line.length > 0) {
      out.settings.push(line)
    }
  }
  return out
}

function extractWorkingWell(text) {
  if (!text) return ''
  const m = text.match(/\*\*Working\s+well:\*\*\s*(.+)/i)
  return m ? m[1].trim() : ''
}

// Parse the `## Final Tweaks` section into groups keyed by bold sub-headings
// (`**Lead vocal (Insert 13)**`), each with a list of one-line moves. Ends at
// the next `## ` section or the `**Working well:**` line. Degrades to a single
// "Final Tweaks" group if the model emits bullets without sub-headings.
function parseFinalTweaks(text) {
  if (!text) return []
  const section = text.match(
    /##\s*Final\s*Tweaks\s*\n([\s\S]*?)(?=\n##\s|\n\*\*Working\s+well|$)/i
  )
  if (!section) return []
  const groups = []
  let cur = null
  for (const raw of section[1].split(/\r?\n/)) {
    const t = raw.replace(/\r$/, '').trim()
    if (!t) continue
    // `**Heading**` or `**Heading:**` on its own line opens a group.
    const head = t.match(/^\*\*(.+?)\*\*:?$/)
    if (head) {
      cur = { heading: head[1].trim(), items: [] }
      groups.push(cur)
      continue
    }
    const bullet = t.match(/^[-*]\s+(.*)$/)
    const item = bullet ? bullet[1].trim() : t
    if (!cur) {
      cur = { heading: 'Final Tweaks', items: [] }
      groups.push(cur)
    }
    cur.items.push(item)
  }
  return groups.filter((g) => g.items.length)
}

// Inline markdown for short snippets (code + bold) — used by the Final Tweaks
// checklist where we render <li>s ourselves instead of going through
// renderMarkdown.
function inlineMd(text) {
  let s = escapeHtml(text)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  return s
}

function renderFinalTweaks(groups) {
  if (!groups.length) return ''
  const groupHtml = groups
    .map(
      (g, gi) => `
      <div class="ft-group">
        <div class="ft-group-h">${escapeHtml(g.heading)}</div>
        <ul class="ft-list">
          ${g.items
            .map(
              (it, ii) => `
            <li class="ft-item">
              <label class="ft-label">
                <input type="checkbox" class="ft-check" data-g="${gi}" data-i="${ii}" />
                <span class="ft-box" aria-hidden="true"></span>
                <span class="ft-text">${inlineMd(it)}</span>
              </label>
            </li>`
            )
            .join('')}
        </ul>
      </div>`
    )
    .join('')
  return `
    <div class="widget final-tweaks">
      <h3 class="widget-h">Final Tweaks <span class="widget-sub">action checklist</span></h3>
      <div class="widget-body">${groupHtml}</div>
    </div>`
}

function wireFinalTweaks(root) {
  root.querySelectorAll('.ft-check').forEach((box) => {
    box.addEventListener('change', () => {
      const li = box.closest('.ft-item')
      if (li) li.classList.toggle('done', box.checked)
    })
  })
}

// Map problem [TYPE] tags to a CSS hue + display label.
const PROBLEM_TYPE_META = {
  EQ:              { label: 'EQ',              hue: 'hue-eq' },
  MUD:             { label: 'Mud',             hue: 'hue-mud' },
  HARSHNESS:       { label: 'Harshness',       hue: 'hue-harsh' },
  SIBILANCE:       { label: 'Sibilance',       hue: 'hue-harsh' },
  PRESENCE:        { label: 'Presence',        hue: 'hue-eq' },
  AIR:             { label: 'Air',             hue: 'hue-eq' },
  LOWEND:          { label: 'Low End',         hue: 'hue-low' },
  DYNAMICS:        { label: 'Dynamics',        hue: 'hue-dyn' },
  OVERCOMPRESSION: { label: 'Over-compression',hue: 'hue-dyn' },
  TRANSIENTS:      { label: 'Transients',      hue: 'hue-dyn' },
  STEREO_WIDTH:    { label: 'Stereo Width',    hue: 'hue-stereo' },
  DEPTH:           { label: 'Depth',           hue: 'hue-stereo' },
  LEVELING:        { label: 'Leveling',        hue: 'hue-mix' },
  LOUDNESS:        { label: 'Loudness',        hue: 'hue-mix' },
  BALANCE:         { label: 'Balance',         hue: 'hue-mix' },
  ROUTING:         { label: 'Routing',         hue: 'hue-route' },
  OTHER:           { label: 'Other',           hue: 'hue-other' }
}

// Active AI-tab layout. 'classic' is the shipped design; l1-l4 are the
// preview drafts the design switcher can select (browser preview only — in
// Electron localStorage has no value so it stays 'classic').
function getAILayout() {
  // 'l4' (Steps) is the shipped layout. The browser preview switcher can
  // override via window.__aiLayout / localStorage for design exploration.
  if (typeof window !== 'undefined' && window.__aiLayout) return window.__aiLayout
  try {
    return localStorage.getItem('mixcoach.aiLayout') || 'l4'
  } catch {
    return 'l4'
  }
}

// Pull the terse Problem / Fix / Does lines out of a problem body. Falls back
// to the whole body as "problem" if the model didn't use the labels.
function parseTerseBody(body) {
  const grab = (label) => {
    const re = new RegExp('\\*\\*' + label + ':\\*\\*\\s*([\\s\\S]+?)(?=\\n\\*\\*[A-Za-z]+:\\*\\*|$)', 'i')
    const m = body.match(re)
    return m ? m[1].trim() : ''
  }
  const problem = grab('Problem')
  return {
    problem: problem || body.trim(),
    fix: grab('Fix'),
    result: grab('Does') || grab('Result')
  }
}

// Normalized model every AI layout renders from — so they all show the SAME
// information, just arranged differently.
function buildAIModel(r) {
  const problems = parseProblems(r.text || '').map((p) => {
    const meta = PROBLEM_TYPE_META[p.type] || PROBLEM_TYPE_META.OTHER
    const t = parseTerseBody(p.body)
    return { type: p.type, title: p.title, hue: meta.hue, label: meta.label, ...t }
  })
  return {
    problems,
    finalTweaks: parseFinalTweaks(r.text || ''),
    working: extractWorkingWell(r.text || ''),
    comparison: r.comparison || null
  }
}

// Shared pieces ------------------------------------------------------------
function aiWorkingBlock(working) {
  return working
    ? `<div class="widget working-well"><div class="ww-h">WORKING WELL</div><div class="ww-body">${escapeHtml(working)}</div></div>`
    : ''
}
function aiDeltaStrip(comparison) {
  if (!comparison || !(comparison.summary || []).length) return ''
  const chips = comparison.summary
    .slice(0, 4)
    .map((s) => `<span class="ai-delta-chip">${escapeHtml(s.split(' (')[0])}</span>`)
    .join('')
  return `<div class="ai-delta-strip"><span class="ai-delta-label">vs reference</span>${chips}</div>`
}

// LAYOUT: classic (shipped) ------------------------------------------------
function aiLayoutClassic(m) {
  const cards = m.problems
    .map((p, i) => {
      // Terse (Problem/Fix/Does) responses get the structured body; older
      // prose responses (no labels) fall back to full markdown so nothing
      // is lost in the shipped app.
      const terse = p.fix || p.result
      const body = terse
        ? `<p>${inlineMd(p.problem)}</p>` +
          (p.fix ? `<p><strong>Fix:</strong> ${inlineMd(p.fix)}</p>` : '') +
          (p.result ? `<p><strong>Does:</strong> ${inlineMd(p.result)}</p>` : '')
        : renderMarkdown(p.problem)
      return `
      <div class="widget problem-card ${p.hue}">
        <h3 class="widget-h">
          <span class="problem-num">PROBLEM ${i + 1}</span>
          <span class="problem-tag ${p.hue}">${escapeHtml(p.label)}</span>
          <span class="problem-title">${escapeHtml(p.title)}</span>
        </h3>
        <div class="widget-body problem-body">${body}</div>
      </div>`
    })
    .join('')
  return `<div class="ai-stack">${cards}${renderFinalTweaks(m.finalTweaks)}${aiWorkingBlock(m.working)}</div>`
}

// LAYOUT 1: big 3-zone cards ----------------------------------------------
function aiLayoutCards(m) {
  const cards = m.problems
    .map(
      (p, i) => `
      <div class="aic ${p.hue}">
        <div class="aic-head">
          <span class="aic-num">${String(i + 1).padStart(2, '0')}</span>
          <span class="aic-tag ${p.hue}">${escapeHtml(p.label)}</span>
          <span class="aic-title">${escapeHtml(p.title)}</span>
        </div>
        <div class="aic-zone aic-problem"><span class="aic-k">Problem</span><div class="aic-v">${inlineMd(p.problem)}</div></div>
        ${p.fix ? `<div class="aic-zone aic-fix"><span class="aic-k">Fix</span><div class="aic-v">${inlineMd(p.fix)}</div></div>` : ''}
        ${p.result ? `<div class="aic-zone aic-does"><span class="aic-k">Does</span><div class="aic-v">${inlineMd(p.result)}</div></div>` : ''}
      </div>`
    )
    .join('')
  return `<div class="ai-layout l-cards">${aiDeltaStrip(m.comparison)}${cards}${renderFinalTweaks(m.finalTweaks)}${aiWorkingBlock(m.working)}</div>`
}

// LAYOUT 2: ledger table ---------------------------------------------------
function aiLayoutLedger(m) {
  const rows = m.problems
    .map(
      (p, i) => `
      <div class="ail-row">
        <div class="ail-c ail-n">${i + 1}</div>
        <div class="ail-c ail-tagc"><span class="aic-tag ${p.hue}">${escapeHtml(p.label)}</span></div>
        <div class="ail-c ail-prob"><div class="ail-title">${escapeHtml(p.title)}</div><div class="ail-sub">${inlineMd(p.problem)}</div></div>
        <div class="ail-c ail-fix">${p.fix ? inlineMd(p.fix) : '—'}</div>
        <div class="ail-c ail-does">${p.result ? inlineMd(p.result) : '—'}</div>
      </div>`
    )
    .join('')
  return `
    <div class="ai-layout l-ledger">
      ${aiDeltaStrip(m.comparison)}
      <div class="ail-table">
        <div class="ail-row ail-headrow">
          <div class="ail-c ail-n">#</div>
          <div class="ail-c ail-tagc">Type</div>
          <div class="ail-c ail-prob">Problem</div>
          <div class="ail-c ail-fix">Fix</div>
          <div class="ail-c ail-does">Does</div>
        </div>
        ${rows}
      </div>
      ${renderFinalTweaks(m.finalTweaks)}
      ${aiWorkingBlock(m.working)}
    </div>`
}

// LAYOUT 3: split master-detail -------------------------------------------
function aiLayoutSplit(m) {
  const list = m.problems
    .map(
      (p, i) => `
      <button class="ais-item ${i === 0 ? 'active' : ''}" data-ais="${i}">
        <span class="ais-item-n">${i + 1}</span>
        <span class="aic-tag ${p.hue}">${escapeHtml(p.label)}</span>
        <span class="ais-item-t">${escapeHtml(p.title)}</span>
      </button>`
    )
    .join('')
  const panels = m.problems
    .map(
      (p, i) => `
      <div class="ais-panel ${i === 0 ? 'active' : ''}" data-ais-panel="${i}">
        <div class="ais-panel-head"><span class="aic-tag ${p.hue}">${escapeHtml(p.label)}</span><h3>${escapeHtml(p.title)}</h3></div>
        <div class="aic-zone aic-problem"><span class="aic-k">Problem</span><div class="aic-v">${inlineMd(p.problem)}</div></div>
        ${p.fix ? `<div class="aic-zone aic-fix"><span class="aic-k">Fix</span><div class="aic-v">${inlineMd(p.fix)}</div></div>` : ''}
        ${p.result ? `<div class="aic-zone aic-does"><span class="aic-k">Does</span><div class="aic-v">${inlineMd(p.result)}</div></div>` : ''}
      </div>`
    )
    .join('')
  return `
    <div class="ai-layout l-split">
      <div class="ais-rail">
        ${aiDeltaStrip(m.comparison)}
        <div class="ais-list">${list}</div>
      </div>
      <div class="ais-detail">
        ${panels}
        ${renderFinalTweaks(m.finalTweaks)}
        ${aiWorkingBlock(m.working)}
      </div>
    </div>`
}
function wireAISplit(root) {
  const items = root.querySelectorAll('[data-ais]')
  const panels = root.querySelectorAll('[data-ais-panel]')
  items.forEach((it) => {
    it.addEventListener('click', () => {
      const idx = it.dataset.ais
      items.forEach((x) => x.classList.toggle('active', x.dataset.ais === idx))
      panels.forEach((p) => p.classList.toggle('active', p.dataset.aisPanel === idx))
    })
  })
}

// LAYOUT 4: numbered steps timeline ---------------------------------------
function aiLayoutSteps(m) {
  const steps = m.problems
    .map(
      (p, i) => `
      <div class="ait-step ${p.hue}">
        <div class="ait-mark"><span>${i + 1}</span></div>
        <div class="ait-body">
          <div class="ait-head"><span class="aic-tag ${p.hue}">${escapeHtml(p.label)}</span><span class="ait-title">${escapeHtml(p.title)}</span></div>
          <div class="ait-problem">${inlineMd(p.problem)}</div>
          ${p.fix ? `<div class="ait-fix"><span class="ait-fix-k">DO</span>${inlineMd(p.fix)}</div>` : ''}
          ${p.result ? `<div class="ait-does">→ ${inlineMd(p.result)}</div>` : ''}
        </div>
      </div>`
    )
    .join('')
  return `<div class="ai-layout l-steps">${aiDeltaStrip(m.comparison)}<div class="ait-track">${steps}</div>${renderFinalTweaks(m.finalTweaks)}${aiWorkingBlock(m.working)}</div>`
}

function renderAITab(target, r) {
  const model = buildAIModel(r)
  if (!model.problems.length) {
    target.innerHTML = `
      <div class="tab-placeholder">
        <div class="ph-icon">◌</div>
        <div class="ph-title">No problems parsed</div>
        <div class="ph-sub">The model's response didn't include any "## Problem N:" headers. Raw response below.</div>
        <pre style="margin-top:20px;max-width:800px;padding:14px;background:#141414;border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:var(--mono);font-size:12px;white-space:pre-wrap;text-align:left;">${escapeHtml(r.text || '(empty)')}</pre>
      </div>`
    return
  }
  const layout = getAILayout()
  let html
  if (layout === 'l1') html = aiLayoutCards(model)
  else if (layout === 'l2') html = aiLayoutLedger(model)
  else if (layout === 'l3') html = aiLayoutSplit(model)
  else if (layout === 'l4') html = aiLayoutSteps(model)
  else html = aiLayoutClassic(model)
  target.innerHTML = html
  wireFinalTweaks(target)
  if (layout === 'l3') wireAISplit(target)
}

// ─── Dashboard tab (5 widgets) ──────────────────────────────────────
function renderDashboardTab(target, r) {
  const mode = VALID_MODES.includes(r.mode) ? r.mode : 'both'
  const chainHtml = mode === 'beat' ? '' : renderVocalChain(r.vocalChain, r.vocalChainBuses)
  const alertsHtml = renderAlerts(r, mode)
  const playbackHtml = renderPlaybackWidget(r)

  target.innerHTML = `
    <div class="dashboard-grid">
      <div class="widget w-alerts">
        <h3 class="widget-h">Alerts <span class="widget-sub">priority issues</span></h3>
        <div class="widget-body">${alertsHtml}</div>
      </div>
      <div class="widget w-chain">
        <h3 class="widget-h">Vocal Chain <span class="widget-sub">${mode === 'beat' ? 'n/a in beat mode' : ''}</span></h3>
        <div class="widget-body">${chainHtml || '<div class="alerts-empty">No vocal chain to show.</div>'}</div>
      </div>
      <div class="widget w-playback">
        <h3 class="widget-h">Playback <span class="widget-sub">captured clip</span></h3>
        <div class="widget-body playback-widget">${playbackHtml}</div>
      </div>
    </div>`

  wireChainTabs(target)
  wirePlayback(target)
}

// ─── Extras tab (tonal profile + suggested changes) ─────────────────
// Moved off the dashboard so the dashboard stays focused on priority
// alerts, the vocal chain, and playback.
function renderExtrasTab(target, r) {
  const chartHtml = renderTonalChart(r.audio, r.suggestions)
  const suggestionsHtml = renderSuggestions(r.suggestions || [])

  target.innerHTML = `
    <div class="extras-grid">
      <div class="widget w-tonal">
        <h3 class="widget-h">Tonal Profile <span class="widget-sub">per-band dBFS vs genre curve</span></h3>
        <div class="widget-body">${chartHtml || '<div class="alerts-empty">No audio data.</div>'}</div>
      </div>
      <div class="widget w-suggest">
        <h3 class="widget-h">Suggested Changes <span class="widget-sub">automated checks</span></h3>
        <div class="widget-body"><div class="suggestions">${suggestionsHtml}</div></div>
      </div>
    </div>`

  wireSuggestions(target)
}

function renderAlerts(r, mode) {
  const items = []
  const verdict = r.vocalVerdict
  if (verdict && mode !== 'beat') {
    const sev = verdict.clarity_score >= 80 ? 'ok' : verdict.clarity_score >= 55 ? 'warn' : 'critical'
    items.push({
      severity: sev,
      headline: verdict.headline || `Vocal clarity: ${verdict.clarity_score}/100`,
      detail: (verdict.issues || []).slice(0, 2).join(' · ')
    })
  }
  // suggestions.ts emits severity = 'critical' | 'warning' | 'info'. Map
  // 'warning' → 'warn' for CSS, surface critical+warn in the alerts widget
  // (info-level lives in the Suggested Changes widget where it belongs).
  for (const s of (r.suggestions || [])) {
    let sev
    if (s.severity === 'critical') sev = 'critical'
    else if (s.severity === 'warning' || s.severity === 'warn') sev = 'warn'
    else continue
    items.push({ severity: sev, headline: s.title, detail: s.message })
  }
  if (!items.length) {
    return `<div class="alerts-empty">No critical issues flagged.</div>`
  }
  return `<ul class="alerts-list">${items.map(i => `
    <li class="alert-item sev-${i.severity}">
      <span class="alert-dot sev-${i.severity}"></span>
      <div class="alert-body">
        <div class="alert-headline">${escapeHtml(i.headline)}</div>
        ${i.detail ? `<div class="alert-detail">${escapeHtml(i.detail)}</div>` : ''}
      </div>
    </li>`).join('')}</ul>`
}

function renderPlaybackWidget(r) {
  if (!r.wavPath) return `<div class="playback-empty">No captured audio yet.</div>`
  return `
    <button id="btn-play-wav" type="button">▶ Play</button>
    <audio id="captured-audio" controls preload="none"></audio>`
}

// ─── Chain Edits tab ────────────────────────────────────────────────
function renderChainTab(target, r) {
  const changes = parseChainChanges(r.text || '')
  const buses = r.vocalChainBuses || []
  const chain = r.vocalChain || []
  const insertByIdx = new Map()
  for (const step of chain) {
    if (step.insert) insertByIdx.set(step.bus, step.insert)
  }

  // Build the reorder visualizer: one large widget at top with a 4-tab
  // selector matching the vocal-chain buses. For each tab we draw the
  // current plugin order with any reorders for that insert overlaid as
  // arrows / highlighted moves.
  const reorderTabs = buses.map((bus, i) => {
    const cls = i === 0 ? 'chain-tab active' : 'chain-tab'
    const sel = i === 0 ? 'true' : 'false'
    return `<button class="${cls}" data-chain-tab="${i}" role="tab" aria-selected="${sel}">Insert ${bus}</button>`
  }).join('')

  const reorderPanels = buses.map((bus, i) => {
    const ins = insertByIdx.get(bus)
    const moves = changes.reorders.filter((m) => m.insert === bus)
    const panelCls = i === 0 ? 'chain-step-panel active' : 'chain-step-panel'
    if (!ins) {
      return `<div class="${panelCls}" data-chain-panel="${i}">
        <div class="reorder-empty">Insert ${bus} not in current FLP.</div>
      </div>`
    }
    const plugins = (ins.plugins || [])
      .filter((p) => p.enabled === true)
      .slice()
      .sort((a, b) => a.slot - b.slot)

    // Adds + removes scoped to this insert so the strip can show them inline.
    const addsHere = changes.adds.filter((a) => a.insert === bus)
    const removesHere = changes.removes.filter((rm) => rm.insert === bus)
    const removedSlots = new Set(removesHere.map((rm) => rm.slot))
    // Highlight slots that show up in a reorder move (either source or dest).
    const movedSlots = new Set(moves.flatMap((m) => [m.from, m.to]))

    // Build a unified chip list: current plugins keep their slot; added plugins
    // are inserted at `targetSlot - 0.5` so they render just before the slot
    // they want to occupy (which gets displaced down by the addition).
    const chipItems = plugins.map((p) => {
      const slotNum = p.slot + 1
      let state = 'current'
      if (removedSlots.has(slotNum)) state = 'remove'
      else if (movedSlots.has(slotNum)) state = 'moved'
      return { order: slotNum, label: `slot ${slotNum}`, name: p.name, state }
    })
    for (const a of addsHere) {
      chipItems.push({
        order: a.slot - 0.5,
        label: `+ slot ${a.slot}`,
        name: a.plugin,
        state: 'add'
      })
    }
    chipItems.sort((x, y) => x.order - y.order)

    const chipRow = chipItems.map((it) =>
      `<div class="reorder-chip rc-${it.state}">
        <div class="rc-slot">${escapeHtml(it.label)}</div>
        <div class="rc-name">${escapeHtml(it.name)}</div>
      </div>`
    ).join('<span class="reorder-arrow">›</span>')

    const moveList = moves.length === 0
      ? '<div class="reorder-empty">No reorders proposed for this insert.</div>'
      : `<ul class="reorder-moves">${moves.map((m) => `
          <li>
            <span class="move-pill">Slot ${m.from} → ${m.to}</span>
            <span class="move-plug">${escapeHtml(m.plugin)}</span>
            <span class="move-why">${escapeHtml(m.why)}</span>
          </li>`).join('')}</ul>`

    return `<div class="${panelCls}" data-chain-panel="${i}">
      <div class="reorder-strip">${chipRow || '<div class="reorder-empty">No enabled plugins on this insert.</div>'}</div>
      ${moveList}
    </div>`
  }).join('')

  // Add / Remove / Acquire side widgets.
  const renderEditList = (items, mkRow, emptyMsg) =>
    items.length === 0
      ? `<div class="alerts-empty">${emptyMsg}</div>`
      : `<ul class="edit-list">${items.map(mkRow).join('')}</ul>`

  const addsHtml = renderEditList(
    changes.adds,
    (a) => `<li class="edit-row add">
      <span class="edit-mark">+</span>
      <div class="edit-body">
        <div class="edit-headline">Insert ${a.insert} slot ${a.slot} · ${escapeHtml(a.plugin)}</div>
        <div class="edit-why">${escapeHtml(a.why)}</div>
      </div>
    </li>`,
    'No additions proposed.'
  )

  const removesHtml = renderEditList(
    changes.removes,
    (rm) => `<li class="edit-row remove">
      <span class="edit-mark">✕</span>
      <div class="edit-body">
        <div class="edit-headline">Insert ${rm.insert} slot ${rm.slot} · ${escapeHtml(rm.plugin)}</div>
        <div class="edit-why">${escapeHtml(rm.why)}</div>
      </div>
    </li>`,
    'No removals proposed.'
  )

  const settingsHtml = renderEditList(
    changes.settings,
    (s) => `<li class="edit-row setting">
      <span class="edit-mark">⚙</span>
      <div class="edit-body">
        <div class="edit-why">${escapeHtml(s)}</div>
      </div>
    </li>`,
    'No setting tweaks proposed.'
  )

  const acquiresHtml = changes.acquires.length === 0 ? '' : `
    <div class="widget">
      <h3 class="widget-h">Acquire</h3>
      <div class="widget-body">
        ${renderEditList(
          changes.acquires,
          (a) => `<li class="edit-row acquire">
            <span class="edit-mark">★</span>
            <div class="edit-body">
              <div class="edit-headline">${escapeHtml(a.plugin)}</div>
              <div class="edit-why">${escapeHtml(a.why)}</div>
            </div>
          </li>`,
          ''
        )}
      </div>
    </div>`

  target.innerHTML = `
    <div class="chain-edits-stack">
      <div class="widget chain-edits-main">
        <h3 class="widget-h">Reorder <span class="widget-sub">visual diff per insert</span></h3>
        <div class="widget-body">
          <div class="chain-tabs" role="tablist">${reorderTabs}</div>
          <div class="chain-steps">${reorderPanels}</div>
        </div>
      </div>

      <div class="chain-edits-row">
        <div class="widget">
          <h3 class="widget-h">Add</h3>
          <div class="widget-body">${addsHtml}</div>
        </div>
        <div class="widget">
          <h3 class="widget-h">Remove</h3>
          <div class="widget-body">${removesHtml}</div>
        </div>
      </div>

      <div class="widget">
        <h3 class="widget-h">Setting tweaks <span class="widget-sub">freeform</span></h3>
        <div class="widget-body">${settingsHtml}</div>
      </div>

      ${acquiresHtml}
    </div>`

  wireChainTabs(target)
}

// ─── Key & BPM tab ──────────────────────────────────────────────────
function renderKeyBpmTab(target, r) {
  const a = r.audio || {}
  const key = a.key
  const conf = a.key_confidence
  const bpm = a.bpm
  const stab = a.bpm_stability_pct

  const fmtKey = key ?? '—'
  const fmtBpm = (typeof bpm === 'number' && isFinite(bpm)) ? bpm.toFixed(1) : '—'
  const confLine = (typeof conf === 'number' && isFinite(conf))
    ? `confidence ${(conf * 100).toFixed(0)}%`
    : 'confidence unknown'
  const stabLine = (typeof stab === 'number' && isFinite(stab))
    ? `tempo drift ±${stab.toFixed(2)}%`
    : 'stability unknown'

  target.innerHTML = `
    <div class="keybpm-grid">
      <div class="widget keybpm-card">
        <h3 class="widget-h">Key</h3>
        <div class="widget-body keybpm-body">
          <div class="kbpm-value">${escapeHtml(fmtKey)}</div>
          <div class="kbpm-sub">${escapeHtml(confLine)}</div>
        </div>
      </div>
      <div class="widget keybpm-card">
        <h3 class="widget-h">BPM</h3>
        <div class="widget-body keybpm-body">
          <div class="kbpm-value">${escapeHtml(fmtBpm)}</div>
          <div class="kbpm-sub">${escapeHtml(stabLine)}</div>
        </div>
      </div>
      <div class="widget keybpm-card keybpm-meta">
        <h3 class="widget-h">Method</h3>
        <div class="widget-body keybpm-body kbpm-meta-body">
          <div><strong>Key</strong>: HPSS-harmonic CQT chroma (fmin C2, skips sub-bass) + Albrecht-Shanahan major/minor templates.</div>
          <div><strong>BPM</strong>: librosa beat_track default. Stability = std/mean of inter-beat intervals.</div>
          <div class="kbpm-caveat">Both depend on the 15s capture having clear pitched content + steady tempo. Sparse drops or sustained pads can give weak readings.</div>
        </div>
      </div>
    </div>`
}

// ─── Compare tab ────────────────────────────────────────────────────
function renderCompareTab(target, r) {
  const compHtml = renderComparison(r.comparison)
  // The reference card always renders, even with no analysis context —
  // it shows the active reference + a Replace/Clear control.
  target.innerHTML = `
    <div class="compare-stack">
      <div class="widget">
        <h3 class="widget-h">Reference Track</h3>
        <div class="widget-body">
          <div id="reference-card" class="reference-card"></div>
        </div>
      </div>
      ${compHtml ? `
      <div class="widget">
        <h3 class="widget-h">Closing the gap</h3>
        <div class="widget-body">${compHtml}</div>
      </div>` : `
      <div class="widget">
        <h3 class="widget-h">Closing the gap</h3>
        <div class="widget-body">
          <div class="alerts-empty">Run an analysis with a reference loaded to see deltas here.</div>
        </div>
      </div>`}
    </div>`
  // Re-attach the reference picker if the helper exists.
  if (typeof refreshReferenceCard === 'function') {
    refreshReferenceCard()
  }
}

function renderChatTab(target, r) {
  target.innerHTML = `
    <div class="widget" style="max-width: 800px; margin: 0 auto; width: 100%;">
      <h3 class="widget-h">Chat <span class="widget-sub">grounded in last analysis</span></h3>
      <div class="widget-body">${renderChatSection()}</div>
    </div>`
  wireChat(target)
  renderChatMessages()
}

// ─── Captured-audio playback ────────────────────────────────────────
let lastWavUrl = null

function revokeLastWavUrl() {
  if (lastWavUrl) {
    URL.revokeObjectURL(lastWavUrl)
    lastWavUrl = null
  }
}

function wirePlayback(container) {
  const btn = container.querySelector('#btn-play-wav')
  const audio = container.querySelector('#captured-audio')
  if (!btn || !audio) return

  btn.addEventListener('click', async () => {
    btn.disabled = true
    try {
      // Always re-fetch on click: a subsequent capture overwrites the WAV,
      // and we don't want a stale Blob URL outliving the underlying file.
      revokeLastWavUrl()
      const buf = await window.mc.getLastWav()
      if (!buf) {
        btn.textContent = 'No audio available'
        return
      }
      const blob = new Blob([buf], { type: 'audio/wav' })
      lastWavUrl = URL.createObjectURL(blob)
      audio.src = lastWavUrl
      await audio.play()
      btn.textContent = '▶ Play'
    } catch (err) {
      btn.textContent = `Error: ${err?.message ?? 'play failed'}`
    } finally {
      btn.disabled = false
    }
  })
}

// ─── Live meter ─────────────────────────────────────────────────────
// Lazy DOM lookups — the consts used to be evaluated at module load
// time, but the meter elements now live inside the header that's part of
// the initial HTML, so they exist. Still, looking them up lazily means a
// future hot-reload that rebuilds the header won't trap us on stale refs.
const METER_FLOOR_DB = -60
let meterPeakHoldDb = METER_FLOOR_DB
let meterPeakHoldUntil = 0
let lastSignalAt = 0

function dbToPct(db) {
  if (db == null || !isFinite(db)) return 0
  const clamped = Math.max(METER_FLOOR_DB, Math.min(0, db))
  return ((clamped - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100
}

function updateMeter(payload) {
  if (!payload || typeof payload !== 'object') return
  const meterEl = $('meter')
  const meterFill = $('meter-fill')
  const meterPeak = $('meter-peak')
  const meterValue = $('meter-value')
  if (!meterEl || !meterFill || !meterPeak || !meterValue) return
  if (payload.error) {
    meterEl.classList.add('error')
    meterEl.classList.remove('no-signal')
    meterValue.textContent = 'err'
    meterValue.title = String(payload.error)
    return
  }
  meterEl.classList.remove('error')

  const peakDb = typeof payload.peak_db === 'number' ? payload.peak_db : null
  const rmsDb = typeof payload.rms_db === 'number' ? payload.rms_db : null

  // Bar tracks RMS for a smoother feel; numeric readout shows peak.
  const fillPct = dbToPct(rmsDb)
  meterFill.style.width = fillPct + '%'

  // Peak hold: jump up immediately, decay slowly.
  const now = performance.now()
  const incomingPeak = peakDb != null && isFinite(peakDb) ? peakDb : METER_FLOOR_DB
  if (incomingPeak > meterPeakHoldDb) {
    meterPeakHoldDb = incomingPeak
    meterPeakHoldUntil = now + 1200
  } else if (now > meterPeakHoldUntil) {
    // 18 dB/sec decay after the hold expires.
    meterPeakHoldDb = Math.max(METER_FLOOR_DB, meterPeakHoldDb - 18 * 0.1)
  }
  const peakPct = dbToPct(meterPeakHoldDb)
  meterPeak.style.left = `calc(${peakPct}% - 1px)`
  meterPeak.style.opacity = meterPeakHoldDb > METER_FLOOR_DB ? '1' : '0'

  // Numeric readout (peak in dBFS, or "—" for silence).
  if (peakDb == null || !isFinite(peakDb)) {
    meterValue.textContent = '—'
  } else {
    meterValue.textContent = `${peakDb.toFixed(1)} dB`
  }

  // No-signal detection: peak below -55 dB consistently for >2s.
  if (peakDb != null && isFinite(peakDb) && peakDb > -55) {
    lastSignalAt = now
    meterEl.classList.remove('no-signal')
  } else if (now - lastSignalAt > 2000) {
    meterEl.classList.add('no-signal')
  }
}

// Surface any uncaught renderer error so a stale preload (missing
// window.mc.onMeter / getLastWav after edits) doesn't silently break the
// button wiring below.
window.addEventListener('error', (e) => {
  console.error('[mixcoach] renderer error:', e.error || e.message)
})

// Header: analyze + window controls
$('btn-trigger').addEventListener('click', () => trigger())
$('btn-minimize').addEventListener('click', () => window.mc.minimize())
$('btn-close').addEventListener('click', () => window.mc.hide())

// Header mode toggle
document.querySelectorAll('#mode-bar .mode-opt').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode))
})

// Sidebar tab routing
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => setTab(btn.dataset.tab))
})

applyModeUI()
// Push the persisted mode to main on startup so the chat handler has a
// scoped context even before the first analysis.
window.mc.setMode?.(currentMode).catch(() => {})

// Reference track — kept around for the future Compare tab. The Phase 1
// shell doesn't render it yet, so calling refreshReferenceCard is a no-op
// because the DOM target doesn't exist; guard it.
if (typeof refreshReferenceCard === 'function' && document.getElementById('reference-card')) {
  refreshReferenceCard()
}

function leaveCancelInFlight() { cancelInFlight = false }

function enterIdleAfterCancel() {
  pipelineState = 'idle'
  renderCurrentView()
}

// Inline cancel button (rendered inside the loading state)
document.addEventListener('click', async (e) => {
  if (e.target && e.target.id === 'btn-cancel-inline') {
    e.target.disabled = true
    cancelInFlight = true
    try {
      await window.mc.cancel?.()
    } catch (err) {
      console.error('[mixcoach] cancel ipc threw', err)
    }
    setTimeout(() => {
      if (cancelInFlight) {
        enterIdleAfterCancel()
        setTimeout(leaveCancelInFlight, 4000)
      }
    }, 1500)
  }
})

try {
  window.mc.onMeter?.(updateMeter)
} catch (err) {
  console.error('[mixcoach] onMeter wiring failed (stale preload?)', err)
}

window.mc.onStart(() => {
  cancelInFlight = false
  pipelineState = 'loading'
  lastStatus = { phase: 'countdown', seconds_remaining: 3 }
  renderCurrentView()
})

window.mc.onCancelled?.(() => {
  cancelInFlight = false
  enterIdleAfterCancel()
})

window.mc.onStatus((s) => {
  if (cancelInFlight) return
  pipelineState = 'loading'
  lastStatus = s
  // Avoid re-rendering the whole loading view every tick — just patch in place
  // when the current DOM already matches the phase's view shape.
  const target = $('tab-content')
  const numEl = target && target.querySelector('.countdown-num')
  if (s && s.phase === 'countdown') {
    // Still counting down → just swap the big number, else build the view.
    if (numEl) {
      numEl.textContent =
        typeof s.seconds_remaining === 'number' ? String(s.seconds_remaining) : ''
      // Restart the pop animation so each new number animates in.
      numEl.style.animation = 'none'
      void numEl.offsetWidth
      numEl.style.animation = ''
    } else {
      renderCurrentView()
    }
    return
  }
  const textEl = target && target.querySelector('.status-text')
  if (textEl) {
    // Leaving the countdown (or already in the spinner view) → normal status.
    const { text, detail } = statusLine(s)
    textEl.textContent = text
    target.querySelector('.status-detail').textContent = detail
  } else {
    renderCurrentView()
  }
})

window.mc.onResult((r) => {
  if (cancelInFlight) return
  pipelineState = 'done'
  lastResult = r
  // Reset chat per new analysis so prior follow-ups don't reference stale data.
  chatHistory = []
  chatBusy = false
  // Update sidebar last-run readout
  const el = $('sidebar-last-run')
  if (el) el.textContent = `Last run: ${fmtTimestamp(r.timestamp)}`
  // Show which FL Studio project was analyzed, in the top breadcrumb. Empty
  // string collapses the chip (see .bc-flp:empty) when no .flp was found.
  const flpEl = $('bc-flp')
  if (flpEl) flpEl.textContent = r.flpName || ''
  renderCurrentView()
})

window.mc.onError((e) => {
  if (cancelInFlight) return
  showError(e?.message ?? 'Unknown error')
})

// Initial paint
setTab('dashboard')
