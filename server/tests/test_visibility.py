def _put(world, x, y, pid):
    import game_core.world as W
    e = W.Entity(pid, "x", world.room_index_of_tile(x, y), x, y, 0, 1, False)
    world.add_entity(e)
    return e


def test_sees_adjacent_room(world):
    from game_core.visibility import visible_entities
    mate = _put(world, 7, 2, 555)
    viewer = _put(world, 2, 2, 111)
    ids = [e.pid for e in visible_entities(world, viewer)]
    assert 555 in ids
    assert 111 not in ids


def test_doorway_viewer_sees_both_rooms(world):
    from game_core.visibility import visible_entities
    viewer = _put(world, 4, 2, 111)
    _put(world, 2, 2, 555)
    _put(world, 7, 2, 556)
    ids = [e.pid for e in visible_entities(world, viewer)]
    assert 555 in ids and 556 in ids


def test_cap_picks_by_distance_then_pid(world):
    import game_core.world as W
    from game_core.constants import MAX_VISIBLE
    from game_core.visibility import visible_entities
    for i in range(160):
        e = W.Entity(7000 + i, "x", 2, 5 + (i % 3), 1 + (i // 3) % 3, 0, 1, False)
        world.add_entity(e)
    viewer = _put(world, 2, 2, 111)
    vis = visible_entities(world, viewer)
    def dist(e):
        from game_core.visibility import room_distance
        return room_distance(world.adj, 1, e.room)
    assert len(vis) == MAX_VISIBLE
    ds = [dist(e) for e in vis]
    assert all(d <= 1 for d in ds)  # npc at distance 0, room B entities at distance 1
    # npc (65000) is in room A (distance 0) so it appears first
    assert vis[0].pid == 65000


def test_room_distance(world):
    from game_core.visibility import room_distance
    assert room_distance(world.adj, 1, 1) == 0
    assert room_distance(world.adj, 1, 2) == 1
    assert room_distance(world.adj, 1, 99) == 99
