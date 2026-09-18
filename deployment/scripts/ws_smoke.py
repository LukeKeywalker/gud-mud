"""WebSocket smoke client: python deployment/scripts/ws_smoke.py [BASE_URL]

BASE_URL is the origin WITHOUT the /ws path (https://host or http://127.0.0.1:18000).
Joins the world, expects a welcome, then consumes state frames for ~15 s.
Exit 0 on success; non-zero on any protocol/timing failure.
"""
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))

import game_core.protocol as P  # noqa: E402


def build_ws_url(base: str) -> str:
    base = base.strip("/")
    scheme, host = base.split("://", 1)
    return f"{'wss' if scheme == 'https' else 'ws'}://{host}/ws"


async def main() -> None:
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18000"
    import websockets

    async with websockets.connect(build_ws_url(base), open_timeout=10) as ws:
        await ws.send(P.pack_join(0, "smoke"))
        welcome = P.unpack_welcome(await asyncio.wait_for(ws.recv(), 10))
        print("JOINED pid=%s tick=%s at=(%s,%s) room=%s name=%r"
              % (welcome[0], welcome[1], welcome[4], welcome[5],
                 welcome[6], welcome[8]))
        end = time.time() + 15
        frames = 0
        while time.time() < end:
            P.unpack_state(await asyncio.wait_for(ws.recv(), 10))
            frames += 1
    assert frames > 0, "received no state frames"
    print("OK frames=%d" % frames)


if __name__ == "__main__":
    asyncio.run(main())
