import json

from conftest import make_spec
from fake import join_client
from mud_server.game_loop import GameLoop
from mud_server.worldio import spec_to_json, spec_from_json


class FakeStore:
    def __init__(self):
        self._next_pid = 100
        self.players = {}
        self.scene = None
        self.was_closed = False

    async def init(self):
        pass

    async def close(self):
        self.was_closed = True

    async def next_pid(self):
        p = self._next_pid
        self._next_pid += 1
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
