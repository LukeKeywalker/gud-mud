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
