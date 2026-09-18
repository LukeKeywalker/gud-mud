import time

from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles

from .config import CONFIG

START = time.monotonic()

class EchoState:
    connected = 0
    bytes_out = 0

async def healthz(request):
    return JSONResponse({
        "uptime_s": round(time.monotonic() - START, 1),
        "tick": 0,
        "connected": EchoState.connected,
        "queue_max": 32,
        "bytes_out": EchoState.bytes_out,
    })

async def ws_echo(ws):
    await ws.accept()
    EchoState.connected += 1
    try:
        while True:
            msg = await ws.receive()
            if msg.get("bytes") is not None:
                data = msg["bytes"]
                EchoState.bytes_out += len(data)
                await ws.send_bytes(data)
            elif msg.get("text") is not None:
                await ws.send_text(msg["text"])
            if msg.get("more_body") is False and "websocket.disconnect" in str(msg.get("type", "")):
                break
    finally:
        EchoState.connected -= 1

def create_app() -> Starlette:
    return Starlette(routes=[
        Route("/healthz", healthz),
        WebSocketRoute("/ws", ws_echo),
        Mount("/", StaticFiles(directory=CONFIG.static_dir, html=True), name="static"),
    ])

app = create_app()
