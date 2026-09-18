from __future__ import annotations

import struct

from .constants import (
    KICK_CONGESTION, MSG_JOIN, MSG_WELCOME, MSG_INPUT, MSG_RESYNC_REQ, MSG_STATE,
    MSG_RESYNC,
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
