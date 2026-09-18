import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "shared"))

# 3-tile arch doorway in the middle column: 'a'/'d'/'a', only 'd' passable
MAP = """\
#########
#AAAaBBB#
#AAAdBBB#
#AAAaBBB#
#########"""

def make_spec(npc: bool = True):
    import game_core.world as gw
    spec = gw.parse_map_text(MAP)
    if npc:
        spec = gw.add_npc(spec, gw.NpcDef(65000, "warden", ((2, 1), (3, 1))))
    return spec

@pytest.fixture
def spec():
    return make_spec()

@pytest.fixture
def world():
    import game_core.world as gw
    return gw.build_world(make_spec())
