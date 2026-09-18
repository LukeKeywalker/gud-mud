import game_core.world as W


def put(world, x, y, pid=9001):
    e = W.Entity(pid, "P", world.room_index_of_tile(x, y), x, y, 0, 7, False)
    world.add_entity(e)
    return e


def test_move_free(world):
    from game_core.moves import try_move
    e = put(world, 2, 2)
    assert try_move(world, e, 1, 0, 3) is True
    assert (e.x, e.y) == (3, 2)


def test_wall_blocks(world):
    from game_core.moves import try_move
    e = put(world, 1, 1)
    assert try_move(world, e, -1, 0, 3) is False
    assert (e.x, e.y) == (1, 1)


def test_diagonal_falls_back_x_then_y(world):
    from game_core.moves import try_move
    e = put(world, 1, 1)
    assert try_move(world, e, -1, 1, 3) is True
    assert (e.x, e.y) == (1, 2)  # full (0,2) wall, x-only (0,3?) wall, y-only (1,2) ok


def test_all_blocked(world):
    from game_core.moves import try_move
    e = put(world, 1, 1)
    assert try_move(world, e, -1, -1, 3) is False


def test_npc_tile_at_ping_pong(world):
    from game_core.moves import npc_tile_at
    for i, n in enumerate(world.spec.npcs):
        assert npc_tile_at(n, 0) == (2, 1)
        assert npc_tile_at(n, 4) == (2, 1)
        assert npc_tile_at(n, 5) == (3, 1)
        assert npc_tile_at(n, 9) == (3, 1)
        assert npc_tile_at(n, 10) == (2, 1)


def test_npc_blocks_target_next_tick(world):
    from game_core.moves import try_move
    e = put(world, 1, 1)
    # npc at t+1==2 is (2,1)
    assert try_move(world, e, 1, 0, 1) is False
    assert (e.x, e.y) == (1, 1)


def test_npc_clear_allows(world):
    from game_core.moves import try_move
    e = put(world, 1, 1)
    # npc at t+1==9 is (3,1), so (2,1) is free
    assert try_move(world, e, 1, 0, 8) is True
    assert (e.x, e.y) == (2, 1)


def test_npc_walks_between_distant_waypoints():
    import game_core.world as W
    from game_core.moves import npc_tile_at
    n = W.NpcDef(66001, "walker", ((2, 1), (5, 1)))
    assert npc_tile_at(n, 0) == (2, 1)
    assert npc_tile_at(n, 5) == (3, 1)
    assert npc_tile_at(n, 10) == (4, 1)
    assert npc_tile_at(n, 15) == (5, 1)
    assert npc_tile_at(n, 20) == (4, 1)
    assert npc_tile_at(n, 25) == (3, 1)


def test_step_latest_seq_wins(world):
    from game_core.moves import step, InputFrame
    e = put(world, 2, 2)
    step(world, 4, [InputFrame(9001, 5, 1, 0, 0), InputFrame(9001, 9, -1, 0, 0)])
    assert (e.x, e.y) == (1, 2)  # only seq 9 applied
    evs = step(world, 5, [InputFrame(9001, 10, -1, 0, 0)])
    assert (e.x, e.y) == (1, 2)  # (0,2) wall
    assert len(evs) == 0


def test_step_move_and_yaw_events(world):
    from game_core.moves import step, InputFrame
    e = put(world, 2, 2)
    evs = step(world, 0, [InputFrame(9001, 1, 1, 0, 500)])
    kinds = sorted((type(v).__name__, getattr(v, "pid", None)) for v in evs)
    assert ("EventMove", 9001) in kinds
    assert ("EventYaw", 9001) in kinds
    assert e.yaw == 500


def test_step_events_ordered_by_pid(world):
    from game_core.moves import step, InputFrame
    a = put(world, 2, 2, pid=101)
    put(world, 5, 2, pid=102)
    evs = step(world, 0, [InputFrame(102, 1, 1, 0, 0), InputFrame(101, 1, 1, 0, 0)])
    pids = [v.pid for v in evs if type(v).__name__ == "EventMove"]
    assert pids == [101, 102]


def test_step_updates_world_tick(world):
    from game_core.moves import step, InputFrame
    step(world, 7, [])
    assert world.t == 7
