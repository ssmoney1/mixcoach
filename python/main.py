"""MixCoach Python sidecar.

Spawned by the Electron main process on startup. Communicates over stdio
using newline-delimited JSON: each line from stdin is one request, each
line on stdout is one response.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from mixcoach import audio


def handle(request: dict[str, Any]) -> dict[str, Any]:
    method = request.get("method")
    params = request.get("params", {})
    request_id = request.get("id")

    if method == "ping":
        result: Any = {"pong": True}
    elif method == "analyze":
        result = audio.analyze(params.get("path", ""))
    else:
        return {"id": request_id, "error": f"unknown method: {method}"}

    return {"id": request_id, "result": result}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            response = handle(request)
        except Exception as exc:  # noqa: BLE001
            response = {"error": str(exc)}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
