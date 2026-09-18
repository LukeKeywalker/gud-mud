import pytest
import game_core.protocol as P
import game_core.world as W


def sample_spec():
    return W.parse_map_text(
        "#########\n#AAAdBBB#\n#AAAdBBB#\n#AAAdBBB#\n#########"
    )


def test_join_roundtrip():
    b = P.pack_join(0, "Alice")
    assert b[0] == 1
    wid, name = P.unpack_join(b)
    assert wid == 0 and name == "Alice"


def test_input_golden_bytes():
    b = P.pack_input(7, 1, 0, 0x1234)
    assert b.hex() == "030000000701001234"


def test_input_roundtrip_neg():
    b = P.pack_input(1, -1, -1, 0)
    seq, dx, dy, yaw = P.unpack_input(b)
    assert (seq, dx, dy, yaw) == (1, -1, -1, 0)


def test_tiles_5bit_odd_length():
    codes = [1, 2, 3]  # 3 tiles x 5 bits = 15 data bits, padded by `(-len(bits) % 8)` = 1 bit, total 16 bits = 2 bytes
    raw = P.pack_tiles(codes)
    assert len(raw) == 2
    assert P.unpack_tiles(3, raw) == [1, 2, 3]


def test_tiles_5bit_roundtrip_larger():
    codes = list(range(1, 21)) * 4 + [21, 0] * 3
    raw = P.pack_tiles(codes)
    assert P.unpack_tiles(len(codes), raw) == codes


def test_world_blob_roundtrip():
    spec = sample_spec()
    blob = P.pack_world_blob(spec)
    back = P.unpack_world_blob(blob)
    assert back.width == spec.width and back.height == spec.height
    assert list(back.codes) == list(spec.codes)
    assert [(r.index, r.x, r.y, r.w, r.h) for r in back.rooms] == \
           [(r.index, r.x, r.y, r.w, r.h) for r in spec.rooms]


def test_world_blob_with_npc():
    spec = W.add_npc(sample_spec(), W.NpcDef(65000, "warden", ((2, 1), (3, 1))))
    blob = P.pack_world_blob(spec)
    back = P.unpack_world_blob(blob)
    assert len(back.npcs) == 1
    n = back.npcs[0]
    assert n.id == 65000 and n.kind == "warden"
    assert list(n.route) == [(2, 1), (3, 1)]


def test_state_roundtrip_all_ops():
    spec = sample_spec()
    ops = [
        P.pack_op_move(9, 1, 2, 1),
        P.pack_op_spawn(10, 3, 4, 2, 500, 200, "Bob"),
        P.pack_op_despawn(11),
        P.pack_op_yaw(9, 77),
    ]
    b = P.pack_state(42, 7, 3, ops)
    assert b[0] == 16
    kind, tick, ack, conn, back_ops = P.unpack_state(b)
    assert (kind, tick, ack, conn) == (16, 42, 7, 3)
    assert back_ops == [
        (0, 9, 1, 2, 1),
        (1, 10, 3, 4, 2, 500, 200, "Bob"),
        (2, 11),
        (3, 9, 77),
    ]


def test_resync_kind():
    b = P.pack_resync(1, 0, 1, [P.pack_op_spawn(1, 1, 1, 1, 0, 1, "A")])
    kind, = (b[0],)
    assert kind == 17
    kind, tick, ack, conn, ops = P.unpack_state(b)
    assert kind == 17 and tick == 1 and len(ops) == 1


def test_welcome_roundtrip():
    spec = sample_spec()
    blob = P.pack_world_blob(spec)
    b = P.pack_welcome(1, 5, blob, 200, 2, 2, 1, 0, "Alice")
    (self_id, tick, blob2, color, sx, sy, sroom, syaw, name) = P.unpack_welcome(b)
    assert self_id == 1 and tick == 5 and color == 200
    assert (sx, sy, sroom, syaw) == (2, 2, 1, 0)
    assert name == "Alice"
    assert blob2 == blob


def test_kick_error_roundtrip():
    b = P.pack_kick(0, "congestion")
    reason, msg = P.unpack_kick(b)
    assert (reason, msg) == (0, "congestion")
    assert b[0] == 32
    b = P.pack_error(1, "bad name")
    reason, msg = P.unpack_error(b)
    assert (reason, msg) == (1, "bad name")
    assert b[0] == 33


def test_bad_kind_raises():
    with pytest.raises(ValueError):
        P.unpack_state(b"\x99" + b"\x00" * 12)


def test_oversized_state_raises_or_truncates():
    # guard must reject frames above FRAME_MAX when the caller passes the flag
    with pytest.raises(ValueError):
        P.check_frame_size(70000)
