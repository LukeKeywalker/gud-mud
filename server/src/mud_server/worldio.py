from pathlib import Path

from game_core import world as W


def build_seed_spec(path: Path) -> W.WorldSpec:
    """Parse the ASCII map and attach the default patrolling NPC (id 65000)
    inside room A. Deterministic: no RNG anywhere in this path."""
    text = Path(path).read_text()
    spec = W.parse_map_text(text)
    a = next(r for r in spec.rooms if r.letter == "A")
    spec = W.add_npc(spec, W.NpcDef(65000, "warden", ((a.x + 1, a.y + 1), (a.x + 2, a.y + 1))))
    return spec
