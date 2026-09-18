import game_core.constants as C
import game_core.world as W

def test_parse_map_dims_and_rooms(spec):
    assert (spec.width, spec.height) == (9, 5)
    assert [(r.index, r.letter, r.x, r.y, r.w, r.h) for r in spec.rooms] == [
        (1, "A", 1, 1, 3, 3), (2, "B", 5, 1, 3, 3),
    ]

def test_bad_char_rejected():
    import pytest
    with pytest.raises(ValueError):
        W.parse_map_text("#.\n#.\n")  # '.' is not a legal tile in this format

def test_adjacency_via_doorway(world):
    assert world.adj[1] == frozenset({2})
    assert world.adj[2] == frozenset({1})

def test_walkability(world):
    assert world.is_walkable(2, 2)
    assert world.is_walkable(4, 2)        # doorway middle is passable
    assert not world.is_walkable(4, 1)    # arch flank is solid stone
    assert not world.is_walkable(4, 3)    # arch flank is solid stone
    assert not world.is_walkable(0, 0)
    assert not world.is_walkable(9, 2)

def test_room_index_of_tile(world):
    assert world.room_index_of_tile(2, 2) == 1
    assert world.room_index_of_tile(7, 2) == 2
    assert world.room_index_of_tile(4, 2) == 2  # doorway resolves to max room touching it

def test_visible_rooms_at(world):
    assert world.visible_rooms_at(2, 2) == frozenset({1, 2})
    assert world.visible_rooms_at(4, 2) == frozenset({1, 2})  # doorway middle
    assert world.visible_rooms_at(4, 1) == frozenset({1, 2})  # arch flank inherits the door's rooms

def test_door_without_flanks_rejected():
    import pytest
    with pytest.raises(ValueError):
        W.build_world(W.parse_map_text("#########\n#AAAdBBB#\n#AAAdBBB#\n#AAAdBBB#\n#########"))

def test_orphan_arch_rejected():
    import pytest
    with pytest.raises(ValueError):
        W.build_world(W.parse_map_text("a########\n#AAAaBBB#\n#AAAdBBB#\n#AAAaBBB#\n#########"))

def test_state_hash_stable_and_sensitive(spec):
    h1 = W.state_hash(W.build_world(spec))
    h2 = W.state_hash(W.build_world(spec))
    assert h1 == h2
    assert isinstance(h1, bytes) and len(h1) == 16
    w = W.build_world(spec)
    w.add_entity(W.Entity(90, "t", 1, 2, 2, 0, 7, False))
    assert W.state_hash(w) != h1

def test_entity_order_sorted(world):
    w = world
    w.add_entity(W.Entity(5, "a", 1, 2, 2, 0, 1, False))
    w.add_entity(W.Entity(120, "b", 1, 2, 2, 0, 1, False))
    w.add_entity(W.Entity(1, "c", 1, 2, 2, 0, 1, False))
    assert [e.pid for e in w.entity_order] == sorted(e.pid for e in w.entity_order)
