from __future__ import annotations

import hashlib
from dataclasses import dataclass, replace

from .constants import TILE_WALL, TILE_DOOR, TILE_ARCH

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
            elif ch == "a":
                codes.append(TILE_ARCH)
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
                elif c == TILE_ARCH:
                    self.walls[y * self.w + x] = 1
                else:
                    self.room_index[y * self.w + x] = c

        def room_code(px: int, py: int) -> int:
            if 0 <= px < self.w and 0 <= py < self.h:
                rc = spec.codes[py * self.w + px]
                return rc if ROOM_MIN <= rc <= ROOM_MAX else 0
            return 0

        for i in range(n):
            if spec.codes[i] != TILE_DOOR:
                continue
            x, y = i % self.w, i // self.w
            if room_code(x - 1, y) and room_code(x + 1, y):
                flanks = ((y - 1) * self.w + x, (y + 1) * self.w + x)
            elif room_code(x, y - 1) and room_code(x, y + 1):
                flanks = (y * self.w + x - 1, y * self.w + x + 1)
            else:
                raise ValueError(f"doorway at ({x},{y}) does not border two rooms")
            for f in flanks:
                if spec.codes[f] != TILE_ARCH:
                    raise ValueError(f"doorway at ({x},{y}) missing arch flank at ({f % self.w},{f // self.w})")
                if self._tile_rooms[f]:
                    raise ValueError(f"arch tile at ({f % self.w},{f // self.w}) shared by two doorways")
                self._tile_rooms[f] = self._tile_rooms[i]
        for i, c in enumerate(spec.codes):
            if c == TILE_ARCH and not self._tile_rooms[i]:
                raise ValueError(f"arch tile at ({i % self.w},{i // self.w}) belongs to no doorway")
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
        if c == TILE_DOOR or c == TILE_ARCH:
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
