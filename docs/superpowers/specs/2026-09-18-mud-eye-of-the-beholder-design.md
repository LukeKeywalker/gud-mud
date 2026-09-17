# MUD "Eye of the Beholder" — Design Spec

Date: 2026-09-18
Status: validated (brainstorming complete, all sections approved)
Supersedes: `mud-implementation-plan.md` (draft; see §11 for decisions that changed)

A browser FPS MUD in the style of *Eye of the Beholder*: dense exponential fog,
flickering torch light, right-angled stone rooms, other live players, and one
patrolling blocking NPC. Python end to end: a shared pure-Python `game_core`
runs natively on the server and in the browser via Pyodide; the server is
single-process asyncio, sharding-ready; the wire is hand-rolled big-endian
binary over WebSocket; persistence is Postgres 16.

## 1. Final decisions

| Area | Choice |
|---|---|
| Client | Browser + Three.js, EoB-style FPS (FogExp2, flickering torch, stone boxes) |
| Shared logic | Pure-Python `game_core`, native on server, in browser via **Pyodide** (kept as drafted) |
| Server | Python asyncio, single process, sharding-ready (`world_id` pre-baked in `join`) |
| Transport | WebSocket, **binary frames**, hand-rolled big-endian pack/unpack in `game_core` |
| World | Tile grid, **tile = 0.25 m**, deterministic 20 Hz integer sim |
| Movement | Direction-state input (`dx,dy ∈ {-1,0,1}`), **1 tile/tick max**, fixed slide order, client tween ~50 ms |
| NPC | **Patrolling blocker**: solid, ping-pong route, `npc_tile_at(tick)` pure in core |
| Sync | Server-authoritative + client prediction/reconciliation (seq numbers, resync snapshot) |
| Visibility | Own room + adjacent rooms through doorway tiles; **no per-tile raycast**; **128-entity visible-set cap** per player |
| Persistence | Postgres 16, dirty batch save 30 s + forced save on disconnect; restore on rejoin by name |
| MVP scope | Movement + collision, live players, props, 1 NPC. (Chat/combat/inventory → v2) |
| Local setup | `docker-compose`: `db` + `server`; server serves client statics at `http://localhost:8000` |

## 2. System shape

```
                ┌────────────────────────────────────────────────┐
  Browser 3     │  app.js ── input ──▶ game_core (Pyodide/WASM)  │
  tab           │   ▲  60fps                     │ pred. inputs  │
  Three.js ◀────┤   └ render ◀── reconcile ◀─────┤               │
                └──────────────┬─────────────────┘
                WSS :8000 (binary frames)
                ┌──────────────▼─────────────────────┐      ┌──────────────┐
                │ server (uvicorn, asyncio)          │      │ postgres:16  │
                │  game loop 20Hz ─▶ game_core       │ ───▶ │  asyncpg     │
                │  (native, authoritative state)     │  30s │  snapshots   │
                │  room-grid spatial index → per-    │      └──────────────┘
                │  player visible sets → deltas      │
                └─────────────────────────────────────┘
```

- **Pyodide dual-runtime (kept as drafted).** `shared/game_core/` is shipped
  byte-identical to both runtimes: native in the server image, into the Pyodide
  WASM FS for the browser. A headless parity test replays an input log natively
  and in Pyodide and asserts identical `state_hash` (build step 2, fail-fast).
- **No RNG in `game_core.step()`.** The MVP has no randomness source (static
  map, static NPC route); state is an exact function of
  `(initial world spec, input log)`. Any test-side random input generator lives
  *outside* `game_core`. `worlds.seed` remains the v2 map-gen hook.
- **Movement model.** Input is direction *state*, not per-frame deltas. Server
  rule: at most 1 tile/tick. Diagonal fallback order is fixed: full → x-only →
  y-only (deterministic replay). At 20 tiles/s × 0.25 m = 5 m/s walk speed.
  The client tweens its camera between tile centers over ~50 ms so discrete
  steps read as EoB-style sliding; wall-hugging emerges from the axis fallback.
- **NPC.** One patroller, loaded from the `npcs` table, ping-pong route.
  `npc_tile_at(world, npc_id, tick) -> (x, y)` is a pure function in
  `game_core`, so the client's WASM core computes the identical position and
  can reject locally into the NPC. The NPC is solid: a player stepping onto its
  tile is rejected (no move event), which exercises the full
  rejection/reconciliation path.

## 3. World & map format

ASCII map, 1 char = 1 tile (0.25 m):

| char | meaning |
|---|---|
| `#` | wall / out-of-world |
| `A`–`T` | floor tile belonging to room `A`–`T` (≤ 20 rooms MVP) |
| `d` | doorway tile: walkable, carves an opening in a wall run |

- **Rooms are explicit** via lettering; **adjacency is derived**: rooms X and Y
  are adjacent iff a `d` tile has walkable neighbors in both. No adjacency list
  is hand-authored.
- **Visible set** for a player = own room + all adjacent rooms. *All* entities
  in visible rooms are seen — no per-tile raycast in MVP. This matches the EoB
  room-grid look, is cheap at 10k, and is deterministic.
- **Wire world spec:** the `welcome` message carries the static world blob:
  5-bit tile codes (0=wall, 1–20=room index, 21=doorway), room rects
  (u16 x, y, w, h per room), NPC routes (u8 len, then i16 x, i16 y per route
  tile), and a prop list (u8 count, then per prop: u8 kind, i16 x, i16 y).
  The joining player's start tile/yaw are separate `welcome` fields (§5), not
  part of the blob. The client reconstructs a local `WorldState`
  through the *same* `build_world(spec)` the server uses, so both sides hold
  byte-identical static data.
- Props (decorative meshes: crates, skeletons, the smoking-cabinet) are
  render-only in MVP: they appear in the world spec with a prop kind and tile,
  no collision (solid props are trivially v2-extendable but YAGN now).

`maps/starter.txt`: ~20 right-angled rooms, A–T, author to compose in build
step 6 with a small center hub.

## 4. `game_core` (pure Python, deterministic)

Files: `constants.py`, `world.py`, `moves.py`, `visibility.py`, `protocol.py`.

Constraints (enforced by review + tests): **stdlib only, no I/O, no threads, no
RNG, all iteration over explicit ordered lists.** Importable from Pyodide
unchanged (no `__name__`-gated Python-isms, no C-stdlib modules).

API:

- `build_world(spec) -> WorldState` — one canonical builder. `WorldState`
  holds: map dims, per-tile room/wall/doorway classes (compact bytes), room
  list (rects), precomputed `visible_set[room]`, entities (ordered list +
  id-indexed dict), NPC routes.
- `npc_tile_at(world, npc_id, tick) -> (x, y)` — ping-pong index math over the
  stored route.
- `try_move(world, ent, dx, dy, tick) -> (x, y)` — candidate tile must be
  walkable at tick `t+1`: not wall, and not any NPC's `npc_tile_at(t+1)`.
  Diagonal fallback: full → x-only → y-only. (RNG-free, identical both
  runtimes.)
- `step(world, tick, inputs) -> list[Event]` — applies **≤ 1 input per player
  per tick; latest-seq frame wins** (explicit rule for the "two frames arrived
  before ack" case); advances NPCs; emits `Move(id,x,y,room)` /
  `Yaw(id,yaw)` events in deterministic order.
- `visible_room_set(world, room) -> frozenset` — precomputed at build.
- `state_hash(world) -> bytes` — `hashlib.blake2b` over a canonical
  serialization (entities ordered by id, tiles as raw bytes). Used by the
  determinism/parity tests.
- `protocol.py` — pack/unpack for every message in §5 (portable to WASM).

## 5. Protocol

1-byte kind + big-endian fields, one WebSocket **binary frame per message**.
Max frame guard: 64 KB (server drops connection with `0x20 reason=3` above it).

| Kind | Name | Wire |
|---|---|---|
| `0x01` | join (C→S) | u16 world_id (=0 MVP), u8 name_len, utf8 name |
| `0x02` | welcome (S→C) | u32 self_id, u32 tick, u16 map_w, u16 map_h, u16 world_blob_len, world blob (§3), u8 color, i16 start_x, i16 start_y, u16 start_room, u16 start_yaw, u8 name_len, utf8 name |
| `0x03` | input (C→S) | u32 seq, i8 dx, i8 dy, u16 yaw16 |
| `0x04` | resync_req (C→S) | — |
| `0x10` | state (S→C) | u32 tick, u32 ack_seq, u16 total_connected, u16 op_count, ops… |
| `0x11` | resync (S→C) | u32 tick, u32 ack_seq, u16 total_connected, u16 op_count, ops… (full visible-set snapshot) |
| `0x20` | kick (S→C) | u8 reason (0=congestion, 1=reserved, 2=shutdown, 3=oversized_frame), u8 msg_len, utf8 msg |
| `0x21` | error (S→C, non-fatal) | u8 reason (0=name_in_use, 1=bad_name, 2=other), u8 msg_len, utf8 msg |

Ops:

| op kind | Name | Fields |
|---|---|---|
| `0x0` | move | u16 entity_id, i16 x, i16 y, u16 room |
| `0x1` | spawn | u16 entity_id, i16 x, i16 y, u16 room, u16 yaw16, u8 color, u8 name_len, utf8 name |
| `0x2` | despawn | u16 entity_id |
| `0x3` | yaw | u16 entity_id, u16 yaw16 |

- **yaw16**: 0–2047 steps per full turn (≈0.175°). Display-only metadata, not
  used in simulation; kept integer so both runtimes parse identically.
- **Entity ids** u16: players 1–64999 (server-allocated, stable per session,
  freed on disconnect), NPCs 65000–65009 (MVP: one NPC, id 65000).
- **Behind the name→entity mapping:** on `join`, server looks up the name in
  the `players` table. Name online → `0x21 name_in_use`. Name known, offline →
  restore stored room/x/y/yaw, keep the stored entity id (rejoin security is
  name-based; auth is v2). New name → new id, random center-room spawn,
  random color.
- **Budget:** move op ≈ 9 B. Worst case 128 visible entities cap bounds a state
  frame; a fully-moving crowded room ≈ 128 × 9 B ≈ 1.2 KB/tick for that
  player. Realistic load is far lower via visibility gating. The load test
  measures actual egress; the draft's "150–300 B/player/tick" is the uncrowded
  case.

## 6. Server

`server/` — uvicorn app, single process.

- **`main.py`**: routes `GET /` → static `client/static/`, `WS /ws`,
  `GET /healthz` → JSON `{uptime_s, tick, connected, send_queue_max}`.
- **`game_loop.py`**: one 20 Hz task on a monotonic clock (tick = u32, starts
  0, increments per tick). Tick body:
  1. Drain per-connection input queues; each frame tagged with arrival tick.
  2. Sort by `(arrival_tick, player_id)`; within a tick, latest-seq frame wins.
  3. `game_core.step(world, tick, inputs)` → events.
  4. Update room-grid spatial index on moved entities.
  5. Per player: diff current visible set vs last tick → ops:
     `spawn` (entity newly appears in this player's visible set this tick),
     `move`, `yaw` (only when yaw16 changed), `despawn` (left the visible set
     or disconnected).
  6. Visible-set cap: **max 128 entities per player**, deterministic pick
     (room-graph distance from player's room, then entity id). This is the
     insurance against the one-crowded-room O(n²) encoding blowup.
  7. Encode state frames (with `total_connected`) → per-connection send queue.
- **`connections.py`**: per-socket async IO. Send queue `asyncio.Queue`
  maxlen 32, **drop-oldest** on overflow. **Congestion kick:** queue full for
  > 2 s → send `0x20 reason=congestion` and close. One slow client must never
  tax the loop.
- **`spatial.py`**: `dict[room -> ordered entity list]`, updated on move;
  per-player visible set = precomputed `visible_set[room]` ∩ index.
- **`persistence.py`**: §7.
- **`config.py`**: port, db dsn, tick rate, caps — env-overridable.

`Dockerfile`: `python:3.12-slim`, uvicorn[standard] + websockets + asyncpg,
**`COPY shared/game_core/`** baked in (single source of truth for the logic),
same image copies `client/static/` (including its copy of `game_core/` for the
Pyodide FS).

## 7. Persistence (Postgres 16)

- Connection: asyncpg pool of 3, `db` container from compose with healthcheck.
- **`db/init.sql`** — schema:

```sql
CREATE TABLE players (
  id        SERIAL PRIMARY KEY,
  name      TEXT UNIQUE NOT NULL,
  color     SMALLINT NOT NULL,
  room      SMALLINT NOT NULL,
  x         SMALLINT NOT NULL,
  y         SMALLINT NOT NULL,
  yaw       SMALLINT NOT NULL,
  dirty     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE npcs (
  id   SMALLINT PRIMARY KEY,
  kind TEXT NOT NULL,
  room SMALLINT NOT NULL,
  x    SMALLINT NOT NULL,
  y    SMALLINT NOT NULL,
  data JSONB NOT NULL,          -- {"route": [[x, y], ...], "ping_pong": true}
  dirty BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE worlds (
  id      SMALLINT PRIMARY KEY,
  name    TEXT NOT NULL,
  seed    BIGINT,
  data    JSONB NOT NULL,       -- canonical world spec (tiles, rooms, props)
  version INTEGER NOT NULL DEFAULT 1
);
```

- **Startup:** load all rows into in-memory `WorldState`. `worlds.id` is the
  `world_id` used in `join`; the MVP world row is `id=0`. If the DB is empty,
  seed it with the world row (id 0, canonical spec from `maps/starter.txt`)
  plus the default patrolling NPC row (id 65000); `players` stays empty
  (players appear on first join).
- **Dirty save:** every 30 s, save only rows flagged dirty (tile/room change).
  Yaw-only changes do **not** dirty (avoids flag churn). On disconnect: forced
  full-row save of that player. Best-effort flush on orderly shutdown.
- **Rejoin:** join by name restores last stored room/x/y/yaw (MVP, per draft:
  "rejoin by name restores last position").
- The `worlds.version` column is the pre-built hook for v2 world edits
  (opened doors, placed items) — static in MVP.

## 8. Client (browser)

- **Loader** (`loading.html` → `index.html`): boot Pyodide with a progress bar
  (fetch `game_core/` files into the WASM FS). A service worker caches
  Pyodide + `game_core` fetches (opaque-response caching) for instant later
  loads.
- **Welcome** → `build_world(spec)` on the WASM core → local `WorldState`
  byte-identical to the server's static data. Spawn self at `start_*`.
- **Input:** WASD → `dx,dy` direction state; pointer-lock mouse → yaw. Yaw is
  quantized to yaw16 for the wire.
- **Output cadence:** send one `0x03` input frame every 50 ms (coalesced
  local input state), incrementing `seq`, into a pending ring buffer (cap 32).
  Intent is sent **even when local `try_move` rejects** — the server is
  authoritative; local rejection only stops the visual slide (wall-hug feel).
- **Prediction:** on each local output, run `game_core.try_move` on the local
  `WorldState` copy and advance the predicted self tile immediately.
- **Reconciliation** on each `0x10`/`0x11` (carries `server_tick` + `ack_seq`):
  1. Drop pending frames with `seq <= ack_seq`.
  2. Re-simulate the un-acked frames chained from the server's own-entity op.
  3. Snap if a prediction was rejected (wall, doorway, or **NPC in the way** —
     replicated locally via `npc_tile_at`).
- **Other players / NPCs:** 2-sample interpolation buffer rendered at 60 fps
  (≈1 tick of render delay) so 20 Hz updates look smooth.
- **Resync trigger:** `unacked > 5` (~250 ms), or self-mismatch **after
  reconciliation** still `> 2 tiles` (i.e. re-sim from the server op didn't
  explain the divergence), or a local rejection the local core can't explain
  (NPC/wall state the local `WorldState` doesn't agree with) → send `0x04
  resync_req` → server `0x11 resync` full snapshot → clear pending, rebase.
- **Rendering (EoB look):** `THREE.FogExp2` near-black; instanced stone walls
  with a generated brick texture; right-angled rooms from the world spec; one
  flickering warm `PointLight` at the camera (no shadows in MVP); colored
  capsule avatars + floating name sprites; crosshair HUD; "N players connected"
  counter (from `total_connected`); yaw is transmitted so others see your facing.
- **Controls:** WASD + pointer-lock mouse look.

`app.js` is the glue: loader → scene → 20 Hz input/prediction/`game_core`
calls → 60 fps render/reconcile. `three.module.js` is vendored at a pinned rev.

## 9. Scale plan (honest)

- Single asyncio process is the MVP. The 10k trick = **room-grid visibility +
  128-entity visible cap**: nobody pays for the whole world, only their visible
  rooms, bounded by the cap.
- **`loadtest/load.py`**: N synthetic WS clients (real connections, random walk
  at 20 Hz). Runs **on the host** (not in compose) against
  `ws://localhost:8000/ws` via `make load`. Ramp 1k → 10k (or to the machine's
  limit; flags to cap). Report p50/p99 input→ack latency, per-tick encode
  time, CPU, and egress MB/s. Names the hardware.
- **Expectation:** a single CPython process realistically shows its ceiling in
  the low thousands at full fidelity. The pre-built escape = **sharding**:
  `world_id` is already in `join` (always 0 in MVP), so the router + one
  container per world is additive, not a protocol break. We report the
  measured ceiling; we do not fake it. The measured number decides the sharding
  spike.
- If the ASGI WebSocket layer is CPU-hot, swap to the `websockets` server
  directly on the same port — one-line change (already in the dep stack).

## 10. Build order (verify each step before the next)

1. **Scaffold** — compose (db + server), empty WS `echo` on `/ws`, `/healthz`,
   static `/`, `make up`. *Verify: a `wscat`/script connects to `/ws` and gets
   its binary frame echoed; `/healthz` 200.*
2. **`game_core` + tests** — world/step/collision/sliding/visibility/protocol;
   **determinism test**: 10k random-input replays → identical `state_hash`;
   **parity test**: same replay native vs Pyodide → identical hash.
   *Verify: `pytest` green.*
3. **Server loop** — join by name (in-use/restore/new), 20 Hz step,
   visibility deltas, 128-cap, congestion kick, welcome world blob.
   *Verify: two fake WS clients; one watches the other move; an NPC-in-the-way
   step is rejected (no move op) with the ack still advancing.*
4. **Browser client** — Pyodide loader + progress, Three.js scene, input,
   prediction + reconciliation, resync, HUD. *Verify: two browser tabs see each
   other move; wall/NPC collisions agree with the server; a forced desync
   (throttle one tab) triggers a clean resync.*
5. **Persistence** — schema, seed, load-on-start, dirty-save 30 s,
   save-on-disconnect, rejoin restore. *Verify: `kill -9` the server, restart,
   rejoin by name → player is at last position.*
6. **Atmosphere pass** — author `maps/starter.txt` (~20 rooms A–T), brick
   texture, torch flicker, name sprites, loading screen polish, center hub.
   *Verify: it looks EoB-ish on screen.*
7. **Load test** — ramp 1k→10k, profile (py-spy/cProfile on tick), fix hot
   paths (protocol encode, visible-set diff). *Verify: report the measured
   ceiling + a written decision on the sharding spike.*

`Makefile`: `up` | `down` | `logs` | `test` | `load`.

## 11. Risks

| # | Risk | Handling |
|---|---|---|
| 1 | Pyodide cold start (~2–5 s) | Progress UI + service-worker opaque-response cache. Accepted for a dungeon crawler. |
| 2 | Native↔Pyodide determinism | `game_core.step()` has **no RNG** — state is a pure function of (spec, input log). Parity test (build step 2) replays an input log in both runtimes and asserts identical `state_hash` before we build on it. |
| 3 | 10k single-process ceiling | Room-grid visibility + 128-entity cap maximize it; `world_id` in `join` pre-builds the per-world sharding path; load test reports the real number. |
| 4 | Wasm FS load of `game_core` | `Dockerfile COPY` bakes `client/static/game_core/` from `shared/`, so both sides ship the same files. |
| 5 | One-crowded-room O(n²) encode | 128-entity visible-set cap (deterministic pick) + congestion kick bound per-tick encode cost. |

## 12. Repo layout

```
mud/
├── docker-compose.yml          # db (postgres:16-alpine, healthcheck), server
├── Makefile                    # up | down | logs | test | load
├── maps/starter.txt            # ASCII tile map ('#' wall, 'A'-'T' rooms, 'd' doorway)
├── db/init.sql                 # schema
├── shared/game_core/           # ★ THE shared package — pure stdlib, no I/O/threads/RNG
│   ├── __init__.py
│   ├── constants.py            #   tick rate, tile size, caps, op/kind codes
│   ├── world.py                #   WorldState, build_world, state_hash
│   ├── moves.py                #   normalize_input / try_move / npc_tile_at
│   ├── visibility.py           #   room adjacency + visible-set derivation, 128-cap
│   └── protocol.py             #   binary message pack/unpack (portable to WASM)
├── server/
│   ├── Dockerfile              # python:3.12-slim, uvicorn[standard]+websockets+asyncpg
│   ├── pyproject.toml
│   ├── src/mud_server/
│   │   ├── main.py             # app: static / + WS /ws + /healthz
│   │   ├── game_loop.py        # 20Hz tick: drain inputs → order → step → delta
│   │   ├── connections.py      # per-socket watcher, drop-oldest send queue, congestion kick
│   │   ├── spatial.py          # room-grid index; "who sees whom"
│   │   ├── persistence.py      # asyncpg pool, load/seed, dirty-save 30s, save-on-disconnect
│   │   └── config.py
│   ├── tests/                  # determinism, parity, collision, visibility, protocol round-trip
│   └── loadtest/load.py        # N synthetic WS clients, random walk, latency percentiles
└── client/static/
    ├── index.html  loading.html  styles.css
    ├── sw.js                 # service worker: opaque-response cache
    ├── game_core/            # copied from shared/ → mounted into Pyodide FS
    ├── three.module.js        # vendored, pinned rev
    └── app.js                 # loader → scene → input/prediction/reconcile glue
```

## 13. v2 backlog (out of MVP scope)

- Chat (text overlay)
- Combat (melee attacks with health bars)
- Inventory / items
- Processed/seeded map generation — `worlds.seed` already exists
- Doors / dynamic world edits with `worlds.version` bumps
- Auth (currently name-based join)
- Solid (collidable) props (render-only in MVP)

## 14. Deviations from the original draft (`mud-implementation-plan.md`)

Changes made during brainstorming (all others kept as drafted):

- **Map format** extended from `#`/`.` to `#` / `A`–`T` / `d` so rooms are
  explicit (needed for visibility gating) and adjacency is *derived*, not listed.
- **Movement** made explicit: direction-state input, 1 tile/tick, fixed
  diagonal fallback order, tile = 0.25 m ⇒ 5 m/s, client tween ~50 ms.
- **NPC** specified as a **patrolling solid blocker** with `npc_tile_at(tick)`
  pure in `game_core` (so the client can replicate it locally for rejection).
- **`game_core.step()` has no RNG** — stronger determinism guarantee than the
  draft's `random.Random(seed)` allowance.
- **Latest-seq-wins** rule per player per tick made explicit.
- **yaw16** (0–2047 steps/turn) defined as the wire encoding of facing.
- **128-entity visible-set cap** (deterministic pick) + **congestion kick**
  added as the O(n²)/slow-client guards.
- `welcome` carries a **5-bit tile-code world blob** (incl. prop list) + the
  joining player's start position; the client rebuilds `WorldState` via the
  same `build_world`.
- `join` pre-bakes **`world_id`** (=0 in MVP) to keep the sharding path additive.
- **Rejoin-restore** semantics for existing names made explicit; `name_in_use`
  error for currently-online names.
- Protocol table specifies exact binary layouts (draft had signatures only).
