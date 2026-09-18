from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

SEND_QUEUE_MAX = 32


@dataclass
class Client:
    ws: Any
    name: str = ""
    pid: int = 0
    ent: Any = None
    color: int = 0
    ack: int = 0
    q: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=SEND_QUEUE_MAX))
    apply_ticks: dict = field(default_factory=dict)
    known: dict = field(default_factory=dict)
    resync: bool = False
    full_since: float | None = None
