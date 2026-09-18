import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


class Config:
    def __init__(self) -> None:
        self.port = int(os.environ.get("MUD_PORT", "8000"))
        self.db_dsn = os.environ.get("MUD_DB_DSN", "postgresql://mud:mud@db:5432/mud")
        self.static_dir = os.environ.get("MUD_STATIC", str(ROOT / "client" / "static"))
        self.map_path = os.environ.get("MUD_MAP", str(ROOT / "maps" / "starter.txt"))
        self.save_interval = float(os.environ.get("MUD_SAVE_INTERVAL", "30"))
        self.tick_sec = float(os.environ.get("MUD_TICK_SEC", "0.05"))


CONFIG = Config()
