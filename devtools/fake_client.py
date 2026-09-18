"""Manual smoke client:  python devtools/fake_client.py NAME
Joins, prints the welcome, then walks in a fixed direction for ~15 s."""
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "shared"))
import game_core.moves as M
import game_core.protocol as P
import websockets


async def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "wanderer"
    seq = 0
    async with websockets.connect("ws://localhost:8000/ws") as ws:
        await ws.send(P.pack_join(0, name))
        (self_id, tick, blob, color, sx, sy, sroom, syaw, got) = P.unpack_welcome(await ws.recv())
        print("JOINED", "pid=", self_id, "name=", repr(got), "at", (sx, sy), "room=", sroom)
        end = time.time() + 15
        while time.time() < end:
            seq += 1
            await ws.send(P.pack_input(seq, 1, 0, 0))
            m = await asyncio.wait_for(ws.recv(), 5)
            kind, t2, ack, conn, ops = P.unpack_state(m)
            mine = [op for op in ops if op[1] == self_id]
            now = t2
            if mine:
                print("t=%d ack=%d conn=%d me=%s" % (t2, ack, conn, list(mine[-1])))
            else:
                print("t=%d ack=%d conn=%d" % (t2, ack, conn))
        print("DONE")


if __name__ == "__main__":
    asyncio.run(main())
