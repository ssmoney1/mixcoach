# name=MixCoach
# url=
# supportedDevices=MixCoach In
#
# device_MixCoach.py  —  FL Studio MIDI controller script for MixCoach.
#
# PHASE 1 (read-only). This script runs INSIDE FL Studio's sandboxed Python
# MIDI scripting host. The Electron app cannot call FL's `plugins.*` API
# directly, so it talks to this script over two virtual MIDI ports
# (loopMIDI):
#
#   "MixCoach In"   Electron -> FL   (commands, as SysEx)
#   "MixCoach Out"  FL -> Electron   (responses, as SysEx; chunked)
#
# Wire protocol (all payload bytes are 7-bit ASCII JSON):
#
#   Command  (Electron -> FL):
#     F0 7D 4D 43 00 <ascii-json...> F7
#                  ^^ message type 0x00 = command
#
#   Response (FL -> Electron), one or more chunks:
#     F0 7D 4D 43 01 <idxHi> <idxLo> <totHi> <totLo> <ascii-json-chunk...> F7
#                  ^^ message type 0x01 = response chunk
#     idx/tot are 14-bit (hi<<7 | lo). Concatenate chunk payloads in idx
#     order until `tot` chunks are received, then JSON-parse the result.
#
#   0x7D       = SysEx "non-commercial / educational" manufacturer id
#   0x4D 0x43  = "MC" tag so we never react to unrelated SysEx traffic
#
# Commands supported:
#   {"action":"ping"}
#   {"action":"list_plugins"}
#   {"action":"read_plugin","mixer_track":<int>,"slot":<int>}
#   {"action":"set_param","mixer_track":<int>,"slot":<int>,"param":<int>,
#    "value":<float 0..1>}   <- Phase 5 WRITE. Only ever sent when the user
#                               clicks Apply; nothing is written autonomously.
#   (an optional "id" field on any command is echoed back on the response)
#
# Everything is wrapped in try/except and logged with print() so it shows in
# FL's script output window. The script must never crash FL.

import device
import plugins
import mixer

try:
    import json
    _HAVE_JSON = True
except Exception:
    _HAVE_JSON = False


# ── Protocol constants ────────────────────────────────────────────────
SYSEX_START = 0xF0
SYSEX_END = 0xF7
PRIVATE_ID = 0x7D          # non-commercial SysEx manufacturer id
TAG0 = 0x4D                # 'M'
TAG1 = 0x43                # 'C'
MSG_COMMAND = 0x00         # Electron -> FL
MSG_RESPONSE = 0x01        # FL -> Electron

MIXER_SLOTS = 10           # FX slots per mixer track in FL Studio
CHUNK_DATA = 200           # ASCII payload bytes per response chunk

# Echoed back onto the response when the incoming command carried an "id".
_current_id = None


def _log(msg):
    try:
        print("[MixCoach] " + str(msg))
    except Exception:
        pass


# ── FL Studio callbacks ───────────────────────────────────────────────
def OnInit():
    try:
        _log("OnInit - read-only plugin bridge loaded (Phase 1)")
        try:
            _log("Bound input device: " + str(device.getName()))
        except Exception:
            pass
        if not _HAVE_JSON:
            _log("WARNING: json module unavailable - using fallback encoder; "
                 "incoming commands cannot be parsed")
    except Exception as e:
        _log("OnInit error: " + repr(e))


def OnDeInit():
    _log("OnDeInit - bridge unloaded")


def OnMidiMsg(event):
    # MixCoach only cares about SysEx. SysEx is delivered to OnSysEx on modern
    # FL builds, but on some configurations it surfaces here with event.sysex
    # set — handle that too so we work either way.
    try:
        sysex = getattr(event, "sysex", None)
        if sysex:
            event.handled = True
            _handle_sysex(sysex)
    except Exception as e:
        _log("OnMidiMsg error: " + repr(e))


def OnSysEx(event):
    try:
        event.handled = True
        _handle_sysex(event.sysex)
    except Exception as e:
        _log("OnSysEx error: " + repr(e))


# ── SysEx decode / dispatch ───────────────────────────────────────────
def _handle_sysex(raw):
    try:
        b = list(bytearray(raw))
    except Exception as e:
        _log("could not read sysex bytes: " + repr(e))
        return
    # Minimum: F0 7D 4D 43 <type> F7
    if len(b) < 6 or b[0] != SYSEX_START or b[-1] != SYSEX_END:
        return
    if b[1] != PRIVATE_ID or b[2] != TAG0 or b[3] != TAG1:
        return  # not addressed to MixCoach
    msg_type = b[4]
    if msg_type != MSG_COMMAND:
        return
    payload = b[5:-1]
    text = "".join(chr(x & 0x7F) for x in payload)
    _log("RECV command (" + str(len(payload)) + " bytes): " + text)
    _dispatch(text)


def _dispatch(text):
    global _current_id
    _current_id = None
    if not _HAVE_JSON:
        _send_error("no_json", "json module unavailable in FL Python host")
        return
    try:
        cmd = json.loads(text)
    except Exception as e:
        _send_error("bad_json", repr(e))
        return
    if not isinstance(cmd, dict):
        _send_error("bad_command", "payload is not a JSON object")
        return
    _current_id = cmd.get("id")
    action = cmd.get("action")
    try:
        if action == "ping":
            _send_json({"ok": True, "action": "ping", "pong": True})
        elif action == "list_plugins":
            _do_list_plugins(cmd)
        elif action == "read_plugin":
            _do_read_plugin(cmd)
        elif action == "set_param":
            _do_set_param(cmd)
        else:
            _send_error("unknown_action", str(action))
    except Exception as e:
        _log("dispatch error: " + repr(e))
        _send_error("dispatch_failed", repr(e))


# ── Actions (READ-ONLY) ───────────────────────────────────────────────
def _do_list_plugins(cmd):
    found = []
    try:
        track_count = mixer.trackCount()
    except Exception:
        track_count = 126
    for track in range(track_count):
        for slot in range(MIXER_SLOTS):
            try:
                if plugins.isValid(track, slot):
                    found.append({
                        "mixer_track": track,
                        "slot": slot,
                        "name": plugins.getPluginName(track, slot),
                    })
            except Exception:
                continue
    _log("list_plugins -> " + str(len(found)) + " plugin(s) loaded")
    _send_json({
        "ok": True,
        "action": "list_plugins",
        "count": len(found),
        "plugins": found,
    })


def _do_read_plugin(cmd):
    try:
        track = int(cmd.get("mixer_track", -1))
        slot = int(cmd.get("slot", -1))
    except Exception:
        _send_error("bad_args", "mixer_track and slot must be integers")
        return
    if track < 0 or slot < 0:
        _send_error("bad_args", "mixer_track and slot are required")
        return

    try:
        valid = plugins.isValid(track, slot)
    except Exception as e:
        _send_error("isvalid_failed", repr(e))
        return
    if not valid:
        _send_json({
            "ok": False,
            "action": "read_plugin",
            "mixer_track": track,
            "slot": slot,
            "error": "no_plugin",
        })
        return

    name = ""
    try:
        name = plugins.getPluginName(track, slot)
    except Exception:
        pass
    try:
        count = plugins.getParamCount(track, slot)
    except Exception as e:
        _send_error("paramcount_failed", repr(e))
        return

    _log("read_plugin track=" + str(track) + " slot=" + str(slot) +
         " name='" + str(name) + "' params=" + str(count))

    params = []
    for p in range(count):
        try:
            pname = plugins.getParamName(p, track, slot)
        except Exception:
            pname = ""
        try:
            pval = float(plugins.getParamValue(p, track, slot))
        except Exception:
            pval = 0.0
        try:
            pstr = plugins.getParamValueString(p, track, slot)
        except Exception:
            pstr = ""
        params.append({
            "i": p,
            "name": pname,
            "val": round(pval, 6),
            "str": pstr,
        })

    _send_json({
        "ok": True,
        "action": "read_plugin",
        "mixer_track": track,
        "slot": slot,
        "plugin": name,
        "param_count": count,
        "params": params,
    })


# ── Write (Phase 5) ───────────────────────────────────────────────────
# Sets a single normalized parameter value and reads it straight back, so the
# caller can confirm the result and calibrate display values. This is the ONLY
# write path; it acts only when explicitly commanded (user clicks Apply).
def _do_set_param(cmd):
    try:
        track = int(cmd.get("mixer_track", -1))
        slot = int(cmd.get("slot", -1))
        param = int(cmd.get("param", -1))
        value = float(cmd.get("value"))
    except Exception:
        _send_error("bad_args", "mixer_track, slot, param, value required")
        return
    if track < 0 or slot < 0 or param < 0:
        _send_error("bad_args", "mixer_track, slot, param must be >= 0")
        return
    # Clamp to the normalized range.
    if value < 0.0:
        value = 0.0
    if value > 1.0:
        value = 1.0

    try:
        if not plugins.isValid(track, slot):
            _send_json({"ok": False, "action": "set_param",
                        "mixer_track": track, "slot": slot, "error": "no_plugin"})
            return
    except Exception as e:
        _send_error("isvalid_failed", repr(e))
        return

    try:
        # setParamValue(value, paramIndex, index, slotIndex)
        plugins.setParamValue(value, param, track, slot)
    except Exception as e:
        _send_error("setparam_failed", repr(e))
        return

    # Read back so the app can confirm + calibrate (display strings are
    # authoritative for Pro-Q 3; the normalized read can be unreliable).
    try:
        newval = float(plugins.getParamValue(param, track, slot))
    except Exception:
        newval = value
    try:
        newstr = plugins.getParamValueString(param, track, slot)
    except Exception:
        newstr = ""
    try:
        pname = plugins.getParamName(param, track, slot)
    except Exception:
        pname = ""
    _log("set_param track=" + str(track) + " slot=" + str(slot) +
         " param=" + str(param) + " value=" + str(value) +
         " -> '" + str(newstr) + "'")
    _send_json({"ok": True, "action": "set_param", "mixer_track": track,
                "slot": slot, "param": param, "name": pname,
                "requested": value, "val": round(newval, 6), "str": newstr})


# ── SysEx encode / send (chunked) ─────────────────────────────────────
def _send_error(code, detail):
    _send_json({"ok": False, "error": code, "detail": detail})


def _send_json(obj):
    if _current_id is not None and isinstance(obj, dict) and "id" not in obj:
        obj = dict(obj)
        obj["id"] = _current_id
    if _HAVE_JSON:
        try:
            text = json.dumps(obj, ensure_ascii=True, separators=(",", ":"))
        except Exception:
            text = _fallback_dumps(obj)
    else:
        text = _fallback_dumps(obj)
    _send_text(text)


def _send_text(text):
    # ensure_ascii guarantees < 0x80; the mask is belt-and-suspenders.
    data = [ord(c) & 0x7F for c in text]
    total = (len(data) + CHUNK_DATA - 1) // CHUNK_DATA
    if total == 0:
        total = 1
    _log("SEND response: " + str(len(data)) + " bytes in " +
         str(total) + " chunk(s)")
    for idx in range(total):
        chunk = data[idx * CHUNK_DATA:(idx + 1) * CHUNK_DATA]
        msg = [
            SYSEX_START, PRIVATE_ID, TAG0, TAG1, MSG_RESPONSE,
            (idx >> 7) & 0x7F, idx & 0x7F,
            (total >> 7) & 0x7F, total & 0x7F,
        ] + chunk + [SYSEX_END]
        try:
            device.midiOutSysex(bytes(msg))
        except Exception as e:
            _log("midiOutSysex failed on chunk " + str(idx) + ": " + repr(e))
            break


def _fallback_dumps(obj):
    # Minimal JSON encoder used only if FL's json module is missing, so even
    # error responses can still be emitted.
    if obj is True:
        return "true"
    if obj is False:
        return "false"
    if obj is None:
        return "null"
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if isinstance(obj, int):
        return str(obj)
    if isinstance(obj, float):
        return repr(obj)
    if isinstance(obj, str):
        out = ['"']
        for ch in obj:
            o = ord(ch)
            if ch == '"':
                out.append('\\"')
            elif ch == '\\':
                out.append('\\\\')
            elif o < 0x20 or o > 0x7E:
                out.append('\\u%04x' % o)
            else:
                out.append(ch)
        out.append('"')
        return "".join(out)
    if isinstance(obj, dict):
        return "{" + ",".join(
            _fallback_dumps(str(k)) + ":" + _fallback_dumps(v)
            for k, v in obj.items()
        ) + "}"
    if isinstance(obj, (list, tuple)):
        return "[" + ",".join(_fallback_dumps(v) for v in obj) + "]"
    return _fallback_dumps(str(obj))
