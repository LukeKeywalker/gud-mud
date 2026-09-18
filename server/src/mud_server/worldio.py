from pathlib import Path

from game_core import world as W


def build_seed_spec(path: Path) -> W.WorldSpec:
    """Parse the ASCII map and attach the default patrolling NPC (id 65000)
    inside room A. Deterministic: no RNG anywhere in this path."""
    text = Path(path).read_text()
    spec = W.parse_map_text(text)
    a = next(r for r in spec.rooms if r.letter == "A")
    spec = W.add_npc(spec, W.NpcDef(65000, "warden", ((a.x + 2, a.y + 3), (a.x + 5, a.y + 3))))
    for k, (px, py) in enumerate(((a.x + 2, a.y + 5), (a.x + 4, a.y + 5), (a.x + 6, a.y + 2))):
        spec = W.add_prop(spec, W.PropDef(1, px, py))
    return spec


def spec_to_json(spec) -> str:
    import json
    return json.dumps({
        "w": spec.width, "h": spec.height,
        "codes": list(spec.codes),
        "rooms": [[r.index, r.letter, r.x, r.y, r.w, r.h] for r in spec.rooms],
        "npcs": [[n.id, n.kind, [[x, y] for (x, y) in n.route]] for n in spec.npcs],
        "props": [[p.kind, p.x, p.y] for p in spec.props],
    })


def spec_from_json(d: dict):
    from game_core import world as W
    rooms = tuple(W.RoomRect(ix, ch, x, y, rw, rh) for (ix, ch, x, y, rw, rh) in d["rooms"])
    npcs = tuple(W.NpcDef(nid, kind, tuple((x, y) for (x, y) in route))
                 for (nid, kind, route) in d["npcs"])
    props = tuple(W.PropDef(k, x, y) for (k, x, y) in d["props"])
    return W.WorldSpec(d["w"], d["h"], tuple(d["codes"]), rooms, npcs, props)
