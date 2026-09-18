import os

def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)

def _env_int(name: str, default: int) -> int:
    return int(_env(name, str(default)))

class Config:
    def __init__(self) -> None:
        self.port = _env_int("MUD_PORT", 8000)
        self.db_dsn = _env("MUD_DB_DSN", "postgresql://mud:mud@localhost:5432/mud")
        self.static_dir = _env("MUD_STATIC", "client/static")
        self.save_interval = _env_float("MUD_SAVE_INTERVAL", "30")
        self.tick_sec = float(_env("MUD_TICK_SEC", "0.05"))

def _env_float(name: str, default: str) -> float:
    return float(_env(name, default))

CONFIG = Config()
