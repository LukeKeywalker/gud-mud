# MUD "Eye of the Beholder" — Implementation Plan

## Decisions (final)

| Area | Choice |
|---|---|
| Client | **Browser** + Three.js, Eye-of-the-Beholder-style FPS (fog, flickering torch light, stone boxes) |
| Shared logic | **Pure-Python `game_core`**, runs natively on the server, in the browser via **Pyodide** |
| Server | Python asyncio, single process, **sharding-ready**, target 10,000 connections |
| Transport | **WebSocket, binary frames** (hand-rolled big-endian pack/unpack inside `game_core`) |
| World | **Tile grid**, deterministic 20 Hz sim, room-based line-of-sight visibility |
| Sync | **Server-authoritative + client prediction/reconciliation** (sequence numbers, resync snapshot) |
| Persistence | **Postgres 16**, periodic dirty snapshots (30 s) + save-on-disconnect / load-on-start |
| MVP scope | Movement + collision, live other players, props + 1 NPC (chat/combat/inventory → v2) |
| Local setup | `docker-compose`: **`db` + `server`**. The browser *is* the client (no client container possible on macOS) — `server` also serves the client's static files at `http://localhost:8000` |

## Architecture

```
                ┌────────────────────────────────────────────────┐
 Browser 3      │  app.js ── input ──▶ game_core (Pyodide/WASM)  │
 tab            │   ▲  60fps                    │ pred. inputs   │
 Three.js ◀─────┤   └ render  ◀── reconcile ◀───┤                │
                └──────────────┬─────────────────┘
                WSS :8000 (binary frames)
                ┌──────────────▼────────────────────┐      ┌──────────────┐
                │ mud server (uvicorn, asyncio)     │      │ postgres:16  │
                │  game loop 20Hz ─▶ game_core (pure│ ───▶ │  asyncpg     │
                │  Python, authoritative state)     │  30s │  snapshots   │
                │  room-grid spatial index → per-   │      └──────────────┘
                │  player visible sets → deltas     │
                └────────────────────────────────────┘
```

## Repo layout

```
mud/
├── docker-compose.yml          # db (postgres:16-alpine, healthcheck), server
├── Makefile                    # up | down | logs | test | load
├── maps/starter.txt            # ASCII tile map ('#' wall, '.' floor), ~20 rooms
├── db/init.sql                 # schema
├── shared/game_core/           # ★ THE shared package — pure stdlib only,
│   ├── constants.py            #   no I/O, no threading, deterministic
│   ├── world.py                #   WorldState: walls bitmask, rooms, entities
│   ├── moves.py                #   normalize_input / try_move / step(state, inputs)
│   ├── visibility.py           #   room + doorway line-of-sight sets
│   └── protocol.py             #   binary message pack/unpack (portable to WASM)
├── server/
│   ├── Dockerfile              # python:3.12-slim, uvicorn[standard] + websockets + asyncpg
│   ├── pyproject.toml
│   ├── src/mud_server/
│   │   ├── main.py             # app: static / + WS /ws + /healthz
│   │   ├── game_loop.py        # 20Hz tick: collect inputs → order → step state
│   │   ├── connections.py      # per-socket async watcher, send queue
│   │   ├── spatial.py          # room grid; "who sees whom" computation
│   │   ├── persistence.py      # asyncpg pool, load on start, dirty-save 30s + on disconnect
│   │   └── config.py
│   ├── tests/                  # determinism, collision, visibility, protocol round-trip
│   └── loadtest/load.py        # N synthetic WS clients moving at 20Hz, latency percentiles
└── client/static/
    ├── index.html  loading.html  styles.css
    ├── game_core/  (copied from shared/ → mounted into Pyodide FS)
    ├── three.module.js (vendored, pinned rev)
    └── app.js        # loader (pyodide w/ progress bar) → scene → game loop glue
```

## Core loop

### Authoritative tick (server, 20 Hz)
1. Drain per-connection inputs (each tagged with its pending `seq`).
2. Order by (arrival tick, player id) — deterministic replay order.
3. `game_core.step(world, tick_inputs)` — all positions are integer tiles (no float nondeterminism).
4. Compute each player's visible-room set (own room + adjacent rooms through open doorways).
5. Encode **deltas** per player: `spawn | move | despawn | room_change` ops for entities in their visible rooms, carrying `server_tick` + `ack_seq`.
6. `send_bytes` via per-connection send queue.

### Prediction (client)
- WASD/mouse → build `input_frame(seq)` → run `game_core.step` locally on the local state copy (the player slides instantly) → push frame into a pending ring buffer → send to the server coalesced at 20 Hz.

### Reconciliation
- On each server state frame (carrying `server_tick` + ack'd `max_seq`):
  - drop acked frames from the pending ring,
  - re-simulate un-acked frames from the server snapshot of *the player's own* entity,
  - snap if a prediction was rejected (wall, doorway locked, NPC in the way).
- Other players/NPCs render through a 2-sample interpolation buffer at 60 fps.

### Protocol (both directions, 1-byte kind + big-endian ints)
- `join(name)`
- `welcome(world_seed, rooms[], self_id, tick)`
- `input(seq, dx, dy, yaw)`
- `state(tick, ack_seq, ops[], [resync_inline])` — ops = entity delta list
- `kick / error`
- Budget: ≈ 150–300 B/player/tick worst case; visibility gating + deltas keep a realistic 10k-player cluster well under 20 MB/s egress.

### Persistence (Postgres)
- Tables:
  - `players(id, name UNIQUE, color, room, x, y, yaw, dirty, updated_at)`
  - `npcs(id, kind, room, x, y, data jsonb, dirty, updated_at)`
  - `worlds(id, name, seed, data jsonb, version)` — static in MVP; the "world modified by players" hook is the version-bump point for v2 (doors opened, items placed, etc.).
- Server start: load everything into in-memory `WorldState`.
- Every 30 s: save dirty rows only. On disconnect: immediate save. Rejoin by name restores last position.

## Scale plan (honest)

- Single asyncio process is the MVP. The **room-grid visibility** is the 10k trick: nobody pays for the whole world, only their visible rooms.
- `loadtest/load.py` ramps 1k → 10k synthetic clients (real WS connection, random walk at 20 Hz) and reports p50/p99 input→ack latency + CPU.
- **Expectation set:** a single CPython process will realistically show its ceiling in the low thousands at full fidelity. If so, the pre-planned sharding path is: `world_id` in the `join` message + one container per world behind a tiny router (Postgres shared). We report the measured number, not fake it.
- If the ASGI WebSocket layer is CPU-hot, swap to the `websockets` server directly on the same port (already in the dependency stack) — one-line change.

## Client details

- **Loader:** `loading.html` shows Pyodide boot + `game_core` fetch progress bar. An opaque-response service worker caches Pyodide files for instant reloads afterward.
- **EoB look:** `THREE.FogExp2` (near-black), instanced stone walls with a generated brick texture, right-angled rooms, one flickering warm `PointLight` at the camera (no shadows in MVP), colored capsule avatars + name sprites, crosshair HUD, "N players connected" counter.
- **Controls:** WASD + pointer-lock mouse look. Yaw is synced so other players can see where you're facing.

## Build order (verify each step before the next)

1. **Scaffold** — compose (db + server), empty WS `/ws`, `/healthz`, `make up`.
   *Verify: `ws://localhost:8000/ws` echoes.*
2. **`game_core` + tests** — world/step/collision/visibility/protocol; determinism test (10k random-input replays → identical state hash).
   *Verify: `pytest` green.*
3. **Server loop** — join by name, 20 Hz step, broadcast deltas.
   *Verify: 2 fake WS clients, one watches the other move.*
4. **Browser client** — Three.js scene, Pyodide loader, input, prediction + reconcile rendering.
   *Verify: 2 browser tabs see each other move; wall collisions match.*
5. **Persistence** — schema, load/save, save-on-disconnect.
   *Verify: `kill -9` the server, restart, player rejoins at last position.*
6. **Atmosphere pass** — map authoring, textures, flicker, name sprites, lobby.
   *Verify: it looks EoB-ish.*
7. **Load test** — ramp 1k → 10k, profile, fix hot paths.
   *Verify: report the measured ceiling + decision on the sharding spike.*

## Risks

1. **Pyodide cold start (~2–5 s)** → progress UI + service-worker cache. Acceptable for a dungeon crawler.
2. **10k single-process ceiling** → visibility-gated deltas maximize it; sharding path (world_id per container) is the designed-out escape; the load test gives the real number.
3. **Pyodide ≠ native determinism** → restrict `game_core` to `random.Random(seed)` + integer tile math + explicit list iteration in `step()`. A headless test replays identical input logs natively and in Pyodide to prove state-hash parity.
4. **Wasm FS load of `game_core`** → the Dockerfile `COPY` bakes `client/static/game_core/` from `shared/`, so both sides literally ship the same files.

## v2 backlog (out of MVP scope)

- Chat (text overlay)
- Combat (melee attacks with health bars)
- Inventory / items
- Processed map generation (seeded) — `worlds.seed` column already exists
- Doors / dynamic world edits with `worlds.version` bumps
- Auth (currently name-based join)
