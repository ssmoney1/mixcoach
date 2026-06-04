// test_flbridge.ts — standalone tester for the Electron-side MIDI bridge
// (Phase 2). Runs OUTSIDE Electron, under plain Node via tsx, importing the
// exact same src/main/flbridge.ts that the app will use.
//
// Prereqs (already installed if you ran the Phase 2 setup):
//   - loopMIDI running with "MixCoach In" / "MixCoach Out"
//   - FL Studio open, a project loaded, the MixCoach controller assigned
//   - FL's script output window visible to watch the [MixCoach] logs
//
// Run:
//   npm run test:flbridge
//   # or directly:
//   npx tsx fl_script/test_flbridge.ts
//
// It calls ping() first (round-trip check), then listPlugins(), and — if a
// Pro-Q 3 is found — readPlugin() on it to exercise multi-chunk reassembly.

import { getFlBridge } from '../src/main/flbridge'

async function main(): Promise<void> {
  const bridge = getFlBridge()

  console.log('Opening MixCoach MIDI bridge…')
  try {
    bridge.open()
  } catch (err) {
    console.error('\nFailed to open bridge:', (err as Error).message)
    process.exit(1)
  }

  // 1) ping — confirms the full app→FL→app round trip.
  console.log('\n=== 1) ping ===')
  try {
    const pong = await bridge.ping()
    console.log('ping result:', JSON.stringify(pong))
    if (!pong.ok || !pong.pong) {
      console.error('ping did not return pong:true — check the FL script.')
    }
  } catch (err) {
    console.error('ping FAILED:', (err as Error).message)
    bridge.close()
    process.exit(1)
  }

  // 2) list_plugins — find every loaded plugin and where it lives.
  console.log('\n=== 2) list_plugins ===')
  let proqLoc: { mixer_track: number; slot: number } | null = null
  try {
    const list = await bridge.listPlugins()
    console.log(`Found ${list.count} plugin(s):`)
    for (const p of list.plugins) {
      console.log(`   insert ${p.mixer_track}, slot ${p.slot}:  ${p.name}`)
    }
    const proq = list.plugins.filter((p) => /pro-?\s*q\s*3/i.test(p.name))
    if (proq.length) {
      console.log(
        `\nPro-Q 3 detected at: ${proq
          .map((p) => `insert ${p.mixer_track}/slot ${p.slot}`)
          .join(', ')}`
      )
      proqLoc = { mixer_track: proq[0].mixer_track, slot: proq[0].slot }
    } else {
      console.log('\n(No Pro-Q 3 detected. Load one on an insert to test read_plugin.)')
    }
  } catch (err) {
    console.error('list_plugins FAILED:', (err as Error).message)
    bridge.close()
    process.exit(1)
  }

  // 3) read_plugin — only if a Pro-Q 3 is present. Exercises chunked reassembly.
  if (proqLoc) {
    console.log(`\n=== 3) read_plugin (insert ${proqLoc.mixer_track}, slot ${proqLoc.slot}) ===`)
    try {
      const dump = await bridge.readPlugin(proqLoc.mixer_track, proqLoc.slot)
      if (dump.ok) {
        console.log(`${dump.plugin}: ${dump.param_count} params. First 12:`)
        for (const par of (dump.params ?? []).slice(0, 12)) {
          console.log(`   [${String(par.i).padStart(3)}] ${par.name}  =  ${par.str}  (${par.val})`)
        }
      } else {
        console.log('read_plugin returned not-ok:', JSON.stringify(dump))
      }
    } catch (err) {
      console.error('read_plugin FAILED:', (err as Error).message)
    }
  }

  bridge.close()
  console.log('\nDone.')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
