// test_proq3.ts — Phase 3 test. Reads a live Pro-Q 3 via the bridge and runs
// the raw dump through proq3_map, printing the distilled EQ state.
//
//   npm run test:proq3
//
// Requires FL open with a Pro-Q 3 loaded and the MixCoach controller assigned.

import { getFlBridge } from '../src/main/flbridge'
import { isProQ3, mapProQ3, formatProQ3ForPrompt } from '../src/main/proq3_map'

async function main(): Promise<void> {
  const bridge = getFlBridge({ verbose: false }) // quiet — we want the mapped result
  bridge.open()

  const list = await bridge.listPlugins()
  const loc = list.plugins.find((p) => isProQ3(p.name))
  if (!loc) {
    console.error('No Pro-Q 3 found. Load one on an insert and retry.')
    bridge.close()
    process.exit(1)
  }
  console.log(`Found ${loc.name} at insert ${loc.mixer_track}, slot ${loc.slot}`)

  // Warm-up read: FL sometimes returns empty display strings on the first
  // read of a plugin; a throwaway read primes them.
  await bridge.readPlugin(loc.mixer_track, loc.slot)
  const dump = await bridge.readPlugin(loc.mixer_track, loc.slot)

  console.log(`\nRaw dump: ${dump.param_count} params total (FabFilter + FL MIDI block)`)

  const state = mapProQ3(dump)
  console.log('\n── Distilled Pro-Q 3 state ──')
  console.log(JSON.stringify(state, null, 2))

  console.log('\n── Gemini-facing line ──')
  console.log(formatProQ3ForPrompt(state, loc.mixer_track))

  if (state.displaysMissing) {
    console.log('\n⚠ displaysMissing=true — FL returned empty display strings (cold read).')
  }

  // Debug: per-band raw values for the key sub-params, so we can see the real
  // activation pattern (Used vs Enabled vs Shape) and calibrate the mapper.
  console.log('\n── Per-band raw values (bands 1–24) ──')
  const keys = ['used', 'enabled', 'shape', 'frequency', 'gain', 'q', 'dynamic range']
  const byBand = new Map<number, Record<string, { val: number; str: string }>>()
  for (const p of dump.params ?? []) {
    const m = /^Band\s+(\d+)\s+(.+?)\s*$/i.exec(p.name)
    if (!m) continue
    const n = parseInt(m[1], 10)
    const k = m[2].trim().toLowerCase()
    if (!keys.includes(k)) continue
    if (!byBand.has(n)) byBand.set(n, {})
    byBand.get(n)![k] = { val: p.val, str: p.str }
  }
  for (const n of [...byBand.keys()].sort((a, b) => a - b)) {
    const b = byBand.get(n)!
    const cell = (k: string) => (b[k] ? `${k}="${b[k].str.trim()}"(${b[k].val})` : `${k}=–`)
    console.log(`  Band ${String(n).padStart(2)}: ${keys.map(cell).join('  ')}`)
  }

  bridge.close()
  console.log('\nDone.')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
