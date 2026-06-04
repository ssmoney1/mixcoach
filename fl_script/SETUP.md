# MixCoach ↔ FL Studio MIDI Bridge — Setup (Phase 1, read-only)

This connects MixCoach to FL Studio so it can **read** live plugin parameters
(e.g. FabFilter Pro-Q 3) from inside FL. Phase 1 is **read-only** — nothing is
ever written to your project.

FL Studio's Python MIDI scripting runs *inside* FL and is sandboxed, so the
Electron app can't call FL's `plugins.*` API directly. We bridge over two
virtual MIDI ports:

```
   Electron app  ──(command SysEx)──►  "MixCoach In"   ──►  FL Studio
   Electron app  ◄─(response SysEx)──  "MixCoach Out"  ◄──  FL Studio (this script)
```

You only need to do this setup once.

---

## 1. Install loopMIDI and create two ports

1. Download and install **loopMIDI** (Tobias Erichsen):
   https://www.tobias-erichsen.de/software/loopmidi.html
2. Launch loopMIDI. In the **"New port-name"** box at the bottom, create
   **two** ports, named **exactly** (case-sensitive, with the space):

   - `MixCoach In`
   - `MixCoach Out`

   Type each name, click the **+** button. You should see both listed.
   Leave loopMIDI running (it can minimize to the tray).

> Each loopMIDI port is a virtual cable: whatever one app *sends* to it,
> another app can *receive*. `MixCoach In` carries app→FL; `MixCoach Out`
> carries FL→app.

---

## 2. Install the controller script

Copy `device_MixCoach.py` (from this `fl_script/` folder) to:

```
Documents\Image-Line\FL Studio\Settings\Hardware\MixCoach\device_MixCoach.py
```

Create the `MixCoach` subfolder if it doesn't exist. The folder name and the
`device_` filename prefix both matter to FL.

> If you ever edit the script, copy the new version over the old one, then
> reload it in FL (re-select the controller type, or toggle the input device
> off/on, or restart FL). FL caches scripts.

---

## 3. Configure FL Studio MIDI settings

Open FL Studio → **Options → MIDI Settings**.

**Input** (top list):
1. Find **`MixCoach In`** in the *Input* list and click it.
2. Click **Enable** (the keyboard icon lights up).
3. Set **Controller type** to **`MixCoach`** (the dropdown lists installed
   scripts by their `# name=` — it will read *MixCoach*).
4. Set **Port** to a free number, e.g. **`220`**. Remember this number.

**Output** (bottom list):
1. Find **`MixCoach Out`** in the *Output* list and click it.
2. Click **Enable**.
3. Set its **Port** to the **same number** you used above (e.g. **`220`**).

> The matching port number is what links them: the script bound to the
> `MixCoach In` input sends its `device.midiOutSysex(...)` replies to the
> output device that shares the same port number — `MixCoach Out`.

Click **Refresh device list** if a port doesn't appear, and make sure
loopMIDI is running first.

---

## 4. Open the script output (log) window

The script logs everything with `print()`. To watch it:

- In **MIDI Settings**, with **`MixCoach In`** selected and **Controller
  type = MixCoach**, click the small **script/page icon** next to the
  *Controller type* dropdown. This opens the **`MixCoach` output** console.

> The exact control's placement varies slightly between FL versions; it's the
> little icon adjacent to the Controller-type dropdown that opens the script's
> output window. Once open, you'll see `[MixCoach] OnInit - ...` when the
> script loads. If you don't see it, toggle the `MixCoach In` input device
> off and on to force the script to reload and re-run `OnInit`.

A correct load logs:

```
[MixCoach] OnInit - read-only plugin bridge loaded (Phase 1)
[MixCoach] Bound input device: MixCoach In
```

---

## 5. Phase 1 manual test

You don't need the Electron app yet. Use the included `test_bridge.py`.

### One-time
In a normal Windows terminal (PowerShell/cmd) — **not** inside FL:

```powershell
pip install mido python-rtmidi
```

### A. Confirm the ports are visible
```powershell
python fl_script\test_bridge.py ports
```
You should see `MixCoach In` under output ports and `MixCoach Out` under
input ports. (loopMIDI may append a number like `MixCoach In 1` — the tester
matches by name substring, that's fine.)

### B. Ping — confirms the round trip works
With **FL Studio open** and the controller assigned:
```powershell
python fl_script\test_bridge.py ping
```
Expected:
- In FL's script output: `[MixCoach] RECV command ... {"action":"ping","id":1}`
  and `[MixCoach] SEND response: ... 1 chunk(s)`.
- In the terminal:
  ```json
  RECV:
  { "ok": true, "action": "ping", "pong": true, "id": 1 }
  ```

If `ping` times out, the link isn't right — re-check the port names, the
Controller type, and that both ports share the **same Port number**.

### C. List plugins — find where Pro-Q 3 lives
```powershell
python fl_script\test_bridge.py list
```
Returns every loaded mixer plugin with its insert (`mixer_track`) and `slot`.
Look for the FabFilter Pro-Q 3 entry and note its `mixer_track` and `slot`,
e.g.:
```json
{ "mixer_track": 13, "slot": 0, "name": "Pro-Q 3" }
```

> `slot` is **0-based** (slot 0 = the first/top FX slot on that insert).

### D. Read the Pro-Q 3 parameters — the actual Phase 1 goal
Using the track/slot from step C:
```powershell
python fl_script\test_bridge.py read 13 0
```
Expected: the full parameter dump, plus a preview of the first few params:
```
-- param preview (first 12) --
  [  0] Band 1 Used                  val=1.0000  On
  [  1] Band 1 Frequency             val=0.4123  300 Hz
  [  2] Band 1 Gain                  val=0.4500  -3.0 dB
  ...
```

**Success = you see real Pro-Q 3 band names, normalized values, and display
strings (Hz / dB) that change when you actually move bands in the plugin and
re-run the command.** That confirms the read path end-to-end.

---

## Files in this folder

| File | Purpose |
|------|---------|
| `device_MixCoach.py` | The FL Studio controller script (copy into the Hardware folder). Read-only plugin-parameter bridge. |
| `test_bridge.py` | Standalone Python tester (`ping` / `list` / `read`) to verify Phase 1 over loopMIDI without the Electron app. |
| `SETUP.md` | This file. |

---

## Troubleshooting

- **`ping` times out** — FL not open, controller type not set to MixCoach, the
  two ports don't share the same Port number, or loopMIDI wasn't running when
  FL started (Refresh device list, or restart FL).
- **No `[MixCoach]` logs at all** — script isn't loaded. Confirm the file is at
  `...\Settings\Hardware\MixCoach\device_MixCoach.py` and toggle the input
  device off/on. Check the first line is `# name=MixCoach`.
- **`read` returns `"error":"no_plugin"`** — wrong `mixer_track`/`slot`; run
  `list` again. Remember slot is 0-based.
- **`test_bridge.py` can't find ports** — run `... ports`; ensure loopMIDI
  shows both `MixCoach In` and `MixCoach Out`.
- **Garbled/688-param dumps** — that's normal; Pro-Q 3 exposes many params.
  Phase 3 (`proq3_map.ts`) distills them into a concise EQ summary.

---

## What's next (not built yet — do not start until Phase 1 is confirmed)

- **Phase 2** — `src/main/flbridge.ts`: the Electron side of this protocol.
- **Phase 3** — `src/main/proq3_map.ts`: turn the raw dump into a clean EQ state.
- **Phase 4** — feed that EQ state into the Gemini prompt.

Everything stays **read-only** until you explicitly approve adding write/control.
