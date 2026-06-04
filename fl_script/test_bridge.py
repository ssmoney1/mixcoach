#!/usr/bin/env python3
"""
test_bridge.py  —  standalone tester for the MixCoach FL controller script
(Phase 1). Lets you exercise device_MixCoach.py over loopMIDI before the
Electron bridge (Phase 2) exists.

Setup:
    pip install mido python-rtmidi

Usage (run from a normal Windows terminal, with FL Studio open and the
MixCoach controller script assigned):

    python test_bridge.py ping
    python test_bridge.py list
    python test_bridge.py read <mixer_track> <slot>
    python test_bridge.py ports          # just list available MIDI ports

Examples:
    python test_bridge.py list
    python test_bridge.py read 13 0      # read insert 13, FX slot 1 (0-based)

It sends the command SysEx to "MixCoach In", then reassembles the chunked
SysEx response from "MixCoach Out" and pretty-prints the JSON.
"""

import sys
import json
import time

try:
    import mido
except ImportError:
    print("ERROR: mido is not installed. Run:  pip install mido python-rtmidi")
    sys.exit(1)

IN_PORT_HINT = "MixCoach In"     # Electron/this script -> FL  (we send here)
OUT_PORT_HINT = "MixCoach Out"   # FL -> Electron/this script  (we listen here)

PRIVATE_ID = 0x7D
TAG0, TAG1 = 0x4D, 0x43
MSG_COMMAND = 0x00
MSG_RESPONSE = 0x01

RESPONSE_TIMEOUT = 5.0  # seconds


def _find_port(names, hint):
    hint_l = hint.lower()
    # exact-ish match first, then substring
    for n in names:
        if n.lower() == hint_l:
            return n
    for n in names:
        if hint_l in n.lower():
            return n
    return None


def _encode_command(cmd_dict):
    text = json.dumps(cmd_dict, ensure_ascii=True, separators=(",", ":"))
    data = [PRIVATE_ID, TAG0, TAG1, MSG_COMMAND] + [ord(c) & 0x7F for c in text]
    return mido.Message("sysex", data=data)


def _collect_response(inport, deadline):
    """Reassemble chunked MSG_RESPONSE SysEx into a parsed JSON object."""
    chunks = {}
    total = None
    while time.time() < deadline:
        for msg in inport.iter_pending():
            if msg.type != "sysex":
                continue
            d = list(msg.data)  # mido strips F0/F7
            if len(d) < 5 or d[0] != PRIVATE_ID or d[1] != TAG0 or d[2] != TAG1:
                continue
            if d[3] != MSG_RESPONSE:
                continue
            idx = (d[4] << 7) | d[5]
            tot = (d[6] << 7) | d[7]
            payload = d[8:]
            total = tot
            chunks[idx] = "".join(chr(x) for x in payload)
            if len(chunks) >= tot:
                text = "".join(chunks[i] for i in range(tot))
                try:
                    return json.loads(text)
                except Exception as e:
                    print("Failed to parse reassembled JSON: %r" % e)
                    print("Raw text:\n" + text)
                    return None
        time.sleep(0.005)
    if total is None:
        print("TIMEOUT: no response from '%s' within %.1fs." %
              (OUT_PORT_HINT, RESPONSE_TIMEOUT))
        print("  - Is FL Studio open with the MixCoach controller assigned?")
        print("  - Are the loopMIDI ports named exactly and linked?")
    else:
        print("TIMEOUT: got %d of %d chunks." % (len(chunks), total))
    return None


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return

    in_names = mido.get_output_names()   # ports we can SEND to
    out_names = mido.get_input_names()   # ports we can RECEIVE from

    if args[0] == "ports":
        print("Output ports (we send to 'MixCoach In'):")
        for n in in_names:
            print("   " + n)
        print("Input ports (we listen on 'MixCoach Out'):")
        for n in out_names:
            print("   " + n)
        return

    if args[0] == "ping":
        cmd = {"action": "ping", "id": 1}
    elif args[0] == "list":
        cmd = {"action": "list_plugins", "id": 2}
    elif args[0] == "read":
        if len(args) < 3:
            print("usage: python test_bridge.py read <mixer_track> <slot>")
            return
        cmd = {"action": "read_plugin",
               "mixer_track": int(args[1]), "slot": int(args[2]), "id": 3}
    else:
        print("Unknown command: " + args[0])
        print(__doc__)
        return

    send_name = _find_port(in_names, IN_PORT_HINT)
    recv_name = _find_port(out_names, OUT_PORT_HINT)
    if not send_name:
        print("Could not find an output port matching '%s'." % IN_PORT_HINT)
        print("Available: " + ", ".join(in_names))
        return
    if not recv_name:
        print("Could not find an input port matching '%s'." % OUT_PORT_HINT)
        print("Available: " + ", ".join(out_names))
        return

    print("Sending on : " + send_name)
    print("Listening on: " + recv_name)

    with mido.open_input(recv_name) as inport, \
            mido.open_output(send_name) as outport:
        # Drain anything stale.
        for _ in inport.iter_pending():
            pass
        msg = _encode_command(cmd)
        print("SEND: " + json.dumps(cmd))
        outport.send(msg)
        result = _collect_response(inport, time.time() + RESPONSE_TIMEOUT)

    if result is not None:
        print("RECV:")
        print(json.dumps(result, indent=2))
        if cmd["action"] == "read_plugin" and result.get("ok"):
            print("\n-- param preview (first 12) --")
            for p in result.get("params", [])[:12]:
                print("  [%3d] %-28s val=%.4f  %s" %
                      (p["i"], p["name"][:28], p["val"], p["str"]))


if __name__ == "__main__":
    main()
