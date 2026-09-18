from __future__ import annotations

import json
import time

import asyncpg

from game_core.constants import WORLD_SCENE_VERSION
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
        row = await self.pool.fetchrow(
            "SELECT data, version FROM worlds WHERE id = 0")
        if row is None:
            return None
        if row["version"] != WORLD_SCENE_VERSION:
            await self.pool.execute("DELETE FROM worlds WHERE id = 0")
            return None
        data = row["data"]
        return data if isinstance(data, str) else json.dumps(data)

    async def save_world_scene(self, scene_json: str) -> None:
        await self.pool.execute(
            """INSERT INTO worlds (id, name, seed, data, version)
               VALUES (0, 'starter', NULL, $1, $2)
               ON CONFLICT (id) DO NOTHING""",
            scene_json,
            WORLD_SCENE_VERSION,
        )

    # ---- players ---------------------------------------------------------

    async def next_pid(self) -> int:
        pid = await self.pool.fetchval("SELECT nextval('pid_seq')")
        if pid > 64999:
            raise ValueError(f"pid {pid} exceeds 64999 ceiling")
        return pid

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
