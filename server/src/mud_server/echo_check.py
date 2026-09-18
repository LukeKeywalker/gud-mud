"""Devtool: connect to our own /ws, send a frame, assert it is echoed back.
Run from the server container:  python -m mud_server.echo_check"""
import asyncio
import websockets

FRAME = b"\x01\x00\x01"  # whatever; echo must return identical bytes

async def main() -> None:
    uri = "ws://127.0.0.1:%d/ws" % int(__import__("os").environ.get("MUD_PORT", "8000"))
    async with websockets.connect(uri) as ws:
        await ws.send(FRAME)
        got = await asyncio.wait_for(ws.recv(), 5.0)
        assert got == FRAME, f"echo mismatch: {got!r}"
    print("ECHO_OK")

if __name__ == "__main__":
    asyncio.run(main())
