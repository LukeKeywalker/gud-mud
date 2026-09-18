import base64
import json
import pickle
import shutil
import subprocess
from pathlib import Path

import pytest

import game_core.moves as M
import game_core.world as W
from conftest import make_spec

HERE = Path(__file__).resolve().parent
PARITY = HERE / "parity"


def _log():
    log = []
    for t in range(2000):
        frames = []
        for k, pid in enumerate((1001, 1002, 1003)):
            dx = (t + k) % 3 - 1
            dy = (t * 2 + k) % 3 - 1
            if dx == dy == 0:
                continue
            frames.append((pid, t * 10 + k, dx, dy, (t + k * 7) % 2048))
        log.append((t, frames))
    return log


def test_parity_native_vs_pyodide():
    if shutil.which("node") is None:
        pytest.skip("node unavailable")
    if not (PARITY / "node_modules" / "pyodide").exists():
        pytest.skip("npm pyodide not installed (run: npm --prefix server/tests/parity install)")
    spec = make_spec()
    log = _log()

    w = W.build_world(spec)
    for pid in (1001, 1002, 1003):
        w.add_entity(W.Entity(pid, "p", 1, 2, 2, 0, 7, False))
    for t, frames in log:
        M.step(w, t, [M.InputFrame(*f) for f in frames])
    native = W.state_hash(w).hex()

    shared = HERE.parents[1] / "shared" / "game_core"
    names = ("__init__.py", "constants.py", "world.py", "moves.py", "visibility.py", "protocol.py")
    payload = json.dumps({
        "files": {f"/mud/game_core/{n}": base64.b64encode((shared / n).read_bytes()).decode() for n in names},
        "pkl": base64.b64encode(pickle.dumps(spec)).decode(),
        "log": base64.b64encode(json.dumps(log).encode()).decode(),
    })
    (PARITY / "payload.json").write_text(payload)
    r = subprocess.run(["node", "runner.mjs", "payload.json"], cwd=str(PARITY),
                       capture_output=True, text=True, timeout=600)
    assert r.returncode == 0, (r.stdout, r.stderr)
    got = [l for l in r.stdout.strip().splitlines() if l.startswith("HASH ")]
    assert got and got[-1] == "HASH " + native, f"parity mismatch: native={native} pyodide={got}"
