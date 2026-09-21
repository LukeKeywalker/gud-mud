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


def _place(loop, ent, x, y):
    room = loop.world.room_index_of_tile(x, y)
    ent.x, ent.y, ent.room = x, y, room
    for c in loop.clients.values():
        c.known[ent.pid] = (x, y, room, ent.yaw)


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
    _place(loop, a.ent, 1, 2)
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
    _place(loop, a.ent, 1, 1)
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
    assert (spec.width, spec.height) == (46, 37)
    assert len(spec.rooms) == 20
    letters = [r.letter for r in spec.rooms]
    assert letters == sorted("ABCDEFGHIJKLMNOPQRST")
    a = next(r for r in spec.rooms if r.letter == "A")
    assert (a.x, a.y) == (10, 10)
    # every doorway touches exactly two distinct rooms and is a 3-tile arch run: 'a'/'d'/'a'
    arches = 0
    for i, c in enumerate(spec.codes):
        if c == 22:
            arches += 1
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
            horiz = spec.codes[y * spec.width + x - 1] == 22 and spec.codes[y * spec.width + x + 1] == 22
            vert = spec.codes[(y - 1) * spec.width + x] == 22 and spec.codes[(y + 1) * spec.width + x] == 22
            assert horiz or vert, f"doorway at ({x},{y}) has no arch flanks"
    doors = spec.codes.count(21)
    assert arches == 2 * doors
    assert doors == 31
    assert len(spec.npcs) == 0
    assert len(spec.props) == 3
