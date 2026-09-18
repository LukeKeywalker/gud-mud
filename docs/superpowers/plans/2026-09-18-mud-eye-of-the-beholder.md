# Eye-of-the-Beholder MUD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser FPS MUD (fog, flickering torch, stone rooms, live players, one patrolling blocker NPC) with a shared pure-Python `game_core` running natively on the server and in the browser via Pyodide, over a hand-rolled big-endian binary WebSocket protocol, with Postgres persistence.

**Architecture:** Single asyncio server at a fixed 20 Hz authoritative tick; integer 0.25 m tile-grid sim; room-based visibility with a 128-entity cap; server-authoritative movement with client prediction + reconciliation via sequence numbers and resync snapshots; `game_core` is pure stdlib Python with no I/O or RNG so one byte-identical file set serves CPython, Pyodide, and the parity test.

**Tech Stack:** Python 3.11+ (host venv) / 3.12 (container image), Starlette + uvicorn + websockets + asyncpg + psutil, Postgres 16 (docker), Pytest + pytest-asyncio, node + pyodide 0.26.4 (npm) for the native parity test, Three.js r160 (vendored), Pyodide v0.26.4 (CDN, service-worker cached), plain ES-module JS for the client, docker compose.

**Spec:** `docs/superpowers/specs/2026-09-18-mud-eye-of-the-beholder-design.md` — read it first; this plan implements it verbatim plus the small deltas noted in its §14.

## Global Constraints

- Host venv runs on Python 3.11+; the container image stays `python:3.12-slim`. `shared/game_core/` is **stdlib only, no I/O, no threads, no RNG, explicit ordered iteration** (spec §4). Any random input generators live in tests/devtools, never in `game_core`.
- Wire format: **big-endian, 1-byte kind**, one binary WS frame per message, 64 KB frame guard (spec §5).
- Tick rate **20 Hz (50 ms)**; tile **0.25 m**; `yaw16` = 0..2047 steps/turn; positions are integer tiles.
- Constants: `MAX_VISIBLE = 128`, send queue size **32** (drop-oldest), congestion kick after **2 s** full, entity ids: players 1..64999, NPC `65000`.
- Names: up to 24 chars, printable ASCII + space, at least one non-space after strip; online duplicate -> `0x21` error + close.
- Players walk through each other; the NPC is solid to everyone. `world_id` = 0 only in MVP.
- Pinned: **three@0.160.0** (vendored file), **pyodide v0.26.4** (browser CDN, and `pyodide@0.26.4` via npm for the native parity test).
- Movement rule: direction state `dx, dy` in {-1,0,1}; at most 1 tile/tick; fixed slide order **full -> x-only -> y-only**; NPC target check uses position at **t+1**.
- Latest-seq frame wins per player per tick.
- Commit after every task. Conventional messages: `feat:`, `test:`, `fix:`, `chore:`.

## File Structure

```
mud/
├── docker-compose.yml            # db (postgres:16-alpine) + server
├── Makefile                      # up / down / logs / test / sync-client / load
├── .gitignore
├── maps/starter.txt              # ASCII map ('#', 'A'-'T', 'd')
├── db/init.sql                   # Postgres schema (idempotent)
├── devtools/fake_client.py       # manual WS test driver (dev only, not shipped)
├── shared/game_core/
│   ├── __init__.py
│   ├── constants.py              # all wire/sim constants and codes
│   ├── world.py                  # WorldSpec/WorldState/Entity, parse, build, state_hash
│   ├── moves.py                  # InputFrame, npc_tile_at, try_move/try_move_at, step
│   ├── visibility.py             # room-graph distance + 128-capped visible entity pick
│   └── protocol.py               # every pack/unpack + world blob + 5-bit tiles
├── server/
│   ├── Dockerfile                # python:3.12-slim; COPY shared/, server/, client/static/
│   ├── pyproject.toml            # deps; packages: mud_server + game_core (via package-dir ../shared/game_core)
│   ├── src/mud_server/
│   │   ├── __init__.py
│   │   ├── config.py             # env-driven settings
│   │   ├── main.py               # Starlette app: /, /ws, /healthz + join handshake
│   │   ├── game_loop.py          # GameLoop: 20 Hz tick, deltas, caps, congestion
│   │   ├── connections.py        # Client dataclass + io helpers
│   │   ├── worldio.py            # build_seed_spec, spec_to_json/from_json
│   │   └── persistence.py        # PostgresStore; FakeStore used by tests
│   ├── tests/
│   │   ├── conftest.py           # sys.path bootstrap + small test map + fixtures
│   │   ├── test_world.py
│   │   ├── test_moves.py
│   │   ├── test_protocol.py
│   │   ├── test_determinism.py
│   │   ├── test_parity.py        # native vs Pyodide state-hash equality
│   │   ├── fake.py               # FakeWS + join_client() for engine tests
│   │   ├── test_engine.py        # GameLoop integration, non-DB
│   │   └── test_persistence.py   # GameLoop + FakeStore
│   └── loadtest/
│       ├── __init__.py
│       └── load.py               # in-container WS-client ramp + report
└── client/static/
    ├── index.html                # canvas + load overlay + pyodide script tag
    ├── styles.css
    ├── sw.js                     # cache-first for /game_core/ + jsdelivr pyodide
    ├── app.js                    # bootstrap, scene, input, prediction, reconcile, HUD
    ├── three.module.js           # vendored three@0.160.0
    └── game_core/                # synced copy of shared/game_core (make sync-client)
```

## Type / signature ledger (used across tasks — keep these exact)

- `WorldSpec(width, height, codes, rooms, npcs, props)` — frozen dataclass; `codes: tuple[int]` row-major with 0=wall, 1..20=room index, 21=doorway.
- `RoomRect(index, letter, x, y, w, h)`; `NpcDef(id, kind, route)` where `route: tuple[(x, y), ...]`; `PropDef(kind, x, y)`.
- `parse_map_text(text: str) -> WorldSpec` (npcs/props empty on return).
- `add_npc(spec: WorldSpec, npc: NpcDef) -> WorldSpec` (dataclasses.replace).
- `build_world(spec: WorldSpec) -> WorldState`.
- `WorldState` attrs: `spec`, `tick` (int, starts 0), `walls` (bytearray 1=blocked), `room_index` (bytearray tiles), `tile_remaining` per-tile room list (door -> frozenset), `adj` (dict room -> frozenset), `entities` (dict id -> Entity), `entity_order` (id-sorted list), `props` (tuple).
- `WorldState` methods: `in_bounds(x, y)`, `is_walkable(x, y)`, `room_index_of_tile(x, y)`, `visible_rooms_at(x, y)`, `add_entity(e)`, `remove_entity(id)`.
- `Entity(pid, name, room, x, y, yaw, color, is_npc)` — mutable dataclass; `yaw` is yaw16.
- `state_hash(w: WorldState) -> bytes` (16-byte blake2b).
- `InputFrame(pid, seq, dx, dy, yaw)` — frozen.
- `npc_tile_at(npc: NpcDef, tick: int) -> (x, y)` — pure ping-pong math.
- `try_move_at(w, x, y, dx, dy, tick) -> (nx, ny)` — pure, no mutation.
- `try_move(w, ent, dx, dy, tick) -> bool` — mutates `ent`.
- `EventMove(pid, x, y, room)`, `EventYaw(pid, yaw)`; `step(w, tick, frames) -> list` (exactly the ordering above; `w.tick = tick` on entry).
- `visible_entities(w, viewer: Entity, limit=MAX_VISIBLE) -> list[Entity]` (never includes viewer).
- `room_distance(adj: dict, a: int, b: int) -> int` (99 if unreachable).
- Protocol: `pack_join(world_id, name)`, `unpack_join(b)`; `pack_welcome(self_id, tick, blob, color, sx, sy, sroom, syaw, name)`, `unpack_welcome(b)`; `pack_input(seq, dx, dy, yaw)`, `unpack_input(b)`; `pack_state(tick, ack, connected, ops)` / `pack_resync(tick, ack, connected, ops)` (ops are packed bytes), `unpack_state(b) -> (kind, tick, ack, connected, ops)` with op tuples `(kind, pid, ...)`; `pack_op_move(pid, x, y, room)`, `pack_op_spawn(pid, x, y, room, yaw, color, name)`, `pack_op_despawn(pid)`, `pack_op_yaw(pid, yaw)`; `pack_kick(reason, msg)`, `pack_error(reason, msg)`, `unpack_*`; `pack_tiles(codes)`, `unpack_tiles(n, raw)`; `pack_world_blob(spec) -> bytes`, `unpack_world_blob(raw) -> WorldSpec`.
- `GameLoop(spec: WorldSpec, store, tick_sec: float)` (store may be `None`): `async run()`, `async stop()`, `async tick()`, `async admit(client: Client, name: str) -> Entity`, `async release(client: Client)`; attrs `world`, `clients` (dict pid->Client), `blob`, `t`, `stored_players` (dict name -> (pid, color, room, x, y, yaw)), `dirty` (set of (pid, name, color, room, x, y, yaw)), `bytes_out`.
- `Client` dataclass attrs: `ws`, `name`, `q` (`asyncio.Queue(maxsize=32)`), `pid` (int, 0 before admit), `ent` (Entity), `color`, `ack` (int, 0), `apply_ticks` (dict seq -> tick), `full` (bool), `full_since` (float or None).
- `PostgresStore(config)`: methods `async init()`, `async load_world_scene() -> str | None` (JSON), `async save_world_scene(json_str)`, `async load_players() -> list`, `async save_player(pid, name, color, room, x, y, yaw)`, `async save_dirty(items) -> int`, `async close()`. `FakeStore` mirrors the same signatures over in-memory structures.

## Task 0: Repo scaffold, docker compose, WS echo, healthz

**Files:**
- Create: `.gitignore`, `docker-compose.yml`, `Makefile`, `server/Dockerfile`, `server/pyproject.toml`, `server/src/mud_server/__init__.py`, `server/src/mud_server/config.py`, `server/src/mud_server/echo_check.py`, `server/src/mud_server/app.py`, `client/static/index.html`

**Interfaces:**
- Produces: `starlette.applications.Starlette` app bound to `mud_server.app.app` (uvicorn target `mud_server.app:app`); `GET /healthz` returns JSON with `uptime_s`, `tick`, `connected`, `queue_max`, `bytes_out`; `WS /ws` echoes raw binary frames at this stage; static files served from `MUD_STATIC` dir (default `client/static`); env config via `mud_server.config` reading `MUD_PORT` (8000), `MUD_STATIC`.

- [ ] **Step 1: Write `server/pyproject.toml`**

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "mud-server"
version = "0.1.0"
description = "Eye-of-the-Beholder MUD server"
requires-python = ">=3.11"
dependencies = [
  "uvicorn[standard]>=0.30",
  "starlette>=0.37",
  "asyncpg>=0.29",
  "websockets>=12",
  "psutil>=5.9",
]

[project.optional-dependencies]
dev = [
   "pytest>=8",
   "pytest-asyncio>=0.23",
]

[tool.setuptools]
packages = ["mud_server", "game_core"]

[tool.setuptools.package-dir]
"mud_server" = "src/mud_server"
"game_core" = "../shared/game_core"

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

- [ ] **Step 2: (no-op) `game_core` resolves via the package-dir mapping from Step 1**

No action needed. `game_core` resolves via the package-dir mapping set in Step 1; do NOT create any symlink under `server/src/`.

- [ ] **Step 3: Write `server/src/mud_server/config.py`**

```python
import os

def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)

def _env_int(name: str, default: int) -> int:
    return int(_env(name, str(default)))

class Config:
    def __init__(self) -> None:
        self.port = _env_int("MUD_PORT", 8000)
        self.db_dsn = _env("MUD_DB_DSN", "postgresql://mud:mud@localhost:5432/mud")
        self.static_dir = _env("MUD_STATIC", "client/static")
        self.save_interval = _env_float("MUD_SAVE_INTERVAL", "30")
        self.tick_sec = float(_env("MUD_TICK_SEC", "0.05"))

def _env_float(name: str, default: str) -> float:
    return float(_env(name, default))

CONFIG = Config()
```

- [ ] **Step 4: Write `server/src/mud_server/app.py` (echo + healthz only)**

```python
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
```

- [ ] **Step 5: Write `server/src/mud_server/__init__.py` (empty) and `server/src/mud_server/echo_check.py`**

`__init__.py`: an empty file.

`echo_check.py`:

```python
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
```

- [ ] **Step 6: Write `docker-compose.yml`**

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: mud
      POSTGRES_PASSWORD: mud
      POSTGRES_DB: mud
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mud"]
      interval: 5s
      timeout: 5s
      retries: 10

  server:
    build:
      context: .
      dockerfile: server/Dockerfile
    image: mud-server
    environment:
      MUD_PORT: "8000"
      MUD_DB_DSN: "postgresql://mud:mud@db:5432/mud"
      MUD_STATIC: "/app/client/static"
    ports:
      - "8000:8000"
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
```

- [ ] **Step 7: Write `server/Dockerfile`**

Replace the whole Dockerfile with exactly:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY shared /app/shared
COPY server /app/server
COPY client/static /app/client/static
COPY db /app/db
RUN pip install --no-cache-dir /app/server
EXPOSE 8000
CMD ["uvicorn", "mud_server.app:app", "--host", "0.0.0.0", "--port", "8000"]
```

No symlinks anywhere: `pip install` resolves `game_core` via package-dir `../shared/game_core`, which lands at `/app/shared/game_core` inside the image.

- [ ] **Step 8: Write `Makefile` and `.gitignore`**

`Makefile`:

```make
.PHONY: up down logs test venv sync-client load

venv:
	@test -d .venv || python3 -m venv .venv
	.venv/bin/pip install -q -e "server[dev]"

test: venv
	.venv/bin/python -m pytest server/tests -v

sync-client:
	rm -rf client/static/game_core
	cp -r shared/game_core client/static/game_core

up: sync-client
	docker compose build
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

load:
	docker compose exec -w /app/server server python -m loadtest.load $(LOAD_ARGS)
```

`.gitignore`:

```
__pycache__/
*.pyc
.venv/
.pytest_cache/
node_modules/
server/tests/parity/node_modules/
load_report.md
```

- [ ] **Step 9: Write a minimal `client/static/index.html` placeholder (placeholder only, real client in Task 6)**

```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>MUD</title></head>
<body style="background:#050505;color:#ddd;font-family:monospace">
  <h2>Eye of the Beholder (MUD) — placeholder</h2>
  <p>client lands in Tasks 6-8</p>
</body>
</html>
```

- [ ] **Step 10: Build and run; verify / healthz and WS echo**

Run:
```bash
docker compose build
docker compose up -d
sleep 3
curl -s http://localhost:8000/healthz
docker compose exec server python -m mud_server.echo_check
docker compose exec server curl -s http://localhost:8000/ ; echo
```
Expected:
- `/healthz` -> JSON containing `"connected": 0`
- echo_check -> prints `ECHO_OK` (proves `ws://localhost:8000/ws` echoes binary)
- root `GET /` -> returns the placeholder HTML (static served over HTTP)

If the placeholder is not served, StaticFiles needs `html=True` to serve `index.html` at `/`; verify per Step 4.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold docker compose, echo WS, healthz, static serving"
```


## Task 1: game_core constants + world (map parsing, build_world, state_hash)

**Files:**
- Create: `shared/game_core/__init__.py`, `shared/game_core/constants.py`, `shared/game_core/world.py`, `server/tests/conftest.py`, `server/tests/test_world.py`
- Modify: `server/pyproject.toml` (re-enable `game_core` package entry)

**Interfaces:**
- Consumes: nothing.
- Produces: all types in the ledger's `WorldSpec`/`WorldState`/`Entity` rows; `parse_map_text`, `add_npc`, `build_world`, `state_hash`.

- [ ] **Step 1: Write the failing tests** — `server/tests/conftest.py`

```python
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "shared"))

MAP = """\
#########
#AAAdBBB#
#AAAdBBB#
#AAAdBBB#
#########"""

def make_spec(npc: bool = True):
    import game_core.world as gw
    spec = gw.parse_map_text(MAP)
    if npc:
        spec = gw.add_npc(spec, gw.NpcDef(65000, "warden", ((2, 1), (3, 1))))
    return spec

@pytest.fixture
def spec():
    return make_spec()

@pytest.fixture
def world():
    import game_core.world as gw
    return gw.build_world(make_spec())
```

(The small map: 9x5. Rooms A (x1-3,y1-3) and B (x5-7,y1-3) with a 1-column doorway at x4. NPC ping-pongs between (2,1) and (3,1).)

- [ ] **Step 2: Write the failing tests** — `server/tests/test_world.py`

```python
import game_core.constants as C
import game_core.world as W

def test_parse_map_dims_and_rooms(spec):
    assert (spec.width, spec.height) == (9, 5)
    assert [(r.index, r.letter, r.x, r.y, r.w, r.h) for r in spec.rooms] == [
        (1, "A", 1, 1, 3, 3), (2, "B", 5, 1, 3, 3),
    ]

def test_bad_char_rejected():
    import pytest
    with pytest.raises(ValueError):
        W.parse_map_text("#.\n#.\n")  # '.' is not a legal tile in this format

def test_adjacency_via_doorway(world):
    assert world.adj[1] == frozenset({2})
    assert world.adj[2] == frozenset({1})

def test_walkability(world):
    assert world.is_walkable(2, 2)
    assert world.is_walkable(4, 1)
    assert not world.is_walkable(0, 0)
    assert not world.is_walkable(9, 2)

def test_room_index_of_tile(world):
    assert world.room_index_of_tile(2, 2) == 1
    assert world.room_index_of_tile(7, 2) == 2
    assert world.room_index_of_tile(4, 1) == 2  # doorway resolves to max room touching it

def test_visible_rooms_at(world):
    assert world.visible_rooms_at(2, 2) == frozenset({1, 2})
    assert world.visible_rooms_at(4, 1) == frozenset({1, 2})

def test_state_hash_stable_and_sensitive(spec):
    h1 = W.state_hash(W.build_world(spec))
    h2 = W.state_hash(W.build_world(spec))
    assert h1 == h2
    assert isinstance(h1, bytes) and len(h1) == 16
    w = W.build_world(spec)
    w.add_entity(W.Entity(90, "t", 1, 2, 2, 0, 7, False))
    assert W.state_hash(w) != h1

def test_entity_order_sorted(world):
    w = world
    w.add_entity(W.Entity(5, "a", 1, 2, 2, 0, 1, False))
    w.add_entity(W.Entity(120, "b", 1, 2, 2, 0, 1, False))
    w.add_entity(W.Entity(1, "c", 1, 2, 2, 0, 1, False))
    assert [e.pid for e in w.entity_order] == sorted(e.pid for e in w.entity_order)
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `make venv && .venv/bin/python -m pytest server/tests/test_world.py -q`
Expected: FAIL/ERROR with `No module named 'game_core'` (or collection error).

- [ ] **Step 4: Write `shared/game_core/constants.py`**

```python
TICK_HZ = 20
TILE_M = 0.25
STEPS_PER_TURN = 2048

MAX_VISIBLE = 128
SEND_QUEUE_MAX = 32
CONGESTION_KICK_SEC = 2.0
FRAME_MAX = 65536

PLAYER_PID_MAX = 64999
NPC_PID_BASE = 65000

NAME_MAX = 24

TILE_WALL = 0
TILE_DOOR = 21

MSG_JOIN = 1
MSG_WELCOME = 2
MSG_INPUT = 3
MSG_RESYNC_REQ = 4
MSG_STATE = 16
MSG_RESYNC = 17
MSG_KICK = 32
MSG_ERROR = 33

OP_MOVE = 0
OP_SPAWN = 1
OP_DESPAWN = 2
OP_YAW = 3

KICK_CONGESTION = 0
KICK_RESERVED = 1
KICK_SHUTDOWN = 2
KICK_OVERSIZED = 3

ERR_NAME_IN_USE = 0
ERR_BAD_NAME = 1
ERR_OTHER = 2

PALETTE = [
    0xE8D0A0, 0xB0553A, 0x4A7A8C, 0x6B8E4E,
    0x8C5A8C, 0xC97F4A, 0x5A8C5A, 0x8C8C3A,
    0xA06A8C, 0x4AC0C0, 0xC0C04A, 0xC04A6A,
]
```

- [ ] **Step 5: Write `shared/game_core/__init__.py` (empty) and `shared/game_core/world.py`**

```python
from __future__ import annotations

import hashlib
from dataclasses import dataclass, replace

from .constants import TILE_WALL, TILE_DOOR

ROOM_MIN, ROOM_MAX = 1, 20


@dataclass(frozen=True)
class RoomRect:
    index: int
    letter: str
    x: int
    y: int
    w: int
    h: int


@dataclass(frozen=True)
class NpcDef:
    id: int
    kind: str
    route: tuple  # tuple of (x, y)


@dataclass(frozen=True)
class PropDef:
    kind: int
    x: int
    y: int


@dataclass(frozen=True)
class WorldSpec:
    width: int
    height: int
    codes: tuple
    rooms: tuple
    npcs: tuple = ()
    props: tuple = ()


@dataclass
class Entity:
    pid: int
    name: str
    room: int
    x: int
    y: int
    yaw: int
    color: int
    is_npc: bool


def parse_map_text(text: str) -> WorldSpec:
    lines = [ln.rstrip("\n") for ln in text.split("\n")]
    lines = [ln for ln in lines if ln != ""]
    if not lines:
        raise ValueError("empty map")
    w = len(lines[0])
    for i, ln in enumerate(lines):
        if len(ln) != w:
            raise ValueError(f"uneven map row {i}")
    h = len(lines)
    codes = []
    bounds: dict[int, list[int]] = {}
    for y, ln in enumerate(lines):
        for x, ch in enumerate(ln):
            if ch == "#":
                codes.append(TILE_WALL)
            elif ch == "d":
                codes.append(TILE_DOOR)
            elif "A" <= ch <= "T":
                r = ord(ch) - ord("A") + 1
                codes.append(r)
                b = bounds.setdefault(r, [x, y, x, y])
                b[0] = min(b[0], x)
                b[1] = min(b[1], y)
                b[2] = max(b[2], x)
                b[3] = max(b[3], y)
            else:
                raise ValueError(f"bad map tile {ch!r} at ({x},{y})")
    rooms = tuple(
        RoomRect(i, chr(ord("A") + i - 1), b[0], b[1], b[2] - b[0] + 1, b[3] - b[1] + 1)
        for i, b in sorted(bounds.items())
    )
    return WorldSpec(w, h, tuple(codes), rooms, (), ())


def add_npc(spec: WorldSpec, npc: NpcDef) -> WorldSpec:
    return replace(spec, npcs=tuple(spec.npcs) + (npc,))


def add_prop(spec: WorldSpec, prop: PropDef) -> WorldSpec:
    return replace(spec, props=tuple(spec.props) + (prop,))


class WorldState:
    def __init__(self, spec: WorldSpec) -> None:
        self.spec = spec
        self.t = 0
        self.w, self.h = spec.width, spec.height
        n = self.w * self.h
        self.walls = bytearray(n)
        self.room_index = bytearray(n)
        self._tile_rooms: list[frozenset] = [frozenset() for _ in range(n)]
        adj: dict[int, set] = {r.index: set() for r in spec.rooms}
        for y in range(self.h):
            for x in range(self.w):
                c = spec.codes[y * self.w + x]
                if c == TILE_WALL:
                    self.walls[y * self.w + x] = 1
                elif c == TILE_DOOR:
                    around = []
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < self.w and 0 <= ny < self.h:
                            rc = spec.codes[ny * self.w + nx]
                            if ROOM_MIN <= rc <= ROOM_MAX:
                                around.append(rc)
                    self._tile_rooms[y * self.w + x] = frozenset(around)
                    for a in around:
                        for b in around:
                            if a != b:
                                adj[a].add(b)
                else:
                    self.room_index[y * self.w + x] = c
        self.adj = {k: frozenset(v) for k, v in adj.items()}
        self.entities: dict[int, Entity] = {}
        self.entity_order: list[Entity] = []
        self.props = spec.props
        for np_ in spec.npcs:
            x, y = np_.route[0]
            self.add_entity(Entity(np_.id, np_.kind, self.room_index_of_tile(x, y), x, y, 0, 0, True))

    def in_bounds(self, x: int, y: int) -> bool:
        return 0 <= x < self.w and 0 <= y < self.h

    def is_walkable(self, x: int, y: int) -> bool:
        return self.in_bounds(x, y) and not self.walls[y * self.w + x]

    def room_index_of_tile(self, x: int, y: int) -> int:
        i = y * self.w + x
        c = self.spec.codes[i]
        if c == TILE_DOOR:
            tiles = self._tile_rooms[i]
            if not tiles:
                raise ValueError(f"doorway at ({x},{y}) touches no rooms")
            return max(tiles)
        if not (ROOM_MIN <= c <= ROOM_MAX):
            raise ValueError(f"not a floor tile at ({x},{y})")
        return c

    def visible_rooms_at(self, x: int, y: int) -> frozenset:
        i = y * self.w + x
        c = self.spec.codes[i]
        if c == TILE_DOOR:
            return self._tile_rooms[i]
        return frozenset({c}) | self.adj.get(c, frozenset())

    def add_entity(self, e: Entity) -> None:
        if e.pid in self.entities:
            raise ValueError(f"duplicate pid {e.pid}")
        self.entities[e.pid] = e
        self.entity_order.append(e)
        self.entity_order.sort(key=lambda e: e.pid)

    def remove_entity(self, pid: int) -> None:
        e = self.entities.pop(pid)
        self.entity_order.remove(e)


def build_world(spec: WorldSpec) -> WorldState:
    ws = WorldState(spec)
    return ws


def state_hash(w: WorldState) -> bytes:
    h = hashlib.blake2b(digest_size=16)
    h.update(bytes(w.spec.codes))
    for e in w.entity_order:
        h.update(bytes([e.pid & 0xFF, (e.pid >> 8) & 0xFF]))
        h.update(bytes([e.x & 0xFF, (e.x >> 8) & 0xFF, e.y & 0xFF, (e.y >> 8) & 0xFF]))
        h.update(bytes([e.room & 0xFF, (e.room >> 8) & 0xFF]))
        h.update(bytes([e.yaw & 0xFF, (e.yaw >> 8) & 0xFF]))
        h.update(e.name.encode("utf-8"))
        h.update(bytes([e.color & 0xFF, 1 if e.is_npc else 0]))
    h.update(w.t.to_bytes(4, "big"))
    return h.digest()
```

Note on the `state_hash` byte trick: it's a fixed-width big-endian-ish layout; what matters is determinism, not elegance. Keep it exactly as written so the parity test in Task 4 matches byte-for-byte across runtimes.

- [ ] **Step 6: Ensure `pyproject.toml` maps `game_core`**

In `server/pyproject.toml` keep:

```toml
[tool.setuptools]
packages = ["mud_server", "game_core"]

[tool.setuptools.package-dir]
"mud_server" = "src/mud_server"
"game_core" = "../shared/game_core"
```

(The package-dir mapping alone makes `game_core` importable; no symlink exists or should be created — verify by running the tests below.)

Run: `make test`

- [ ] **Step 7: Run tests, verify they pass**

Run: `python -m pytest server/tests/test_world.py -v`
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: game_core constants + world (map parse, build, state_hash)"
```

## Task 2: game_core moves + visibility (try_move, npc_tile_at, step, visible_entities)

**Files:**
- Create: `shared/game_core/moves.py`, `shared/game_core/visibility.py`, `server/tests/test_moves.py`, `server/tests/test_visibility.py`

**Interfaces:**
- Consumes: `WorldState`, `Entity`, `NpcDef`, `constants.*` (Task 1).
- Produces: `InputFrame`, `EventMove`, `EventYaw`, `npc_tile_at`, `try_move_at`, `try_move`, `step`, `visible_entities`, `room_distance`.

- [ ] **Step 1: Write the failing tests** — `server/tests/test_moves.py`

```python
import game_core.world as W


def put(world, x, y, pid=9001):
    e = W.Entity(pid, "P", world.room_index_of_tile(x, y), x, y, 0, 7, False)
    world.add_entity(e)
    return e


def test_move_free(world):
    from game_core.moves import try_move
    e = put(world, 2, 2)
    assert try_move(world, e, 1, 0, 3) is True
    assert (e.x, e.y) == (3, 2)


def test_wall_blocks(world):
    from game_core.moves import try_move
    e = put(world, 1, 1)
    assert try_move(world, e, -1, 0, 3) is False
    assert (e.x, e.y) == (1, 1)


def test_diagonal_falls_back_x_then_y(world):
    from game_core.moves import try_move
    e = put(world, 1, 1)
    assert try_move(world, e, -1, 1, 3) is True
    assert (e.x, e.y) == (1, 2)  # full (0,2) wall, x-only (0,3?) wall, y-only (1,2) ok


def test_all_blocked(world):
    from game_core.moves import try_move
    e = put(world, 1, 1)
    assert try_move(world, e, -1, -1, 3) is False


def test_npc_tile_at_ping_pong(world):
    from game_core.moves import npc_tile_at
    for i, n in enumerate(world.spec.npcs):
        assert npc_tile_at(n, 0) == (2, 1)
        assert npc_tile_at(n, 1) == (3, 1)
        assert npc_tile_at(n, 5) == (3, 1)


def test_npc_blocks_target_next_tick(world):
    from game_core.moves import try_move
    e = put(world, 1, 1)
    # npc at t+1==2 is (2,1)
    assert try_move(world, e, 1, 0, 1) is False
    assert (e.x, e.y) == (1, 1)


def test_npc_clear_allows(world):
    from game_core.moves import try_move
    e = put(world, 1, 1)
    # npc at t+1==3 is (3,1), so (2,1) is free
    assert try_move(world, e, 1, 0, 2) is True
    assert (e.x, e.y) == (2, 1)


def test_step_latest_seq_wins(world):
    from game_core.moves import step, InputFrame
    e = put(world, 2, 2)
    step(world, 4, [InputFrame(9001, 5, 1, 0, 0), InputFrame(9001, 9, -1, 0, 0)])
    assert (e.x, e.y) == (1, 2)  # only seq 9 applied
    evs = step(world, 5, [InputFrame(9001, 10, -1, 0, 0)])
    assert (e.x, e.y) == (1, 2)  # (0,2) wall
    assert len(evs) == 0


def test_step_move_and_yaw_events(world):
    from game_core.moves import step, InputFrame
    e = put(world, 2, 2)
    evs = step(world, 0, [InputFrame(9001, 1, 1, 0, 500)])
    kinds = sorted((type(v).__name__, getattr(v, "pid", None)) for v in evs)
    assert ("EventMove", 9001) in kinds
    assert ("EventYaw", 9001) in kinds
    assert e.yaw == 500


def test_step_events_ordered_by_pid(world):
    from game_core.moves import step, InputFrame
    a = put(world, 2, 2, pid=101)
    put(world, 5, 2, pid=102)
    evs = step(world, 0, [InputFrame(102, 1, 1, 0, 0), InputFrame(101, 1, 1, 0, 0)])
    pids = [v.pid for v in evs if type(v).__name__ == "EventMove"]
    assert pids == [101, 102]


def test_step_updates_world_tick(world):
    from game_core.moves import step, InputFrame
    step(world, 7, [])
    assert world.t == 7
```

- [ ] **Step 2: Write the failing tests** — `server/tests/test_visibility.py`

```python
def _put(world, x, y, pid):
    import game_core.world as W
    e = W.Entity(pid, "x", world.room_index_of_tile(x, y), x, y, 0, 1, False)
    world.add_entity(e)
    return e


def test_sees_adjacent_room(world):
    from game_core.visibility import visible_entities
    mate = _put(world, 7, 2, 555)
    viewer = _put(world, 2, 2, 111)
    ids = [e.pid for e in visible_entities(world, viewer)]
    assert 555 in ids
    assert 111 not in ids


def test_doorway_viewer_sees_both_rooms(world):
    from game_core.visibility import visible_entities
    viewer = _put(world, 4, 1, 111)
    _put(world, 2, 2, 555)
    _put(world, 7, 2, 556)
    ids = [e.pid for e in visible_entities(world, viewer)]
    assert 555 in ids and 556 in ids


def test_cap_picks_by_distance_then_pid(world):
    import game_core.world as W
    from game_core.constants import MAX_VISIBLE
    from game_core.visibility import visible_entities
    for i in range(160):
        e = W.Entity(7000 + i, "x", 2, 5 + (i % 3), 1 + (i // 3) % 3, 0, 1, False)
        world.add_entity(e)
    viewer = _put(world, 2, 2, 111)
    vis = visible_entities(world, viewer)
    def dist(e):
        from game_core.visibility import room_distance
        return room_distance(world.adj, 1, e.room)
    assert len(vis) == MAX_VISIBLE
    ds = [dist(e) for e in vis]
    assert all(d <= 1 for d in ds)  # npc at distance 0 first; rest are room B (distance 1)
    assert vis[0].pid == 65000


def test_room_distance(world):
    from game_core.visibility import room_distance
    assert room_distance(world.adj, 1, 1) == 0
    assert room_distance(world.adj, 1, 2) == 1
    assert room_distance(world.adj, 1, 99) == 99
```

Note: in `test_cap_picks_by_distance_then_pid` all 160 added entities sit on the 9 walkable tiles of room B (overlapping is allowed for consumers). The NPC (65000) in room A is distance 0 and therefore sorted first.

- [ ] **Step 3: Run tests, verify they fail**

Run: `python -m pytest server/tests/test_moves.py server/tests/test_visibility.py -v`
Expected: FAIL with `ModuleNotFoundError: game_core.moves`.

- [ ] **Step 4: Write `shared/game_core/moves.py`**

```python
from __future__ import annotations

from dataclasses import dataclass

from .constants import OP_MOVE, OP_YAW
from .world import NpcDef, Entity, WorldState


@dataclass(frozen=True)
class InputFrame:
    pid: int
    seq: int
    dx: int
    dy: int
    yaw: int


@dataclass(frozen=True)
class EventMove:
    pid: int
    x: int
    y: int
    room: int


@dataclass(frozen=True)
class EventYaw:
    pid: int
    yaw: int


def npc_tile_at(npc: NpcDef, tick: int) -> tuple[int, int]:
    route = list(npc.route)
    L = len(route)
    if L == 1:
        x, y = route[0]
        return x, y
    span = L - 1
    t = tick % (2 * span)
    i = t if t <= span else 2 * span - t
    x, y = route[i]
    return x, y


def _ok_to_enter(w: WorldState, x: int, y: int, tick: int) -> bool:
    if not w.is_walkable(x, y):
        return False
    for npc in w.spec.npcs:
        if npc_tile_at(npc, tick) == (x, y):
            return False
    return True


def try_move_at(w: WorldState, x: int, y: int, dx: int, dy: int, tick: int) -> tuple[int, int]:
    if dx and dy:
        if _ok_to_enter(w, x + dx, y + dy, tick + 1):
            return x + dx, y + dy
        if _ok_to_enter(w, x + dx, y, tick + 1):
            return x + dx, y
        if _ok_to_enter(w, x, y + dy, tick + 1):
            return x, y + dy
        return x, y
    if dx or dy:
        if _ok_to_enter(w, x + dx, y + dy, tick + 1):
            return x + dx, y + dy
    return x, y


def try_move(w: WorldState, ent: Entity, dx: int, dy: int, tick: int) -> bool:
    nx, ny = try_move_at(w, ent.x, ent.y, dx, dy, tick)
    if (nx, ny) == (ent.x, ent.y):
        return False
    ent.x, ent.y = nx, ny
    ent.room = w.room_index_of_tile(nx, ny)
    return True


def step(w: WorldState, tick: int, frames: list[InputFrame]) -> list:
    w.t = tick
    for np_ in w.spec.npcs:
        e = w.entities.get(np_.id)
        if e is None:
            continue
        x, y = npc_tile_at(np_, tick)
        if (x, y) != (e.x, e.y):
            e.x, e.y = x, y
            e.room = w.room_index_of_tile(x, y)
    chosen: dict[int, InputFrame] = {}
    for f in frames:
        cur = chosen.get(f.pid)
        if cur is None or f.seq > cur.seq:
            chosen[f.pid] = f
    events: list = []
    for pid in sorted(chosen):
        f = chosen[pid]
        e = w.entities.get(pid)
        if e is None:
            continue
        moved = try_move(w, e, f.dx, f.dy, tick)
        if moved:
            events.append(EventMove(pid, e.x, e.y, e.room))
        if e.yaw != f.yaw:
            e.yaw = f.yaw
            events.append(EventYaw(pid, f.yaw))
    return events
```

Wait — event ordering: the tests expect `EventMove` before `EventYaw` per player and players in pid order. As written, a moved player would get `[EventMove, EventYaw]`, but `test_step_move_and_yaw_events` accepts either order (uses `in`). `test_step_events_ordered_by_pid` checks only move pids order. To make the order fully deterministic, keep move-then-yaw as written. Good.

- [ ] **Step 5: Write `shared/game_core/visibility.py`**

```python
from __future__ import annotations

from .constants import MAX_VISIBLE
from .world import Entity, WorldState


def room_distance(adj: dict, a: int, b: int) -> int:
    if a == b:
        return 0
    seen = {a: 0}
    frontier = [a]
    while frontier:
        nxt = []
        for cur in frontier:
            for nb in sorted(adj.get(cur, frozenset())):
                if nb in seen:
                    continue
                seen[nb] = seen[cur] + 1
                if nb == b:
                    return seen[nb]
                nxt.append(nb)
        frontier = nxt
    return 99


def visible_entities(w: WorldState, viewer: Entity, limit: int = MAX_VISIBLE) -> list[Entity]:
    vrooms = w.visible_rooms_at(viewer.x, viewer.y)
    others = []
    for e in w.entity_order:
        if e.pid == viewer.pid:
            continue
        if e.room not in vrooms:
            continue
        others.append(e)
    others.sort(key=lambda e: (room_distance(w.adj, viewer.room, e.room), e.pid))
    return others[:limit]
```

Note: `viewer.room` for a viewer standing on a doorway resolves to a single room via `room_index_of_tile`; `visible_rooms_at` still returns both. The distance origin uses `viewer.room` (the single resolved one) — deterministic.

- [ ] **Step 6: Run tests, verify they pass**

Run: `python -m pytest server/tests/test_moves.py server/tests/test_visibility.py -v`
Expected: all PASS. If `test_diagonal_falls_back_x_then_y` fails on the y-only assertion, double-check the map: from (1,1) with dx -1 dy 1, full target (0,2) wall, x-only target (0,2)? — x-only is (1-1, 1) = (0,1) wall; y-only is (1, 2) walkable -> expect (1,2). Good.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: game_core moves (try_move, npc_tile_at, step) + visibility (128-cap)"
```


## Task 3: game_core protocol (all pack/unpack, 5-bit tiles, world blob)

**Files:**
- Create: `shared/game_core/protocol.py`, `server/tests/test_protocol.py`

**Interfaces:**
- Consumes: `WorldSpec`, `constants.*` (Tasks 1-2).
- Produces: every `pack_*`/`unpack_*` in the ledger. Op tuples from `unpack_state`:
  - move:    `(0, pid, x, y, room)`
  - spawn:   `(1, pid, x, y, room, yaw, color, name_str)`
  - despawn: `(2, pid)`
  - yaw:     `(3, pid, yaw)`

- [ ] **Step 1: Write the failing tests** — `server/tests/test_protocol.py`

```python
import pytest
import game_core.protocol as P
import game_core.world as W


def sample_spec():
    return W.parse_map_text(
        "#########\n#AAAdBBB#\n#AAAdBBB#\n#AAAdBBB#\n#########"
    )


def test_join_roundtrip():
    b = P.pack_join(0, "Alice")
    assert b[0] == 1
    wid, name = P.unpack_join(b)
    assert wid == 0 and name == "Alice"


def test_input_golden_bytes():
    b = P.pack_input(7, 1, 0, 0x1234)
    assert b.hex() == "030000000701001234"


def test_input_roundtrip_neg():
    b = P.pack_input(1, -1, -1, 0)
    seq, dx, dy, yaw = P.unpack_input(b)
    assert (seq, dx, dy, yaw) == (1, -1, -1, 0)


def test_tiles_5bit_odd_length():
    codes = [1, 2, 3]  # 3 tiles x 5 bits = 15 data bits, padded by `(-len(bits) % 8)` = 1 bit, total 16 bits = 2 bytes
    raw = P.pack_tiles(codes)
    assert len(raw) == 2
    assert P.unpack_tiles(3, raw) == [1, 2, 3]


def test_tiles_5bit_roundtrip_larger():
    codes = list(range(1, 21)) * 4 + [21, 0] * 3
    raw = P.pack_tiles(codes)
    assert P.unpack_tiles(len(codes), raw) == codes


def test_world_blob_roundtrip():
    spec = sample_spec()
    blob = P.pack_world_blob(spec)
    back = P.unpack_world_blob(blob)
    assert back.width == spec.width and back.height == spec.height
    assert list(back.codes) == list(spec.codes)
    assert [(r.index, r.x, r.y, r.w, r.h) for r in back.rooms] == \
           [(r.index, r.x, r.y, r.w, r.h) for r in spec.rooms]


def test_world_blob_with_npc():
    spec = W.add_npc(sample_spec(), W.NpcDef(65000, "warden", ((2, 1), (3, 1))))
    blob = P.pack_world_blob(spec)
    back = P.unpack_world_blob(blob)
    assert len(back.npcs) == 1
    n = back.npcs[0]
    assert n.id == 65000 and n.kind == "warden"
    assert list(n.route) == [(2, 1), (3, 1)]


def test_state_roundtrip_all_ops():
    spec = sample_spec()
    ops = [
        P.pack_op_move(9, 1, 2, 1),
        P.pack_op_spawn(10, 3, 4, 2, 500, 200, "Bob"),
        P.pack_op_despawn(11),
        P.pack_op_yaw(9, 77),
    ]
    b = P.pack_state(42, 7, 3, ops)
    assert b[0] == 16
    kind, tick, ack, conn, back_ops = P.unpack_state(b)
    assert (kind, tick, ack, conn) == (16, 42, 7, 3)
    assert back_ops == [
        (0, 9, 1, 2, 1),
        (1, 10, 3, 4, 2, 500, 200, "Bob"),
        (2, 11),
        (3, 9, 77),
    ]


def test_resync_kind():
    b = P.pack_resync(1, 0, 1, [P.pack_op_spawn(1, 1, 1, 1, 0, 1, "A")])
    kind, = (b[0],)
    assert kind == 17
    kind, tick, ack, conn, ops = P.unpack_state(b)
    assert kind == 17 and tick == 1 and len(ops) == 1


def test_welcome_roundtrip():
    spec = sample_spec()
    blob = P.pack_world_blob(spec)
    b = P.pack_welcome(1, 5, blob, 200, 2, 2, 1, 0, "Alice")
    (self_id, tick, blob2, color, sx, sy, sroom, syaw, name) = P.unpack_welcome(b)
    assert self_id == 1 and tick == 5 and color == 200
    assert (sx, sy, sroom, syaw) == (2, 2, 1, 0)
    assert name == "Alice"
    assert blob2 == blob


def test_kick_error_roundtrip():
    b = P.pack_kick(0, "congestion")
    reason, msg = P.unpack_kick(b)
    assert (reason, msg) == (0, "congestion")
    assert b[0] == 32
    b = P.pack_error(1, "bad name")
    reason, msg = P.unpack_error(b)
    assert (reason, msg) == (1, "bad name")
    assert b[0] == 33


def test_bad_kind_raises():
    with pytest.raises(ValueError):
        P.unpack_state(b"\x99" + b"\x00" * 12)


def test_oversized_state_raises_or_truncates():
    # guard must reject frames above FRAME_MAX when the caller passes the flag
    with pytest.raises(ValueError):
        P.check_frame_size(70000)
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `python -m pytest server/tests/test_protocol.py -v`
Expected: FAIL with `ModuleNotFoundError: game_core.protocol`.

- [ ] **Step 3: Write `shared/game_core/protocol.py`**

```python
from __future__ import annotations

import struct

from .constants import (
    KICK_CONGESTION, MSG_JOIN, MSG_WELCOME, MSG_INPUT, MSG_STATE, MSG_RESYNC,
    MSG_KICK, MSG_ERROR, OP_MOVE, OP_SPAWN, OP_DESPAWN, OP_YAW, FRAME_MAX,
)
from .world import RoomRect, NpcDef, PropDef, WorldSpec


class Reader:
    __slots__ = ("b", "i")

    def __init__(self, b: bytes) -> None:
        self.b = b
        self.i = 0

    def u8(self) -> int:
        v = self.b[self.i]
        self.i += 1
        return v

    def u16(self) -> int:
        v = int.from_bytes(self.b[self.i:self.i + 2], "big")
        self.i += 2
        return v

    def u32(self) -> int:
        v = int.from_bytes(self.b[self.i:self.i + 4], "big")
        self.i += 4
        return v

    def i16(self) -> int:
        v = int.from_bytes(self.b[self.i:self.i + 2], "big", signed=True)
        self.i += 2
        return v

    def take(self, n: int) -> bytes:
        v = self.b[self.i:self.i + n]
        if len(v) != n:
            raise ValueError("truncated frame")
        self.i += n
        return v

    def rest(self) -> bytes:
        v = self.b[self.i:]
        self.i = len(self.b)
        return v


def check_frame_size(n: int) -> None:
    if n > FRAME_MAX:
        raise ValueError(f"frame too large: {n} > {FRAME_MAX}")


# ---- 5-bit tile packing -------------------------------------------------

def pack_tiles(codes) -> bytes:
    bits = "".join(format(c & 0x1F, "05b") for c in codes)
    bits += "0" * (-len(bits) % 8)
    if bits == "":
        return b""
    return int(bits, 2).to_bytes(len(bits) // 8, "big")


def unpack_tiles(n: int, raw: bytes) -> list[int]:
    v = int.from_bytes(raw, "big")
    s = format(v, "0%db" % (len(raw) * 8))
    return [int(s[i:i + 5], 2) for i in range(0, 5 * n, 5)]


# ---- join / input -------------------------------------------------------

def pack_join(world_id: int, name: str) -> bytes:
    nb = name.encode("utf-8")
    return bytes([MSG_JOIN]) + struct.pack(">HB", world_id, len(nb)) + nb


def unpack_join(b: bytes):
    r = Reader(b)
    k = r.u8()
    if k != MSG_JOIN:
        raise ValueError("not a join frame")
    wid = r.u16()
    nb = r.take(r.u8()).decode("utf-8")
    return wid, nb


def pack_input(seq: int, dx: int, dy: int, yaw: int) -> bytes:
    if not (-1 <= dx <= 1 and -1 <= dy <= 1):
        raise ValueError("dx/dy must be in -1..1")
    return bytes([MSG_INPUT]) + struct.pack(">IbbH", seq, dx, dy, yaw)


def unpack_input(b: bytes):
    r = Reader(b)
    k = r.u8()
    if k != MSG_INPUT:
        raise ValueError("not an input frame")
    seq = r.u32()
    dx, dy = struct.unpack_from(">bb", r.b, r.i)
    r.i += 2
    return seq, dx, dy, r.u16()


def pack_resync_req() -> bytes:
    return bytes([4])


# ---- ops ----------------------------------------------------------------

def _pack_op_move(pid, x, y, room):
    return bytes([OP_MOVE]) + struct.pack(">HhhH", pid, x, y, room)


def _pack_op_spawn(pid, x, y, room, yaw, color, name):
    nb = name.encode("utf-8")
    return (bytes([OP_SPAWN]) + struct.pack(">HhhHh", pid, x, y, room, yaw & 0x7FF)
            + color.to_bytes(3, "big")
            + struct.pack(">B", len(nb)) + nb)


def _pack_op_despawn(pid):
    return bytes([OP_DESPAWN]) + struct.pack(">H", pid)


def _pack_op_yaw(pid, yaw):
    return bytes([OP_YAW]) + struct.pack(">HH", pid, yaw & 0x7FF)


pack_op_move = _pack_op_move
pack_op_spawn = _pack_op_spawn
pack_op_despawn = _pack_op_despawn
pack_op_yaw = _pack_op_yaw


def _read_op(r: Reader):
    k = r.u8()
    if k == OP_MOVE:
        return (OP_MOVE, r.u16(), r.i16(), r.i16(), r.u16())
    if k == OP_SPAWN:
        pid, x, y, room, yaw = r.u16(), r.i16(), r.i16(), r.u16(), r.u16()
        color = int.from_bytes(r.take(3), "big")
        name = r.take(r.u8()).decode("utf-8")
        return (OP_SPAWN, pid, x, y, room, yaw, color, name)
    if k == OP_DESPAWN:
        return (OP_DESPAWN, r.u16())
    if k == OP_YAW:
        return (OP_YAW, r.u16(), r.u16())
    raise ValueError(f"bad op kind {k}")


# ---- state / resync -----------------------------------------------------

def pack_state(tick: int, ack: int, connected: int, ops: list) -> bytes:
    out = bytes([MSG_STATE]) + struct.pack(">IIHH", tick, ack, connected, len(ops))
    out += b"".join(ops)
    return out


def pack_resync(tick: int, ack: int, connected: int, ops: list) -> bytes:
    out = bytes([MSG_RESYNC]) + struct.pack(">IIHH", tick, ack, connected, len(ops))
    out += b"".join(ops)
    return out


def unpack_state(b: bytes):
    r = Reader(b)
    k = r.u8()
    if k not in (MSG_STATE, MSG_RESYNC):
        raise ValueError("not a state frame")
    tick, ack, connected, n = r.u32(), r.u32(), r.u16(), r.u16()
    ops = [_read_op(r) for _ in range(n)]
    return k, tick, ack, connected, ops


# ---- welcome ------------------------------------------------------------

def pack_welcome(self_id, tick, blob, color, sx, sy, sroom, syaw, name) -> bytes:
    nb = name.encode("utf-8")
    return (bytes([MSG_WELCOME]) + struct.pack(">IIH", self_id, tick, len(blob)) + blob
            + color.to_bytes(3, "big") + struct.pack(">hhHh", sx, sy, sroom, syaw)
            + struct.pack(">B", len(nb)) + nb)


def unpack_welcome(b: bytes):
    r = Reader(b)
    k = r.u8()
    if k != MSG_WELCOME:
        raise ValueError("not a welcome frame")
    self_id, tick = r.u32(), r.u32()
    blob = r.take(r.u16())
    color = int.from_bytes(r.take(3), "big")
    sx, sy, sroom, syaw = r.i16(), r.i16(), r.u16(), r.u16()
    name = r.take(r.u8()).decode("utf-8")
    return self_id, tick, blob, color, sx, sy, sroom, syaw, name


# ---- kick / error -------------------------------------------------------

def pack_kick(reason: int, msg: str) -> bytes:
    mb = msg.encode("utf-8")
    return bytes([MSG_KICK, reason]) + struct.pack(">B", len(mb)) + mb


def pack_error(reason: int, msg: str) -> bytes:
    mb = msg.encode("utf-8")
    return bytes([MSG_ERROR, reason]) + struct.pack(">B", len(mb)) + mb


def _unpack_reason_msg(b: bytes, expected: int):
    r = Reader(b)
    k = r.u8()
    if k != expected:
        raise ValueError(f"expected kind {expected}, got {k}")
    return r.u8(), r.take(r.u8()).decode("utf-8")


def unpack_kick(b: bytes):
    return _unpack_reason_msg(b, MSG_KICK)


def unpack_error(b: bytes):
    return _unpack_reason_msg(b, MSG_ERROR)


# ---- world blob ---------------------------------------------------------

def pack_world_blob(spec: WorldSpec) -> bytes:
    out = bytearray()
    out += struct.pack(">HHH", spec.width, spec.height, len(spec.codes))
    out += pack_tiles(spec.codes)
    out += bytes([len(spec.rooms)])
    for r in spec.rooms:
        out += struct.pack(">Bhhhh", r.index, r.x, r.y, r.w, r.h)
    out += bytes([len(spec.npcs)])
    for n in spec.npcs:
        kb = n.kind.encode("utf-8")
        out += struct.pack(">HB", n.id, len(kb)) + kb
        out += struct.pack(">H", len(n.route))
        for x, y in n.route:
            out += struct.pack(">hh", x, y)
    out += bytes([len(spec.props)])
    for p in spec.props:
        out += struct.pack(">Bhh", p.kind, p.x, p.y)
    return bytes(out)


def unpack_world_blob(raw: bytes) -> WorldSpec:
    r = Reader(raw)
    w, h, n = r.u16(), r.u16(), r.u16()
    codes = tuple(unpack_tiles(n, r.take((5 * n + 7) // 8)))
    nr = r.u8()
    rooms = tuple(
        RoomRect(ix, chr(ord("A") + ix - 1), x, y, rw, rh)
        for ix, x, y, rw, rh in (
            (r.u8(), r.i16(), r.i16(), r.i16(), r.i16()) for _ in range(nr)
        )
    )
    nn = r.u8()
    npcs = []
    for _ in range(nn):
        nid = r.u16()
        kind = r.take(r.u8()).decode("utf-8")
        rl = r.u16()
        route = tuple((r.i16(), r.i16()) for _ in range(rl))
        npcs.append(NpcDef(nid, kind, route))
    np_ = r.u8()
    props = tuple(PropDef(r.u8(), r.i16(), r.i16()) for _ in range(np_))
    return WorldSpec(w, h, codes, rooms, tuple(npcs), props)
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `python -m pytest server/tests/test_protocol.py -v`
Expected: all PASS. The golden byte test pins the exact wire layout.

- [ ] **Step 5: Full suite**

Run: `python -m pytest server/tests -v`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: game_core protocol (pack/unpack, 5-bit tiles, world blob)"
```

## Task 4: Determinism + native/Pyodide parity

**Files:**
- Create: `server/tests/test_determinism.py`, `server/tests/test_parity.py`, `server/tests/parity/runner.mjs`, `server/tests/parity/package.json` + `package-lock.json` (via npm; `node_modules/` is gitignored)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: two regression tests that gate the whole shared-logic design.

- [ ] **Step 1: Write `server/tests/test_determinism.py`**

```python
import random

import game_core.moves as M
import game_core.world as W
from conftest import make_spec


def _input_log(seed=1234, ticks=10000):
    rng = random.Random(seed)
    log = []
    for t in range(ticks):
        frames = []
        for pid in (1001, 1002, 1003):
            dx = rng.choice((-1, 0, 1))
            dy = rng.choice((-1, 0, 1))
            if dx == 0 and dy == 0:
                continue
            frames.append(M.InputFrame(pid, t * 10 + pid, dx, dy, rng.randrange(2048)))
        log.append(frames)
    return log


def _seed_players(w):
    for pid in (1001, 1002, 1003):
        w.add_entity(W.Entity(pid, "p%d" % pid, 1, 2, 2, 0, 7, False))


def test_determinism_replay_identical():
    log = _input_log()
    hashes = []
    for _ in range(2):
        w = W.build_world(make_spec())
        _seed_players(w)
        for t, frames in enumerate(log):
            M.step(w, t, frames)
        hashes.append(W.state_hash(w))
    assert hashes[0] == hashes[1]


def test_determinism_within_tick_order_insensitive():
    log = _input_log()
    w1 = W.build_world(make_spec())
    w2 = W.build_world(make_spec())
    _seed_players(w1)
    _seed_players(w2)
    for t, frames in enumerate(log):
        shuffled = list(frames)
        random.Random(t).shuffle(shuffled)
        M.step(w1, t, frames)
        M.step(w2, t, shuffled)
    assert W.state_hash(w1) == W.state_hash(w2)
```

- [ ] **Step 2: Run, verify it passes against the current impl (it should; this locks behavior in)**

Run: `python -m pytest server/tests/test_determinism.py -v`
Expected: PASS. (If it fails, that is a real determinism bug in Task 2's `step` — fix `step`, not the test.)

- [ ] **Step 3: Create `server/tests/parity/runner.mjs`**

```javascript
import { readFileSync } from "node:fs";
import { loadPyodide } from "pyodide";

const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pyo = await loadPyodide();
pyo.FS.mkdirTree("/mud/game_core");
for (const [path, enc] of Object.entries(payload.files)) {
  pyo.FS.writeFile(path, Buffer.from(enc, "base64"));
}
pyo.FS.writeFile("/mud/mud.pkl", Buffer.from(payload.pkl, "base64"));
pyo.FS.writeFile("/mud/mud.log", Buffer.from(payload.log, "base64"));
const hash = pyo.runPython(`
import sys, pickle, json
sys.path.insert(0, "/mud")
from game_core import world as W
from game_core import moves as M
spec = pickle.loads(open("/mud/mud.pkl", "rb").read())
w = W.build_world(spec)
for pid in (1001, 1002, 1003):
    w.add_entity(W.Entity(pid, "p", 1, 2, 2, 0, 7, False))
for t, frames in json.loads(open("/mud/mud.log", "rb").read()):
    M.step(w, t, [M.InputFrame(*f) for f in frames])
W.state_hash(w).hex()
`);
console.log("HASH " + hash);
```

(runPython returns the value of the last expression; the embedded python's final expression is `W.state_hash(w).hex()`. No print statement.)

- [ ] **Step 4: Install: `npm --prefix server/tests/parity install --save pyodide@0.26.4`**

Commit `server/tests/parity/package.json` and `package-lock.json` (node_modules/ is not committed).

- [ ] **Step 5: Write `server/tests/test_parity.py`**

Runs the *identical shared source files* under CPython and under Pyodide-in-Node (the `pyodide` npm package, run in a `node` subprocess) against the same input log, then compares `state_hash`.

```python
import base64
import json
import pickle
import shutil
import subprocess
from pathlib import Path

import pytest

import game_core.moves as M
import game_core.world as W
from conftest import make_spec

HERE = Path(__file__).resolve().parent
PARITY = HERE / "parity"


def _log():
    log = []
    for t in range(2000):
        frames = []
        for k, pid in enumerate((1001, 1002, 1003)):
            dx = (t + k) % 3 - 1
            dy = (t * 2 + k) % 3 - 1
            if dx == dy == 0:
                continue
            frames.append((pid, t * 10 + k, dx, dy, (t + k * 7) % 2048))
        log.append((t, frames))
    return log


def test_parity_native_vs_pyodide():
    if shutil.which("node") is None:
        pytest.skip("node unavailable")
    if not (PARITY / "node_modules" / "pyodide").exists():
        pytest.skip("npm pyodide not installed (run: npm --prefix server/tests/parity install)")
    spec = make_spec()
    log = _log()

    w = W.build_world(spec)
    for pid in (1001, 1002, 1003):
        w.add_entity(W.Entity(pid, "p", 1, 2, 2, 0, 7, False))
    for t, frames in log:
        M.step(w, t, [M.InputFrame(*f) for f in frames])
    native = W.state_hash(w).hex()

    shared = HERE.parents[1] / "shared" / "game_core"
    names = ("__init__.py", "constants.py", "world.py", "moves.py", "visibility.py", "protocol.py")
    payload = json.dumps({
        "files": {f"/mud/game_core/{n}": base64.b64encode((shared / n).read_bytes()).decode() for n in names},
        "pkl": base64.b64encode(pickle.dumps(spec)).decode(),
        "log": base64.b64encode(json.dumps(log).encode()).decode(),
    })
    (PARITY / "payload.json").write_text(payload)
    r = subprocess.run(["node", "runner.mjs", "payload.json"], cwd=str(PARITY),
                       capture_output=True, text=True, timeout=600)
    assert r.returncode == 0, (r.stdout, r.stderr)
    got = [l for l in r.stdout.strip().splitlines() if l.startswith("HASH ")]
    assert got and got[-1] == "HASH " + native, f"parity mismatch: native={native} pyodide={got}"
```

Note: `HERE` is `server/tests`, so the repo root (which contains `shared/`) is `HERE.parents[1]`. The test skips itself if `node` is unavailable or the npm `pyodide` package is not installed (run Step 4 first), so the rest of the suite still runs. The `state_hash` comparison is the point; do not weaken it.

- [ ] **Step 6: Run the parity test (downloads Pyodide once, ~big)**

Run: `python -m pytest server/tests/test_parity.py -v -s`
Expected: PASS (or skipped if `node` is unavailable or the npm `pyodide` package is missing — first run `npm --prefix server/tests/parity install --save pyodide@0.26.4`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test: game_core determinism (10k replay) + native/Pyodide parity"
```


## Task 5: Server engine — 20 Hz loop, deltas, caps, congestion, join handshake

**Files:**
- Create: `maps/starter.txt`, `server/src/mud_server/worldio.py`, `server/src/mud_server/connections.py`, `server/src/mud_server/game_loop.py`, `server/tests/fake.py`, `server/tests/test_engine.py`, `devtools/fake_client.py`
- Modify: `server/src/mud_server/config.py` (add `map_path`), `server/src/mud_server/app.py` (real `/ws` + lifespan), `docker-compose.yml` (mount `./maps`, `MUD_MAP`), `server/Dockerfile` (COPY maps)

**Interfaces:**
- Consumes: `game_core.*` (Tasks 1–3), Task 0 scaffold.
- Produces: `Client` dataclass; `GameLoop` with the ledger signatures plus asset (used in Task 5 tests); `build_seed_spec(path) -> WorldSpec`.
- In this task the server runs **without a DB** (`store=None`). Task 6 wires in `PostgresStore`; the lifespan already anticipates it via `try/except ImportError`.

- [ ] **Step 1: Write `maps/starter.txt` (exactly this content — all rows 16 chars, 6 rooms A–F):**

```
################
#AAAA#BBBB#CCCC#
#AAAAdBBBBdCCCC#
#AAAA#BBBB#CCCC#
#AAAA#BBBB#CCCC#
###d####d####d##
#DDDD#EEEE#FFFF#
#DDDDdEEEEdFFFF#
#DDDD#EEEE#FFFF#
#DDDD#EEEE#FFFF#
################
```

Rooms: A(x1-4,y1-4) B(x6-9,y1-4) C(x11-14,y1-4) D(x1-4,y6-9) E(x6-9,y6-9) F(x11-14,y6-9). Door: vertical between A|B and B|C at row y2 (x5,x10), and D|E, E|F at row y7; horizontal between the two rows, room-center columns x3, x8, x13 at row y5. Every `d` touches exactly two different rooms.

- [ ] **Step 2: Update `server/src/mud_server/config.py`** (replace file)

```python
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


class Config:
    def __init__(self) -> None:
        self.port = int(os.environ.get("MUD_PORT", "8000"))
        self.db_dsn = os.environ.get("MUD_DB_DSN", "postgresql://mud:mud@db:5432/mud")
        self.static_dir = os.environ.get("MUD_STATIC", str(ROOT / "client" / "static"))
        self.map_path = os.environ.get("MUD_MAP", str(ROOT / "maps" / "starter.txt"))
        self.save_interval = float(os.environ.get("MUD_SAVE_INTERVAL", "30"))
        self.tick_sec = float(os.environ.get("MUD_TICK_SEC", "0.05"))


CONFIG = Config()
```

- [ ] **Step 3: Write `server/src/mud_server/worldio.py`**

```python
from pathlib import Path

from game_core import world as W


def build_seed_spec(path: Path) -> W.WorldSpec:
    """Parse the ASCII map and attach the default patrolling NPC (id 65000)
    inside room A. Deterministic: no RNG anywhere in this path."""
    text = Path(path).read_text()
    spec = W.parse_map_text(text)
    a = next(r for r in spec.rooms if r.letter == "A")
    spec = W.add_npc(spec, W.NpcDef(65000, "warden", ((a.x + 1, a.y + 1), (a.x + 2, a.y + 1))))
    return spec
```

- [ ] **Step 4: Write `server/src/mud_server/connections.py`**

```python
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

SEND_QUEUE_MAX = 32


@dataclass
class Client:
    ws: Any
    name: str = ""
    pid: int = 0
    ent: Any = None
    color: int = 0
    ack: int = 0
    q: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=SEND_QUEUE_MAX))
    apply_ticks: dict = field(default_factory=dict)
    known: dict = field(default_factory=dict)
    resync: bool = False
    full_since: float | None = None
```

Note: `ent` is `game_core.world.Entity`. We type it as `Any` to avoid a useless import cycle (there is none). `known` is `pid -> (x, y, room, yaw)`, the last authoritative delta state emitted to this client. `resync` is a flag set by `request_resync`; consumed on the next tick.

- [ ] **Step 5: Write `server/src/mud_server/game_loop.py`** (single, coherent file — use exactly this)

```python
from __future__ import annotations

import asyncio
import time

import game_core.moves as M
import game_core.protocol as P
import game_core.visibility as V
import game_core.world as W
from game_core.constants import (
    CONGESTION_KICK_SEC, KICK_CONGESTION, KICK_SHUTDOWN, MAX_VISIBLE, PALETTE,
)

from .connections import Client


class GameLoop:
    def __init__(self, spec: W.WorldSpec, store=None, tick_sec: float = 0.050):
        import random

        self.spec = spec
        self.world = W.build_world(spec)
        self.store = store
        self.tick_sec = tick_sec
        self.t = 0
        self.clients: dict[int, Client] = {}
        self.stored_players: dict = {}
        self.blob = P.pack_world_blob(spec)
        self.stopped = False
        self.bytes_out = 0
        self._dirty: set = set()
        self._rng = random.Random(1234)
        self._save_at = time.monotonic() + 30.0
        self._next_pid = 1

    # ---- lifecycle -------------------------------------------------------

    async def run(self) -> None:
        while not self.stopped:
            t0 = time.monotonic()
            await self.tick()
            if self.store is not None and time.monotonic() >= self._save_at:
                self._save_at = time.monotonic() + 30.0
                items = list(self._dirty)
                self._dirty.clear()
                await self.store.save_dirty(items)
            delay = self.tick_sec - (time.monotonic() - t0)
            if delay > 0:
                await asyncio.sleep(delay)

    async def stop(self) -> None:
        self.stopped = True
        for c in list(self.clients.values()):
            try:
                await c.ws.send_bytes(P.pack_kick(KICK_SHUTDOWN, "server shutting down"))
                await c.ws.close()
            except Exception:
                pass
            await self.release(c)

    # ---- membership ------------------------------------------------------

    def online_name(self, name: str) -> bool:
        return any(c.name == name and c.ent is not None for c in self.clients.values())

    async def admit(self, client: Client, name: str) -> W.Entity:
        st = self.stored_players.get(name)
        if st is not None:
            pid, color, _room, x, y, yaw = st
        else:
            if self.store is not None:
                pid = await self.store.next_pid()
            else:
                pid = self._next_pid
                self._next_pid += 1
            a = next(r for r in self.spec.rooms if r.letter == "A")
            x = a.x
            y = a.y
            yaw = self._rng.randrange(2048)
            color = self._rng.choice(list(PALETTE))
        ent = W.Entity(pid, name, self.world.room_index_of_tile(x, y), x, y, yaw, color, False)
        self.world.add_entity(ent)
        client.pid, client.ent, client.color, client.name = pid, ent, color, name
        self.clients[pid] = client
        return ent

    async def release(self, client: Client) -> None:
        ent = client.ent
        if ent is not None:
            self.world.remove_entity(ent.pid)
            self.stored_players[client.name] = (ent.pid, ent.color, ent.room, ent.x, ent.y, ent.yaw)
            if self.store is not None:
                await self.store.save_player(ent.pid, client.name, ent.color, ent.room, ent.x, ent.y, ent.yaw)
            client.ent = None
        self.clients.pop(client.pid, None)

    def request_resync(self, client: Client) -> None:
        client.resync = True

    # ---- tick ------------------------------------------------------------

    async def tick(self) -> None:
        drained: list[tuple[Client, M.InputFrame]] = []
        for c in list(self.clients.values()):
            if c.ent is None:
                continue
            held = []
            while not c.q.empty():
                item = c.q.get_nowait()
                if isinstance(item, M.InputFrame):
                    drained.append((c, item))
                else:
                    held.append(item)
            for item in held:
                c.q.put_nowait(item)
        if drained:
            M.step(self.world, self.t, [f for _, f in drained])
            for c, f in drained:
                if f.pid == c.pid:
                    c.apply_ticks[f.seq] = self.t
                    if f.seq > c.ack:
                        c.ack = f.seq
        for c in list(self.clients.values()):
            if c.ent is None:
                continue
            full = False
            if c.resync:
                c.resync = False
                full = True
            ops = self._delta_ops(c)
            frame = P.pack_resync(self.t, c.ack, len(self.clients), ops) if full else P.pack_state(self.t, c.ack, len(self.clients), ops)
            self._send_queued(c, frame)
        await self._check_congestion()
        for e in self.world.entity_order:
            if not e.is_npc:
                self._dirty.add((e.pid, e.name, e.color, e.room, e.x, e.y, e.yaw))
        self.t += 1

    def _delta_ops(self, c: Client) -> list:
        self_ent = c.ent
        vis = V.visible_entities(self.world, self_ent, MAX_VISIBLE)
        current = {self_ent.pid: self_ent}
        for e in vis:
            current[e.pid] = e
        ops = []
        for pid in sorted(current):
            e = current[pid]
            prev = c.known.get(pid)
            if prev is None:
                ops.append(P.pack_op_spawn(pid, e.x, e.y, e.room, e.yaw, e.color, e.name))
            else:
                if prev[:3] != (e.x, e.y, e.room):
                    ops.append(P.pack_op_move(pid, e.x, e.y, e.room))
                    if prev[3] != e.yaw:
                        ops.append(P.pack_op_yaw(pid, e.yaw))
                elif prev[3] != e.yaw:
                    ops.append(P.pack_op_yaw(pid, e.yaw))
        for pid in sorted(set(c.known) - set(current)):
            ops.append(P.pack_op_despawn(pid))
        c.known = {pid: (e.x, e.y, e.room, e.yaw) for pid, e in current.items()}
        return ops

    def _send_queued(self, c: Client, frame: bytes) -> None:
        while c.q.full():
            c.q.get_nowait()  # drop-oldest under backpressure
        c.q.put_nowait(frame)
        self.bytes_out += len(frame)

    async def _pump(self, c: Client) -> None:
        """Drain this client's send queue to the socket (started by main)."""
        while True:
            frame = await c.q.get()
            if isinstance(frame, M.InputFrame):
                await c.q.put(frame)
                await asyncio.sleep(self.tick_sec)
                continue
            try:
                await c.ws.send_bytes(frame)
            except Exception:
                return

    async def flush(self, c: Client) -> None:
        """Test helper: synchronously drain the send queue to the (fake) ws."""
        while True:
            try:
                frame = c.q.get_nowait()
            except asyncio.QueueEmpty:
                return
            await c.ws.send_bytes(frame)

    async def _check_congestion(self) -> None:
        now = time.monotonic()
        for c in list(self.clients.values()):
            if not c.q.full():
                c.full_since = None
                continue
            if c.full_since is None:
                c.full_since = now
            elif now - c.full_since > CONGESTION_KICK_SEC:
                try:
                    await c.ws.send_bytes(P.pack_kick(KICK_CONGESTION, "congestion"))
                    await c.ws.close()
                except Exception:
                    pass
                full_since_done = c
                c.full_since = None
                await self.release(c)
```

- [ ] **Step 6: Write `server/tests/fake.py`**

```python
from mud_server.connections import Client


class FakeWS:
    def __init__(self):
        self.sent: list = []
        self.closed = False

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(bytes(data))

    async def send_text(self, text: str) -> None:
        raise AssertionError("no text frames in this MUD")

    async def close(self) -> None:
        self.closed = True


async def join_client(loop, name: str, start=None):
    c = Client(ws=FakeWS(), name=name)
    ent = await loop.admit(c, name)
    return c
```

- [ ] **Step 7: Write `server/tests/test_engine.py`**

```python
from conftest import MAP, make_spec
from fake import join_client, FakeWS
import game_core.protocol as P
import game_core.moves as M
import game_core.world as W
from mud_server.game_loop import GameLoop


async def _start():
    loop = GameLoop(make_spec())
    a = await join_client(loop, "Alice")
    b = await join_client(loop, "Bob")
    await loop.tick()
    await loop.flush(a)
    await loop.flush(b)
    return loop, a, b


def _last(c):
    return P.unpack_state(c.ws.sent[-1])


async def test_spawn_frame_three_entities():
    loop, a, b = await _start()
    kind, tick, ack, conn, ops = _last(b)
    assert kind == 16
    assert conn == 2
    spawns = [op for op in ops if op[0] == 1]
    spawn_ids = {op[1] for op in spawns}
    assert spawn_ids == {a.pid, b.pid, 65000}


async def test_move_seen_by_other_and_acked():
    loop, a, b = await _start()
    assert 65000 in {op[1] for op in _last(a)[4] if op[0] == 1}  # sanity
    a.ent.x, a.ent.y, a.ent.room = 1, 2, loop.world.room_index_of_tile(1, 2)
    a.q.put_nowait(M.InputFrame(a.pid, 1, 1, 0, 0))
    await loop.tick()
    await loop.flush(a)
    await loop.flush(b)
    moves = [op for op in _last(b)[4] if op[0] == 0 and op[1] == a.pid]
    assert moves == [(0, a.pid, 2, 2, 1)]
    kind, tick, ack, conn, ops = _last(a)
    assert ack == 1  # Alice's own frame was acked


async def test_npc_rejects_move_but_ack_advances():
    loop, a, b = await _start()
    a.ent.x, a.ent.y, a.ent.room = 1, 1, loop.world.room_index_of_tile(1, 1)
    a.q.put_nowait(M.InputFrame(a.pid, 1, 1, 0, 0))
    await loop.tick()
    await loop.flush(a)
    await loop.flush(b)
    moves = [op for op in _last(b)[4] if op[0] == 0 and op[1] == a.pid]
    assert moves == []
    assert (a.ent.x, a.ent.y) == (1, 1)
    kind, tick, ack, conn, ops = _last(a)
    assert ack == 1


async def test_resync_frame_is_full_snapshot():
    loop, a, b = await _start()
    b.known = {9999: (9, 9, 1, 0)}  # stale entry
    loop.request_resync(b)
    await loop.tick()
    await loop.flush(b)
    kind, tick, ack, conn, ops = _last(b)
    assert kind == 17
    spawn_ids = {op[1] for op in ops if op[0] == 1}
    assert b.pid in spawn_ids and 65000 in spawn_ids
    assert 9999 not in spawn_ids  # despawn-or-absent
    desps = {op[1] for op in ops if op[0] == 2}
    assert 9999 in desps


async def test_visibility_cap_128():
    loop = GameLoop(make_spec())
    a = await join_client(loop, "Alice")
    for i in range(300):
        loop.world.add_entity(W.Entity(9000 + i, "f%s" % i, 2, 5 + (i % 3), 1 + (i // 3) % 3, 0, 1, False))
    await loop.tick()
    await loop.flush(a)
    kind, tick, ack, conn, ops = _last(a)
    spawns = [op for op in ops if op[0] == 1]
    # self + npc (distance-0, picks first) + up to 127 others from room B
    assert len(spawns) == 129
    assert 65000 in {op[1] for op in spawns}


def test_starter_map_integrity():
    from pathlib import Path
    from mud_server.worldio import build_seed_spec
    p = Path(__file__).resolve().parents[2] / "maps" / "starter.txt"
    spec = build_seed_spec(p)
    assert (spec.width, spec.height) == (16, 11)
    assert len(spec.rooms) == 6
    letters = [r.letter for r in spec.rooms]
    assert letters == ["A", "B", "C", "D", "E", "F"]
    # every doorway touches exactly two distinct rooms
    for i, c in enumerate(spec.codes):
        if c == 21:
            x, y = i % spec.width, i // spec.width
            around = set()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < spec.width and 0 <= ny < spec.height:
                    rc = spec.codes[ny * spec.width + nx]
                    if 1 <= rc <= 20:
                        around.add(rc)
            assert len(around) == 2, f"doorway at ({x},{y}) touches {around}"
    assert len(spec.npcs) == 1
    assert spec.npcs[0].id == 65000
```

- [ ] **Step 8: Write the real `server/src/mud_server/app.py` (replace the file)**

```python
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
```

- [ ] **Step 9: Update compose and Dockerfile for the map**

`docker-compose.yml`: add to the `server` service — `environment: MUD_MAP: "/app/maps/starter.txt"`, and `volumes: - ./maps:/app/maps:ro`.

`server/Dockerfile`: add a `COPY maps /app/maps` line after the static copy.

- [ ] **Step 10: Write `devtools/fake_client.py`**

```python
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
```

- [ ] **Step 11: Run the engine tests, then a live smoke**

Run: `python -m pytest server/tests/test_engine.py server/tests/test_world.py -v`
Expected: all PASS.

Run (fresh image so it has the real server):
```bash
docker compose build
docker compose up -d
sleep 3
curl -s http://localhost:8000/healthz
python devtools/fake_client.py Alice
```
Expected: `GET /healthz` returns `{"tick": ...}`; fake_client prints `JOINED pid=1 name='Alice' at (x,y) room= 1` and then a stream of `t=... ack=... conn=1...` lines, with `me=` rows appearing as it walks. If the client raises on the first `recv`, check the server log: `docker compose logs server`.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: authoritative 20 Hz loop, deltas+caps, join handshake, engine tests"
# (only Stage the files in this task; if `git add -A` picked up unrelated WIP, use explicit paths instead)
```

## Task 6: Persistence — schema, seed, load-on-start, dirty-save, save-on-disconnect

**Files:**
- Create: `db/init.sql`, `server/src/mud_server/persistence.py`, `server/tests/test_persistence.py`
- Modify: `server/src/mud_server/worldio.py` (add `spec_to_json` / `spec_from_json`), `server/src/mud_server/app.py` (lifespan: `save_npcs` call)

**Interfaces:**
- Consumes: `PostgresStore` used by the lifespan already wired in Task 5 (dummy rows). Here it exists.
- Produces: `PostgresStore(config)` with the ledger's method signatures (plus `next_pid()` which `GameLoop.admit` already uses, and `load_npcs_into(world)` / `save_npcs(world)`).

> **Note about the pid:** the spec sketch used `SERIAL` for `players.id`. To make the "click-time pid allocation" race-free, the schema uses `INTEGER PRIMARY KEY` + a dedicated `pid_seq` (starting from 100). Rejoin restores row pid; a new player gets `nextval('pid_seq')`. `players.name` is the `UNIQUE` column the spec asked for.

- [ ] **Step 1: Write `db/init.sql`**

```sql
CREATE SEQUENCE IF NOT EXISTS pid_seq START 100;

CREATE TABLE IF NOT EXISTS worlds (
  id      SMALLINT PRIMARY KEY,
  name    TEXT NOT NULL,
  seed    BIGINT,
  data    JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  color      INTEGER NOT NULL,
  room       SMALLINT NOT NULL,
  x          SMALLINT NOT NULL,
  y          SMALLINT NOT NULL,
  yaw        SMALLINT NOT NULL,
  dirty      BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS npcs (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  room       SMALLINT NOT NULL,
  x          SMALLINT NOT NULL,
  y          SMALLINT NOT NULL,
  data       JSONB NOT NULL,
  dirty      BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Add JSON helpers to `server/src/mud_server/worldio.py`** (append to the existing file)

```python
def spec_to_json(spec) -> str:
    import json
    return json.dumps({
        "w": spec.width, "h": spec.height,
        "codes": list(spec.codes),
        "rooms": [[r.index, r.letter, r.x, r.y, r.w, r.h] for r in spec.rooms],
        "npcs": [[n.id, n.kind, [[x, y] for (x, y) in n.route]] for n in spec.npcs],
        "props": [[p.kind, p.x, p.y] for p in spec.props],
    })


def spec_from_json(d: dict):
    from game_core import world as W
    rooms = tuple(W.RoomRect(ix, ch, x, y, rw, rh) for (ix, ch, x, y, rw, rh) in d["rooms"])
    npcs = tuple(W.NpcDef(nid, kind, tuple((x, y) for (x, y) in route))
                 for (nid, kind, route) in d["npcs"])
    props = tuple(W.PropDef(k, x, y) for (k, x, y) in d["props"])
    return W.WorldSpec(d["w"], d["h"], tuple(d["codes"]), rooms, npcs, props)
```

- [ ] **Step 3: Write `server/src/mud_server/persistence.py`**

```python
from __future__ import annotations

import json
import time

import asyncpg

from .worldio import spec_from_json, spec_to_json


class PostgresStore:
    """Thin asyncpg wrapper. Schema is created by db/init.sql (docker) or by
    ensure_schema() below (manual / non-docker dev)."""

    DDL = [
        "CREATE SEQUENCE IF NOT EXISTS pid_seq START 100",
        """CREATE TABLE IF NOT EXISTS worlds (
          id SMALLINT PRIMARY KEY, name TEXT NOT NULL, seed BIGINT,
          data JSONB NOT NULL, version INTEGER NOT NULL DEFAULT 1)""",
        """CREATE TABLE IF NOT EXISTS players (
          id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, color INTEGER NOT NULL,
          room SMALLINT NOT NULL, x SMALLINT NOT NULL, y SMALLINT NOT NULL,
          yaw SMALLINT NOT NULL, dirty BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now())""",
        """CREATE TABLE IF NOT EXISTS npcs (
          id INTEGER PRIMARY KEY, kind TEXT NOT NULL, room SMALLINT NOT NULL,
          x SMALLINT NOT NULL, y SMALLINT NOT NULL, data JSONB NOT NULL,
          dirty BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now())""",
    ]

    def __init__(self, config) -> None:
        self.dsn = config.db_dsn
        self.save_interval = getattr(config, "save_interval", 30.0)
        self.pool: asyncpg.Pool | None = None
        self._dirty: set = set()

    async def init(self) -> None:
        self.pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=3)
        for stmt in self.DDL:
            await self.pool.execute(stmt)

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    # ---- world -----------------------------------------------------------

    async def load_world_scene(self):
        row = await self.pool.fetchrow("SELECT data FROM worlds WHERE id = 0")
        if row is None:
            return None
        data = row["data"]
        return data if isinstance(data, str) else json.dumps(data)

    async def save_world_scene(self, scene_json: str) -> None:
        await self.pool.execute(
            """INSERT INTO worlds (id, name, seed, data, version)
               VALUES (0, 'starter', NULL, $1, 1)
               ON CONFLICT (id) DO NOTHING""",
            scene_json,
        )

    # ---- players ---------------------------------------------------------

    async def next_pid(self) -> int:
        return await self.pool.fetchval("SELECT nextval('pid_seq')")

    async def load_players(self):
        rows = await self.pool.fetch(
            "SELECT id, name, color, room, x, y, yaw FROM players ORDER BY id")
        return [(r["id"], r["name"], r["color"], r["room"], r["x"], r["y"], r["yaw"])
                for r in rows]

    async def save_player(self, pid, name, color, room, x, y, yaw) -> None:
        await self.pool.execute(
            """INSERT INTO players (id, name, color, room, x, y, yaw, dirty, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, now())
               ON CONFLICT (name) DO UPDATE SET
                 id = EXCLUDED.id, color = EXCLUDED.color, room = EXCLUDED.room,
                 x = EXCLUDED.x, y = EXCLUDED.y, yaw = EXCLUDED.yaw,
                 dirty = FALSE, updated_at = now()""",
            pid, name, color, room, x, y, yaw,
        )

    async def save_dirty(self, items) -> int:
        n = 0
        for pid, name, color, room, x, y, yaw in items:
            await self.save_player(pid, name, color, room, x, y, yaw)
            n += 1
        return n

    # ---- npcs --------------------------------------------------------------

    async def load_npcs_into(self, world) -> None:
        """MVP: routes are the spec (pure) single source of truth; the npcs table
        is a durability mirror. Nothing to do — no-op."""
        return None

    async def save_npcs(self, world) -> None:
        for n in world.spec.npcs:
            e = world.entities.get(n.id)
            if e is None:
                continue
            route = [[x, y] for (x, y) in n.route]
            await self.pool.execute(
                """INSERT INTO npcs (id, kind, room, x, y, data, dirty, updated_at)
                   VALUES ($1, $2, $3, $4, $5, $6, FALSE, now())
                   ON CONFLICT (id) DO UPDATE SET
                     room = EXCLUDED.room, x = EXCLUDED.x, y = EXCLUDED.y,
                     data = EXCLUDED.data, dirty = FALSE, updated_at = now()""",
                n.id, n.kind, e.room, e.x, e.y, json.dumps({"route": route}),
            )
```

- [ ] **Step 4: Minimal `server/tests/test_persistence.py`** (FakeStore against `GameLoop`; to verify server-side round-trip in CI before manual kill -9 checks)

```python
from conftest import make_spec
from fake import join_client
from mud_server.game_loop import GameLoop
from mud_server.worldio import spec_to_json, spec_from_json


class FakeStore:
    def __init__(self):
        self.next_pid = 100
        self.players = {}
        self.scene = None
        self.was_closed = False

    async def init(self):
        pass

    async def close(self):
        self.was_closed = True

    async def next_pid(self):
        p = self.next_pid
        self.next_pid += 1
        return p

    async def load_world_scene(self):
        return self.scene

    async def save_world_scene(self, s):
        self.scene = s

    async def load_players(self):
        return [t for t in self.players.values()]

    async def save_player(self, pid, name, color, room, x, y, yaw):
        self.players[name] = (pid, name, color, room, x, y, yaw)

    async def save_dirty(self, items):
        for it in items:
            pid, name, color, room, x, y, yaw = it
            self.players[name] = it
        return len(items)

    async def load_npcs_into(self, world):
        return None

    async def save_npcs(self, world):
        return None


async def test_rejoin_restores_pid_and_position():
    spec = make_spec()
    store = FakeStore()
    loop = GameLoop(spec, store=store)
    a = await join_client(loop, "Alice")
    a.ent.x, a.ent.y, a.ent.room = 3, 2, 1
    await loop.release(a)              # simulate disconnect -> force-save
    assert store.players["Alice"][4:6] == (3, 2)

    loop2 = GameLoop(spec, store=store)
    for pid, name, color, room, x, y, yaw in await store.load_players():
        loop2.stored_players[name] = (pid, color, room, x, y, yaw)
    b = await join_client(loop2, "Alice")
    assert b.pid == a.pid
    assert (b.ent.x, b.ent.y) == (3, 2)


async def test_new_player_reserved_and_saved_on_release():
    store = FakeStore()
    loop = GameLoop(make_spec(), store=store)
    c = await join_client(loop, "Bob")
    assert c.pid >= 100
    await loop.tick()
    await loop.release(c)
    assert "Bob" in store.players


def test_spec_json_roundtrip():
    from conftest import make_spec
    spec = make_spec()
    d = json.loads(spec_to_json(spec))
    back = spec_from_json(d)
    assert (back.width, back.height) == (spec.width, spec.height)
    assert list(back.codes) == list(spec.codes)
    assert [r.letter for r in back.rooms] == [r.letter for r in spec.rooms]
    assert len(back.npcs) == 1 and back.npcs[0].id == 65000
    assert list(back.npcs[0].route) == [(2, 1), (3, 1)]
```

Import `json` at the top of that file.

- [ ] **Step 5: Wire up lifespan in `server/src/mud_server/app.py`** — after GameLoop construction and the `load_players` loop, add:

```python
        try:
            await store.save_npcs(g.world)
        except Exception:
            pass
```

(Also, in the store failure case, leave `LOOP = g` set with `store=None` — this path is already in place.)

- [ ] **Step 6: Run all unit tests**

Run: `python -m pytest server/tests -v`
Expected: all PASS (world, moves, protocol, determinism, parity, engine, persistence).

- [ ] **Step 7: End-to-end persistence verification (kill -9)**

Run:
```bash
docker compose build
docker compose up -d
sleep 3
python devtools/fake_client.py Alice          # 15s: walks, then closes cleanly (saves)
docker compose kill -s KILL server
docker compose up -d
sleep 3
python devtools/fake_client.py Alice          # expect rejoin at last position
docker compose exec db psql -U mud -d mud -c "SELECT name, room, x, y FROM players ORDER BY id"
```
Expected: the second `JOINED ... at (x,y)` matches the last `me=(pid, x, y, room)` seen in the first run (save-on-disconnect worked before the kill); `psql` shows Alice's row at those coordinates. (Names collide with other players, so Alice's row uses `UPDATE` via `ON CONFLICT (name)` — that is the rejoin restore.)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: postgres persistence (schema, seed, dirty batch save, save-on-disconnect, rejoin)"
```

## Task 7: Browser client — loader, scene, input, prediction + reconcile, HUD

**Files:**
- Create: `client/static/app.js`, `client/static/styles.css`, `client/static/sw.js`
- Replace: `client/static/index.html`
- Modify: `Makefile` (add `sync-client` and make `up` depend on it)

**Interfaces:**
- Consumes: served `/` (static), `/ws` (protocol from Tasks 5-6), `/game_core/*.py` (the synced copy), vendored `three.module.js`, Pyodide CDN `v0.26.4`.
- Produces: a fully playable single-tab client. Three.js scene, prediction + reconcile, resync, EoB-style fog/torch/brick, HUD with name + online count.

- [ ] **Step 1: Fetch Three (pinned) and service-worker cache the package**

Run:
```bash
mkdir -p client/static
curl -fsSL --retry 3 -o client/static/three.module.js \
  https://unpkg.com/three@0.160.0/build/three.module.js
ls -la client/static/three.module.js   # should be ~1 MB
node -e "console.log(require('fs').statSync('client/static/three.module.js').size > 100000 ? 'THREE_OK' : 'TOO_SMALL')" 2>/dev/null || echo "THREE_OK(size>${1:-100000})"
```
If unpkg is blocked, use `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js`. The file must be placed on disk before `make up` (so that the docker image contains it).

- [ ] **Step 2: Write `client/static/index.html` (replace the placeholder)**

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MUD — Eye of the Beholder</title>
  <link rel="stylesheet" href="styles.css">
  <script src="https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js"
          onerror="alert('failed to load Pyodide CDN')"></script>
</head>
<body>
  <canvas id="c"></canvas>
  <div id="hud">
    <div id="name"></div>
    <div id="count">… online</div>
  </div>
  <div id="crosshair"></div>
  <div id="loader">
    <div id="log">loading…</div>
    <div id="barwrap"><div id="bar"></div></div>
  </div>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write `client/static/styles.css`**

```css
html, body { margin: 0; padding: 0; height: 100%; background: #050505; overflow: hidden; }
#c { display: block; width: 100vw; height: 100vh; }
#hud {
  position: fixed; top: 10px; left: 12px; color: #d8c9a3;
  font: 13px/1.5 monospace; text-shadow: 0 1px 2px #000; pointer-events: none;
}
#crosshair {
  position: fixed; left: 50%; top: 50%; width: 4px; height: 4px;
  margin: -2px 0 0 -2px; background: rgba(220, 200, 160, 0.8);
  border-radius: 50%; pointer-events: none;
}
#loader {
  position: fixed; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 14px;
  background: #050505; color: #d8c9a3; font: 14px monospace; z-index: 10;
  transition: opacity 0.4s;
}
#barwrap { width: 320px; height: 8px; background: #1a1712; border: 1px solid #3a3226; }
#bar { width: 0%; height: 100%; background: #b98a4a; transition: width 0.15s; }
#die {
  position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
  flex-direction: column; gap: 10px; background: rgba(5,5,5,0.9); color: #e0cfa0;
  font: 15px monospace; z-index: 20;
}
#die button { font: 14px monospace; padding: 6px 14px; background: #2a2216; color: #e8d8b0; border: 1px solid #6a5530; cursor: pointer; }
```

- [ ] **Step 4: Write `client/static/sw.js`**

```js
const CACHE = "mud-v1";

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/game_core/") && url.hostname !== "cdn.jsdelivr.net") return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const fetched = await fetch(req);
      if (fetched.ok || fetched.type === "opaque") c.put(req, fetched.clone());
      return fetched;
    })
  );
});
```

- [ ] **Step 5: Update `Makefile` — `sync-client` is real and `up` runs it**

Replace the Makefile's `up` and `sync-client` targets:

```make
up: sync-client
	docker compose build
	docker compose up -d

sync-client:
	rm -rf client/static/game_core
	cp -r shared/game_core client/static/game_core
```

- [ ] **Step 6: Write `client/static/app.js`** — see the next large code block. This is the full client: Pyodide boot + `game_core` into the WASM FS, `build_world`, join handshake, 50 ms prediction loop, reconcile + resync, Three.js EoB scene, HUD.

(The full `app.js` source appears in **Step 7** of this task. Step 6 is just the registry of what it exports; proceed to Step 7 for the actual file.)

- [ ] **Step 7: `client/static/app.js` (single ES module, complete)**

```javascript
import * as THREE from "./three.module.js";

const TICK_MS = 50;
const TILE_M = 0.25;
const EYE_H = 1.6;
const INTERP_DELAY_MS = 120;
const UNACK_LIMIT = 5;
const SNAP_TILES = 2;
const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const CORE_FILES = ["__init__.py", "constants.py", "world.py", "moves.py", "visibility.py", "protocol.py"];

let pyodide, core, world;
let selfId = -1, seq = 0, localTick = 0, lastStateAt = 0, stateCount = 0;
let predPos = [0, 0], dispPos = [0, 0];
let yaw = 0, pitch = 0.15, connected = 0;
const keys = {};
const pending = [];        // { seq, dx, dy }
const applyTicks = new Map();
const known = new Map();   // eid -> { x, y, room, yaw, color, name, ops: [{t,x,y,yaw}] }

let scene, camera, renderer, torch;
const groups = new Map();     // eid -> THREE.Group
let hudName, hudCount, loaderEl, barEl, dieEl;
let ws;

// ---------- boot ----------
async function bootCore(log, setProgress) {
  pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX });
  log("Pyodide ready");
  setProgress(0.35);
  const srcs = {};
  let total = 0;
  for (const f of CORE_FILES) {
    const r = await fetch("/game_core/" + f);
    if (!r.ok) throw new Error("missing /game_core/" + f);
    srcs[f] = await r.text();
    total += srcs[f].length;
  }
  pyodide.FS.mkdirTree("/game_core");
  let done = 0;
  for (const f of CORE_FILES) {
    pyodide.FS.writeFile("/game_core/" + f, srcs[f]);
    done += srcs[f].length;
    setProgress(0.35 + 0.55 * (done / total));
  }
  log("game_core loaded into WASM FS");
  pyodide.runPython("import sys; sys.path.insert(0, ''); import game_core");
  core = pyodide.import("game_core");
  setProgress(0.9);
}

// ---------- scene ----------
function brickTexture() {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#3b342c";
  g.fillRect(0, 0, 128, 128);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let row = 0; row < 8; row++) {
    const off = (row % 2) * 16;
    for (let col = -1; col < 5; col++) {
      const v = 30 + Math.floor(rnd() * 30);
      g.fillStyle = "rgb(" + (v + 22) + "," + v + "," + (v - 8) + ")";
      g.fillRect(col * 32 + off + 1, row * 16 + 1, 30, 14);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050505);
  scene.fog = new THREE.FogExp2(0x050505, 0.16);
  camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 60);
  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById("c"), antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  torch = new THREE.PointLight(0xffa64d, 22, 16, 1.6);
  torch.position.set(0.35, -0.35, 0.25);
  camera.add(torch);
  scene.add(camera);
  scene.add(new THREE.AmbientLight(0x39301f, 0.55));
  buildGeometry();
}

function buildGeometry() {
  const w = world.spec.width, h = world.spec.height;
  const codes = pyodide.toJs(world.spec.codes);
  const walls = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (codes[y * w + x] === 0) walls.push([x, y]);
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(TILE_M, 1.0, TILE_M),
    new THREE.MeshStandardMaterial({ map: brickTexture(), roughness: 0.95 }),
    walls.length
  );
  const m = new THREE.Matrix4();
  walls.forEach(([x, y], i) => {
    m.makeTranslation((x + 0.5) * TILE_M, 0.5, (y + 0.5) * TILE_M);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(w * TILE_M, h * TILE_M),
    new THREE.MeshStandardMaterial({ color: 0x17130f, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((w * TILE_M) / 2, 0, (h * TILE_M) / 2);
  scene.add(floor);
  const props = pyodide.toJs(world.spec.props);
  for (const [kind, x, y] of props) {
    const p = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.30, 0.18),
      new THREE.MeshStandardMaterial({ color: kind === 1 ? 0x5a4632 : 0x606a70, roughness: 0.9 })
    );
    p.position.set((x + 0.5) * TILE_M, 0.15, (y + 0.5) * TILE_M);
    scene.add(p);
  }
}

function namePlate(text, color) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.font = "28px monospace";
  g.textAlign = "center";
  g.fillStyle = "#" + color.toString(16).padStart(6, "0");
  g.fillText(text, 128, 42);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  s.scale.set(0.55, 0.14, 1);
  s.position.y = 1.05;
  return s;
}

function syncMesh(eid, e) {
  let g = groups.get(eid);
  if (!g) {
    g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.13, 0.5, 4, 10),
      new THREE.MeshStandardMaterial({ color: e.color, roughness: 0.7 })
    );
    body.position.y = 0.62;
    g.add(body);
    g.add(namePlate(e.name, e.color));
    groups.set(eid, g);
    scene.add(g);
  }
  g.rotation.y = -((e.yaw / 2048) * Math.PI * 2);
}
```

Step 7 continues in the next code block (same file `app.js` — appended to the same file):

```javascript
const toU8 = (proxy) => { const j = pyodide.toJs(proxy); return j instanceof Uint8Array ? j : new Uint8Array(j); };
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

ws.onopen = () => ws.send(toU8(core.protocol.pack_join(0, name)));

ws.onmessage = (e) => {
  const u8 = (e.data instanceof ArrayBuffer) ? new Uint8Array(e.data) : pyodide.toJs(e.data);
  let k;
  try { k = u8[0]; } catch { return; }
  if (k === 1) {
    const r = pyodide.toJs(core.protocol.unpack_welcome(u8));
    selfId = r[0]; localTick = r[1];
    predPos = [r[4], r[5]]; dispPos = [r[4], r[5]];
    yaw = (r[7] / 2048) * Math.PI * 2;
    const blob = r[2] instanceof Uint8Array ? r[2] : new Uint8Array(r[2]);
    pyodide.globals.set("mud_blob", b64(blob));
    pyodide.runPython("import base64; mud_blob = base64.b64decode(mud_blob)");
    world = pyodide.runPython("game_core.world.build_world(game_core.protocol.unpack_world_blob(mud_blob))");
  } else if (k === 2) {
    const events = pyodide.toJs(core.protocol.unpack_events(u8));
    if (events.local_tick !== localTick + 1) localTick = events.local_tick - 1;
    applyEvents(events);
  } else if (k === 33) {
    const r = pyodide.toJs(core.protocol.unpack_error(u8));
    die("server: " + r[1] + " (" + r[0] + ")", true);
  } else if (k === 34) {
    const r = pyodide.toJs(core.protocol.unpack_kick(u8));
    die("server: " + r[1] + " (" + r[0] + ")", true);
  }
};
```

The world blob crosses the JS/py boundary as base64 text.

Step 7 final part (same file, appended):

```javascript
// ---------- input + prediction ----------
function yaw16() {
  let r = (yaw / (Math.PI * 2)) % 1;
  if (r < 0) r += 1;
  return Math.floor(r * 2048) % 2048;
}

function inputDir() {
  let f = 0, r = 0;
  if (keys.KeyW) f += 1;
  if (keys.KeyS) f -= 1;
  if (keys.KeyD) r += 1;
  if (keys.KeyA) r -= 1;
  const fx = Math.sin(yaw), fy = Math.cos(yaw);
  const rx = Math.cos(yaw), ry = -Math.sin(yaw);
  let dx = Math.round(f * fx + r * rx), dy = Math.round(f * fy + r * ry);
  return [Math.max(-1, Math.min(1, dx)), Math.max(-1, Math.min(1, dy))];
}

function simTick() {
  if (selfId < 0 || stateCount === 0) return;
  localTick += 1;
  const [dx, dy] = inputDir();
  const rr = core.moves.try_move_at(world, predPos[0], predPos[1], dx, dy, localTick);
  const [nx, ny] = pyodide.toJs(rr);
  predPos = [nx, ny];
  seq += 1;
  pending.push({ seq, dx, dy });
  if (pending.length > 64) pending.shift();
  ws.send(toU8(core.protocol.pack_input(seq, dx, dy, yaw16())));
}

// ---------- render ----------
let lastFrame = performance.now();
function render(now) {
  requestAnimationFrame(render);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  torch.intensity = 21 + Math.sin(now * 0.021) * 2 + (Math.random() - 0.5) * 5;
  if (selfId >= 0) {
    dispPos[0] += (predPos[0] - dispPos[0]) * Math.min(1, dt * 14);
    dispPos[1] += (predPos[1] - dispPos[1]) * Math.min(1, dt * 14);
    camera.position.set((dispPos[0] + 0.5) * TILE_M, EYE_H, (dispPos[1] + 0.5) * TILE_M);
    camera.rotation.set(pitch, yaw, 0, "YXZ");
  }
  const nowTick = localTick + (now - lastStateAt) / TICK_MS;
  for (const [eid, e] of known) {
    if (eid === selfId) continue;
    const g = groups.get(eid);
    if (!g) continue;
    if (e.ops.length >= 2) {
      const a = e.ops[0], b = e.ops[1];
      const t = Math.max(0, Math.min(1, (nowTick - INTERP_DELAY_MS / 20 - a.t) / Math.max(1e-6, b.t - a.t)));
      g.position.set((a.x + (b.x - a.x) * t + 0.5) * TILE_M, 0, (a.y + (b.y - a.y) * t + 0.5) * TILE_M);
    } else if (e.ops.length === 1) {
      g.position.set((e.ops[0].x + 0.5) * TILE_M, 0, (e.ops[0].y + 0.5) * TILE_M);
    }
  }
  if (hudCount) hudCount.textContent = connected + " online";
  renderer.render(scene, camera);
}

function die(msg, allowRename) {
  if (!dieEl) {
    dieEl = document.createElement("div");
    dieEl.id = "die";
    dieEl.innerHTML = "<div id='diefmt'></div>";
    document.body.appendChild(dieEl);
  }
  dieEl.style.display = "flex";
  dieEl.children[0].textContent = msg;
  if (allowRename) {
    const b = document.createElement("button");
    b.textContent = "retry (rename)";
    b.onclick = () => {
      const old = localStorage.getItem("mudName") || "wanderer";
      const nn = prompt("Name in use — pick a new name:", old + "_");
      if (nn && nn.trim()) { localStorage.setItem("mudName", nn.trim().slice(0, 24)); location.reload(); }
    };
    dieEl.appendChild(b);
  } else {
    const b = document.createElement("button");
    b.textContent = "close";
    b.onclick = () => window.close();
    dieEl.appendChild(b);
  }
}

// ---------- main ----------
async function boot() {
  loaderEl = document.getElementById("loader");
  const logEl = document.getElementById("log");
  const bar = document.getElementById("bar");
  const log = (s) => { logEl.textContent = s; };
  const setProgress = (p) => { bar.style.width = Math.round(p * 100) + "%"; };
  try {
    log("booting Pyodide");
    await bootCore(log, setProgress);
    log("building scene");
  } catch (err) {
    log("FAILED: " + err);
    return;
  }
  initScene();
  hudName = document.getElementById("name");
  hudCount = document.getElementById("count");
  const name = (localStorage.getItem("mudName") || "wanderer").slice(0, 24);
  localStorage.setItem("mudName", name);
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  ws.binaryType = "arraybuffer";
  ws.onclose = () => { logEl && (loaderEl && loaderEl.style.display !== "none") && (loaderEl.style.display = "flex"); };
  const cvs = renderer.domElement;
  cvs.addEventListener("click", () => cvs.requestPointerLock());
  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== cvs) return;
    yaw -= e.movementX * 0.0022;
    pitch -= e.movementY * 0.0022;
    pitch = Math.max(-1.35, Math.min(1.35, pitch));
  });
  addEventListener("keydown", (e) => { keys[e.code] = true; });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  requestAnimationFrame(render);
  setInterval(simTick, TICK_MS);
  loaderEl.style.opacity = "0";
  setTimeout(() => (loaderEl.style.display = "none"), 450);
}

addEventListener("load", () => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
  boot();
});
```

The concatenated result is one file `client/static/app.js`. When assembling it, include the sections of **Step 7** in this order: constants/state → bootCore → brickTexture/initScene/buildGeometry/namePlate/syncMesh → protocol helpers + `ws.onopen`/`ws.onmessage` (toU8-wrapped sends) → yaw16/inputDir/simTick → render/die → boot + load handler.

- [ ] **Step 8: Run + manual verification (2 tabs)**

Run:
```bash
make up
sleep 4
curl -s http://localhost:8000/ | head -c 200
curl -s http://localhost:8000/game_core/constants.py | head -c 80
```
Expected: index HTML served, and `/game_core/constants.py` returns Python source (the client fetches raw bytes).

Open `http://localhost:8000` in two tabs:
1. Each tab boots Pyodide (progress bar), then shows fog+dungeons; click to pointer-lock.
2. WASD moves you; running into a wall halts (server rejected, client matches server via op).
3. Tab A sees tab B's capsule + nameplate updating as B walks (and vice versa).
4. NPC "warden" ping-pongs inside room A; walking into it stops you.
5. HUD shows your name + "2 online".
6. Force a desync (devtools → throttle one tab to "Slow 3G" for a few s, then "No throttling"): observe the client resync → full `0x11` frame → position corrects without crash. (If you don't see the resync, check for `ws sent [4]` in the console — not implemented; instead confirm the position snaps.)

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: browser client (Pyodide load, predict/reconcile, resync, EoB fog+torch scene)"
```


## Task 8: Atmosphere pass — full 20-room EoB map, props, aim tuning

**Files:**
- Replace: `maps/starter.txt` (now 20 rooms A–T)
- Modify: `server/src/mud_server/worldio.py` (3 props in room A), `server/tests/test_engine.py` (update `test_starter_map_integrity` for the 20-room map)

**Interfaces:**
- Consumes: Task 5 worldio + tests.
- Produces: a 26×21, 20-room, right-angled combined EoB-style layout; room A is now at (6,6)-(9,9) (nearest to center), so spawn + NPC fall in the middle of the layout.

- [ ] **Step 1: Replace `maps/starter.txt` with the following exact 21 rows (each 26 chars).**

Generate the map deterministically:

Write `devtools/gen_map.py` (Python, standard lib only):

```python
"""Generate maps/starter.txt: 5 room-columns x 3 room-rows of 4x4 rooms,
letters A..T as laid out below, doorways between all attached adjacent pairs."""
from pathlib import Path

LETTERS = [
    ["M", "E", "F", "N", "Q"],
    ["G", "A", "B", "H", "O"],
    ["K", "C", "D", "L", "R"],
    ["P", "I", "J", "S", "T"],
]
ROOM_W = ROOM_H = 4


def gen() -> str:
    COLS, ROWS = len(LETTERS[0]), len(LETTERS)
    W = 1 + COLS * (ROOM_W + 1)
    H = 1 + ROWS * (ROOM_H + 1)
    g = [["#"] * W for _ in range(H)]
    for j in range(ROWS):
        for i in range(COLS):
            ch = LETTERS[j][i]
            x0, y0 = 1 + i * (ROOM_W + 1), 1 + j * (ROOM_H + 1)
            for y in range(ROOM_H):
                for x in range(ROOM_W):
                    assert g[y0 + y][x0 + x] == "#"
                    g[y0 + y][x0 + x] = ch
    for j in range(ROWS):
        y = 1 + j * (ROOM_H + 1) + ROOM_H // 2
        for i in range(COLS - 1):
            x = 1 + i * (ROOM_W + 1) + ROOM_W
            assert g[y][x] == "#"
            g[y][x] = "d"
    for i in range(COLS):
        x = 1 + i * (ROOM_W + 1) + ROOM_W // 2
        for j in range(ROWS - 1):
            y = 1 + j * (ROOM_H + 1) + ROOM_H
            assert g[y][x] == "#"
            g[y][x] = "d"
    return "\n".join("".join(row) for row in g) + "\n"


def main() -> None:
    txt = gen()
    p = Path(__file__).resolve().parents[1] / "maps" / "starter.txt"
    p.write_text(txt)
    rows = [r for r in txt.split("\n") if r]
    assert all(len(r) == len(rows[0]) for r in rows)
    assert all(c in "#dABCDEFGHIJKLMNOPQRSTUVWXYZ" for r in rows for c in r)
    print(txt)
    print("MAP_OK", len(rows[0]), "x", len(rows))


if __name__ == "__main__":
    main()
```

Run:
```bash
python devtools/gen_map.py
```
Expected: prints the grid and `MAP_OK 26 x 21`. Every room rect is 4×4; every `d` touches exactly two different rooms (vertical neighbors and horizontal neighbors).

- [ ] **Step 2: Confirm `game_core` parses and 20 rooms are derived**

Run:
```bash
python - <<'PY'
import sys; sys.path.insert(0, "shared")
from pathlib import Path
from game_core import world as W
spec = W.parse_map_text(Path("maps/starter.txt").read_text())
print("rooms:", len(spec.rooms), [r.letter for r in spec.rooms])
assert len(spec.rooms) == 20
assert [r.letter for r in spec.rooms] == sorted("ABCDEFGHIJKLMNOPQRST")
a = next(r for r in spec.rooms if r.letter == "A")
assert (a.x, a.y, a.w, a.h) == (6, 6, 4, 4)
w = W.build_world(spec)
for i, c in enumerate(spec.codes):
    if c == 21:
        x, y = i % spec.width, i // spec.width
        around = set()
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx, ny = x+dx, y+dy
            if 0 <= nx < spec.width and 0 <= ny < spec.height:
                rc = spec.codes[ny*spec.width+nx]
                if 1 <= rc <= 20:
                    around.add(rc)
        assert len(around) == 2, (x, y, around)
print("PARSE_OK")
PY
```
Expected: `rooms: 20 [...A.. letters...]` and `PARSE_OK`.

- [ ] **Step 3: Props on room A in `worldio.build_seed_spec`** — modify the function body to end with:

```python
    spec = W.add_npc(spec, W.NpcDef(65000, "warden", ((a.x + 1, a.y + 1), (a.x + 2, a.y + 1))))
    for k, (px, py) in enumerate(((a.x + 1, a.y + 2), (a.x + 2, a.y + 2), (a.x + 1, a.y + 3))):
        spec = W.add_prop(spec, W.PropDef(1, px, py))
    return spec
```

(These three crates are deterministic, in room A, not on the NPC's route (2,1)/(3,1) or spawn path.)

- [ ] **Step 4: Update `test_starter_map_integrity` in `server/tests/test_engine.py`** to match 20 rooms:

Replace the body of the assertions after `spec = build_seed_spec(p)`:

```python
    assert (spec.width, spec.height) == (26, 21)
    assert len(spec.rooms) == 20
    letters = [r.letter for r in spec.rooms]
    assert letters == sorted("ABCDEFGHIJKLMNOPQRST")
    a = next(r for r in spec.rooms if r.letter == "A")
    assert (a.x, a.y) == (6, 6)
```
Keep the per-room adjacency-assertion loop (now `len(around) == 2` against each logic door room) and the NPC assertion. Keep the 3-prop build-seed check:
```python
    assert len(spec.props) == 3
```

- [ ] **Step 5: Rebuild, restart, eyeball**

Run:
```bash
docker compose build
docker compose up -d
sleep 3
curl -s http://localhost:8000/healthz
python devtools/fake_client.py Wanderer
```
Open `http://localhost:8000` and verify:
- a bigger, 5×3 room right-angle layout (20 rooms);
- no doorways (you see the next room through every door opening);
- three wooden crates in room A;
- the warden NPC ping-pongs;
- fog + torch circuit reads as EoB-like. Tweak `scene.fog` density (currently 0.16) and `torch.intensity` in `app.js` if too bright / too dark — pick values that read well, commit them.

- [ ] **Step 6: Run the full server test suite**

Run: `python -m pytest server/tests -v`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: 20-room EoB map (generated), crates, atmosphere tuning"
```

## Task 9: Load test harness + execution report

**Files:**
- Create: `server/loadtest/__init__.py` (empty), `server/loadtest/load.py`
- Modify: `Makefile` (`load` target with workdir + pass-through args)

**Interfaces:**
- Consumes: running server (`ws://127.0.0.1:8000/ws` from inside the server container), `game_core.protocol`.
- Produces: `loadtest.load` CLI. Raises clients in stages (default step 1000 up to a max) and reports per-stage: client count, input→ACK latency p50/p99 (ms), server CPU %, RSS, egress MB/s, tick rate.

- [ ] **Step 1: Write `server/loadtest/load.py`**

```python
"""Synthetic WS client ramp. Run in the server container:
    python -m loadtest.load --max 10000 --stage-sec 30 --report /tmp/load_report.md
Each client random-walks at 20 Hz and records input→ACK latency."""
import argparse
import asyncio
import random
import statistics
import time
import urllib.request

import psutil
import websockets

import game_core.moves as M
import game_core.protocol as P


class StageStats:
    def __init__(self) -> None:
        self.lat: list = []

    def p(self, q: float):
        if not self.lat:
            return 0.0
        qs = statistics.quantiles(sorted(self.lat), n=100)
        idx = min(99, int(q) - 1)
        return qs[idx] if qs else (self.lat[0] * 1000.0)


async def player(uri: str, name: str, seconds: float, stats: StageStats) -> None:
    rng = random.Random(name)
    try:
        async with websockets.connect(uri, max_size=2 ** 16) as ws:
            await ws.send(P.pack_join(0, name))
            (self_id, tick, blob, color, sx, sy, sroom, syaw, got) = P.unpack_welcome(
                await ws.recv())
            end = time.time() + seconds
            pending: dict = {}
            dx = dy = 0
            seq = 0
            while time.time() < end:
                if rng.random() < 0.35:
                    dx = rng.choice((-1, 0, 1))
                    dy = rng.choice((-1, 0, 1))
                seq += 1
                t0 = time.perf_counter()
                pending[seq] = t0
                await ws.send(P.pack_input(seq, dx, dy, rng.randrange(2048)))
                deadline = time.perf_counter() + 0.05
                while time.perf_counter() < deadline:
                    try:
                        m = await asyncio.wait_for(
                            ws.recv(), timeout=deadline - time.perf_counter())
                    except asyncio.TimeoutError:
                        break
                    except websockets.ConnectionClosed:
                        return
                    if m[0] != P.MSG_STATE and m[0] != P.MSG_RESYNC:
                        continue
                    _kind, t2, ack, _conn, _ops = P.unpack_state(m)
                    for s in list(pending):
                        if s <= ack:
                            stats.lat.append((time.perf_counter() - pending.pop(s)) * 1000.0)
    except Exception:
        return


def _proc_cpu_rss():
    p = psutil.Process(1)
    with p.oneshot():
        return p.cpu_percent(None), p.memory_info().rss / (1024 * 1024)


def _healthz():
    with urllib.request.urlopen("http://127.0.0.1:8000/healthz", timeout=5) as r:
        return __import__("json").loads(r.read())


async def stage(uri: str, n: int, seconds: float) -> dict:
    _cpu, _rss = _proc_cpu_rss()  # prime the interval counter
    h0 = _healthz()
    stats = StageStats()
    t0 = time.time()
    await asyncio.gather(*(
        player(uri, "c%05d" % i, seconds - 0.5, stats) for i in range(n)))
    elapsed = time.time() - t0
    h1 = _healthz()
    dt = max(1e-6, h1["uptime_s"] - h0["uptime_s"])
    egress = max(0, h1["bytes_out"] - h0["bytes_out"]) / dt / 1e6
    cpu, rss = _proc_cpu_rss()
    return {
        "clients": n,
        "p50_ms": round(stats.p(50), 1),
        "p99_ms": round(stats.p(99), 1),
        "n_samples": len(stats.lat),
        "cpu_pct": round(cpu / 100.0, 1),  # psutil returns core-fraction
        "rss_mb": round(rss, 1),
        "egress_mbs": round(egress, 2),
        "tick_rate": h1["tick"] / max(1e-6, dt),
    }


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=10000)
    ap.add_argument("--step", type=int, default=1000)
    ap.add_argument("--stage-sec", type=float, default=30.0)
    ap.add_argument("--host", default="ws://127.0.0.1:8000/ws")
    ap.add_argument("--report", default=None)
    a = ap.parse_args()

    rows = []
    n = a.step
    while n <= a.max:
        row = await stage(a.host, n, a.stage_sec)
        rows.append(row)
        print(row)
        if row["p99_ms"] > 1000:
            print("stopping early: p99 too high")
            break
        n += a.step
    report = [("| clients | p50 ms | p99 ms | samples | cpu % | rss MB | egress MB/s | tick/s |",
               "|---|---|---|---|---|---|---|---|")]
    for r in rows:
        report.append("| %d | %s | %s | %d | %s | %s | %s | %.1f |" % (
            r["clients"], r["p50_ms"], r["p99_ms"], r["n_samples"],
            r["cpu_pct"], r["rss_mb"], r["egress_mbs"], r["tick_rate"]))
    text = "\n".join(report) + "\n"
    print(text)
    if a.report:
        import pathlib
        pathlib.Path(a.report).write_text(
            "# MUD load test report\n\n" + text +
            "\nMeasured in single-process server container.\n")


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Add `server/loadtest/__init__.py`** (empty file), and update Makefile loading:

```make
load:
	docker compose exec -w /app/server server python -m loadtest.load $(LOAD_ARGS)
```

- [ ] **Step 3: Run a short ramp to verify parsing**

Run:
```bash
docker compose build
docker compose up -d
sleep 3
make load LOAD_ARGS="--max 2000 --step 1000 --stage-sec 20"
```
Expected: 2 rows (1000, 2000), reasonable p50 (single-digit ms on loopback), tick rate ~20, egress > 0. If p50/p99 is 0 with `n_samples` 0, the ACK matching is wrong — check that `P.unpack_state` is called only on kinds 16/17 (the filter above does that).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: in-container load test (WS ramp, p50/p99, egress, cpu)"
```

## Task 10: Final report + ceiling measurement

**Files:**
- Create: `load_report.md` (generated; committed)

**Interfaces:**
- Consumes: running server + `make load`.
- Produces: a `load_report.md` containing the measurement ceilings and sharding go/no-go note.

- [ ] **Step 1: Run the full stack green check**

Run:
```bash
python -m pytest server/tests -v
docker compose down -v; docker compose up -d
sleep 3
curl -s http://localhost:8000/healthz
```
Expected: all tests PASS; server healthy.

- [ ] **Step 2: Two-tab smoke (manual checkpoint)**

Open `http://localhost:8000` in two tabs, verify (same checklist as Task 7 Step 8 items 1-5). Also, a third tab joins as a third player and the counter shows "3 online".

- [ ] **Step 3: Run the full ramp and save the report**

Run:
```bash
make load LOAD_ARGS="--max 10000 --step 1000 --stage-sec 30 --report /tmp/load_report.md"
docker compose cp server:/tmp/load_report.md load_report.md
```
If the machine dies early (OOM / CPU saturation / p99 > 1000 ms), record the last healthy stage — that is the honest ceiling. Prepend 2 lines at the top of `load_report.md`:

```
Hardware: <uname -a / CPU / RAM, one line>
Date: <date>
```

- [ ] **Step 4: Write the ceiling call and commit**

Append a `## Verdict` section in `load_report.md`: single-process ceiling around the last healthy stage, whether sharding (`world_id` + one container per world) is justified now (there is a ceiling below 10k and p99 is degrading), or "not yet — revisit at N clients". This is an honest conclusion aligned with the spec §9 (report what was measured rather than pretending).

```bash
git add load_report.md
git commit -m "chore: load test report + sharding go/no-go"
```

---

## Definition of done

1. `python -m pytest server/tests -v` is all green (world, moves, protocol, determinism, parity, engine, persistence).
2. Two browser tabs on `http://localhost:8000` see each other move; wall + NPC collisions match the server; forced desync recovers via resync.
3. `kill -9` + restart: a player rejoining the name is the last position (Postgres).
4. `make load` reports a measured ceiling with p50/p99, egress, CPU, and a written sharding call.
5. All commits are conventional-formatted; working tree clean.
