from __future__ import annotations

from .constants import MAX_VISIBLE
from .world import Entity, WorldState


def room_distance(adj: dict, a: int, b: int) -> int:
    if a == b:
        return 0
    seen = {a: 0}
    frontier = [a]
    while frontier:
        nxt = []
        for cur in frontier:
            for nb in sorted(adj.get(cur, frozenset())):
                if nb in seen:
                    continue
                seen[nb] = seen[cur] + 1
                if nb == b:
                    return seen[nb]
                nxt.append(nb)
        frontier = nxt
    return 99


def visible_entities(w: WorldState, viewer: Entity, limit: int = MAX_VISIBLE) -> list[Entity]:
    vrooms = w.visible_rooms_at(viewer.x, viewer.y)
    others = []
    for e in w.entity_order:
        if e.pid == viewer.pid:
            continue
        if e.room not in vrooms:
            continue
        others.append(e)
    others.sort(key=lambda e: (room_distance(w.adj, viewer.room, e.room), e.pid))
    return others[:limit]
