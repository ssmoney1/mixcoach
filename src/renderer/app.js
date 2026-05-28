// MixCoach renderer — vanilla JS. The preload bridge exposes `window.mc`.

const $ = (id) => document.getElementById(id)

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
  chain: 'Chain Edits',
  chat: 'Chat',
  keybpm: 'Key & BPM',
  compare: 'Compare'
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
    case 'screenshot':
      return {
        text: 'Capturing FL Studio screenshot…',
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

  const flow = (buses || chain.map((c) => c.bus))
    .map((b) => `Insert ${b}`)
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
        .filter((p) => p.enabled !== false)
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
        <div class="ref-empty-msg">Upload a finished, mastered track and MixCoach will compare every analysis against it so the AI can tell you exactly how to close the gap.</div>
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
    </div>`
  $('btn-replace-ref')?.addEventListener('click', pickReference)
  $('btn-clear-ref')?.addEventListener('click', clearReference)
}

async function pickReference() {
  const btn = $('btn-pick-ref') || $('btn-replace-ref')
  if (btn) {
    btn.disabled = true
    btn.textContent = 'Analyzing…'
  }
  try {
    const res = await window.mc.pickReference?.()
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
  lastStatus = { phase: 'screenshot', seconds_remaining: 5 }
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
    target.innerHTML = renderEmpty()
    target.querySelectorAll('.mode-opt').forEach((btn) => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode))
    })
    target.querySelector('#btn-empty-analyze')?.addEventListener('click', () => trigger())
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
    default:
      renderPlaceholder(target, currentTab, '')
  }
}

function renderEmpty() {
  return `
    <div class="empty-state">
      <h2>Start an analysis</h2>
      <p>MixCoach captures your screen, your .flp project, and 15 seconds of audio, then asks a veteran engineer what to fix.</p>
      <div class="empty-mode-bar" role="radiogroup" aria-label="Analysis mode">
        <button class="mode-opt" data-mode="vocal" role="radio" aria-checked="false">Vocal</button>
        <button class="mode-opt" data-mode="beat" role="radio" aria-checked="false">Beat</button>
        <button class="mode-opt" data-mode="both" role="radio" aria-checked="false">Both</button>
      </div>
      <button id="btn-empty-analyze" type="button" class="btn-big">ANALYZE</button>
    </div>`
}

function renderLoading() {
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

function renderAITab(target, r) {
  const problems = parseProblems(r.text || '')
  const working = extractWorkingWell(r.text || '')

  if (!problems.length) {
    target.innerHTML = `
      <div class="tab-placeholder">
        <div class="ph-icon">◌</div>
        <div class="ph-title">No problems parsed</div>
        <div class="ph-sub">The model's response didn't include any "## Problem N:" headers. Raw response below.</div>
        <pre style="margin-top:20px;max-width:800px;padding:14px;background:#141414;border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:var(--mono);font-size:12px;white-space:pre-wrap;text-align:left;">${escapeHtml(r.text || '(empty)')}</pre>
      </div>`
    return
  }

  const cards = problems.map((p, i) => {
    const meta = PROBLEM_TYPE_META[p.type] || PROBLEM_TYPE_META.OTHER
    return `
      <div class="widget problem-card ${meta.hue}">
        <h3 class="widget-h">
          <span class="problem-num">PROBLEM ${i + 1}</span>
          <span class="problem-tag ${meta.hue}">${escapeHtml(meta.label)}</span>
          <span class="problem-title">${escapeHtml(p.title)}</span>
        </h3>
        <div class="widget-body problem-body">${renderMarkdown(p.body)}</div>
      </div>`
  }).join('')

  const wellBlock = working
    ? `<div class="widget working-well">
         <div class="ww-h">WORKING WELL</div>
         <div class="ww-body">${escapeHtml(working)}</div>
       </div>`
    : ''

  target.innerHTML = `
    <div class="ai-stack">
      ${cards}
      ${wellBlock}
    </div>`
}

// ─── Dashboard tab (5 widgets) ──────────────────────────────────────
function renderDashboardTab(target, r) {
  const mode = VALID_MODES.includes(r.mode) ? r.mode : 'both'
  const chainHtml = mode === 'beat' ? '' : renderVocalChain(r.vocalChain, r.vocalChainBuses)
  const chartHtml = renderTonalChart(r.audio, r.suggestions)
  const suggestionsHtml = renderSuggestions(r.suggestions || [])
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
      <div class="widget w-tonal">
        <h3 class="widget-h">Tonal Profile</h3>
        <div class="widget-body">${chartHtml || '<div class="alerts-empty">No audio data.</div>'}</div>
      </div>
      <div class="widget w-suggest">
        <h3 class="widget-h">Suggested Changes</h3>
        <div class="widget-body"><div class="suggestions">${suggestionsHtml}</div></div>
      </div>
    </div>`

  wireChainTabs(target)
  wireSuggestions(target)
  wirePlayback(target)
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
      .filter((p) => p.enabled !== false)
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

// Header: analyze + close
$('btn-trigger').addEventListener('click', () => trigger())
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
  lastStatus = { phase: 'screenshot', seconds_remaining: 5 }
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
  // Avoid re-rendering the whole loading view every tick — just update text.
  const target = $('tab-content')
  if (target && target.querySelector('.loading-state')) {
    const { text, detail } = statusLine(s)
    target.querySelector('.status-text').textContent = text
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
  renderCurrentView()
})

window.mc.onError((e) => {
  if (cancelInFlight) return
  showError(e?.message ?? 'Unknown error')
})

// Initial paint
setTab('dashboard')
