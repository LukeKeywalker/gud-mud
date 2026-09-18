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
