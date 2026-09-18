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
