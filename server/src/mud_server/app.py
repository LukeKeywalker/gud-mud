import asyncio
import time
from contextlib import asynccontextmanager

from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from .config import CONFIG
from .connections import Client
from .game_loop import GameLoop

START = time.monotonic()
LOOP: GameLoop | None = None
_state = {"connected": 0, "bytes_out": 0}


async def healthz(request):
    return JSONResponse({
        "uptime_s": round(time.monotonic() - START, 1),
        "tick": LOOP.t if LOOP else 0,
        "connected": _state["connected"],
        "queue_max": 32,
        "bytes_out": _state["bytes_out"],
    })


def _valid_name(name: str) -> bool:
    return name and len(name) <= 24 and name.isascii() \
        and all(ord(ch) >= 0x20 for ch in name) and len(name.strip()) >= 1


async def ws_handler(ws: WebSocket):
    client = Client(ws=ws)
    await ws.accept()
    _state["connected"] += 1
    pump = None
    try:
        raw = await ws.receive()
        data = raw.get("bytes")
        if data is None:
            return
        import game_core.protocol as P
        try:
            P.check_frame_size(len(data))
        except ValueError:
            await ws.send_bytes(P.pack_kick(3, "frame too large"))
            return
        if data[0] != P.MSG_JOIN:
            return
        world_id, name = P.unpack_join(data)
        if world_id != 0 or not _valid_name(name):
            reason = 2 if world_id != 0 else 1
            await ws.send_bytes(P.pack_error(reason, "rejected"))
            return
        if LOOP is None:
            await ws.send_bytes(P.pack_error(2, "no world"))
            return
        if LOOP.online_name(name):
            await ws.send_bytes(P.pack_error(0, "name in use"))
            return
        ent = await LOOP.admit(client, name)
        await ws.send_bytes(P.pack_welcome(ent.pid, LOOP.t, LOOP.blob, ent.color,
                                           ent.x, ent.y, ent.room, ent.yaw, name))
        _state["bytes_out"] += 64
        pump = asyncio.create_task(LOOP._pump(client))
        while True:
            m = await ws.receive()
            d = m.get("bytes")
            if d is None:
                break
            try:
                P.check_frame_size(len(d))
            except ValueError:
                await ws.send_bytes(P.pack_kick(3, "frame too large"))
                return
            k = d[0]
            if k == P.MSG_INPUT:
                seq, dx, dy, yaw = P.unpack_input(d)
                import game_core.moves as M
                f = M.InputFrame(client.pid, seq, dx, dy, yaw)
                while client.q.full():
                    client.q.get_nowait()
                client.q.put_nowait(f)
            elif k == P.MSG_RESYNC_REQ:
                LOOP.request_resync(client)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if pump is not None:
            pump.cancel()
        if LOOP is not None:
            try:
                await LOOP.release(client)
            except Exception:
                pass
        _state["connected"] -= 1
        try:
            await ws.close()
        except Exception:
            pass


@asynccontextmanager
async def lifespan(_app):
    global LOOP
    from pathlib import Path
    from .worldio import build_seed_spec
    spec = build_seed_spec(Path(CONFIG.map_path))
    store = None
    try:
        from .persistence import PostgresStore
        import json
        from .worldio import spec_from_json, spec_to_json
        store = PostgresStore(CONFIG)
        await store.init()
        saved = await store.load_world_scene()
        if saved is not None:
            spec = spec_from_json(json.loads(saved))
        else:
            await store.save_world_scene(spec_to_json(spec))
    except Exception:
        store = None
    g = GameLoop(spec, store=store, tick_sec=CONFIG.tick_sec)
    if store is not None:
        for pid, name, color, room, x, y, yaw in await store.load_players():
            g.stored_players[name] = (pid, color, room, x, y, yaw)
        try:
            await store.save_npcs(g.world)
        except Exception:
            pass
        await store.load_npcs_into(g.world)
    LOOP = g
    task = asyncio.create_task(g.run())
    try:
        yield
    finally:
        task.cancel()
        await g.stop()
        if store is not None:
            await store.close()


def create_app() -> Starlette:
    return Starlette(lifespan=lifespan, routes=[
        Route("/healthz", healthz),
        WebSocketRoute("/ws", ws_handler),
        Mount("/", StaticFiles(directory=CONFIG.static_dir, html=True), name="static"),
    ])


app = create_app()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, port=CONFIG.port)
