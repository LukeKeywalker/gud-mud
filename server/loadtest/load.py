"""Synthetic WS client ramp. Run in the server container:
    python -m loadtest.load --max 10000 --stage-sec 30 --report /tmp/load_report.md
Each client random-walks at 20 Hz and records input→ACK latency."""
import argparse
import asyncio
import random
import statistics
import time
import urllib.request

import psutil
import websockets

import game_core.moves as M
import game_core.protocol as P


class StageStats:
    def __init__(self) -> None:
        self.lat: list = []

    def p(self, q: float):
        if not self.lat:
            return 0.0
        qs = statistics.quantiles(sorted(self.lat), n=100)
        idx = min(99, int(q) - 1)
        return qs[idx] if qs else (self.lat[0] * 1000.0)


async def player(uri: str, name: str, seconds: float, stats: StageStats) -> None:
    rng = random.Random(name)
    try:
        async with websockets.connect(uri, max_size=2 ** 16) as ws:
            await ws.send(P.pack_join(0, name))
            (self_id, tick, blob, color, sx, sy, sroom, syaw, got) = P.unpack_welcome(
                await ws.recv())
            end = time.time() + seconds
            pending: dict = {}
            dx = dy = 0
            seq = 0
            while time.time() < end:
                if rng.random() < 0.35:
                    dx = rng.choice((-1, 0, 1))
                    dy = rng.choice((-1, 0, 1))
                seq += 1
                t0 = time.perf_counter()
                pending[seq] = t0
                await ws.send(P.pack_input(seq, dx, dy, rng.randrange(2048)))
                deadline = time.perf_counter() + 0.05
                while time.perf_counter() < deadline:
                    try:
                        m = await asyncio.wait_for(
                            ws.recv(), timeout=deadline - time.perf_counter())
                    except asyncio.TimeoutError:
                        break
                    except websockets.ConnectionClosed:
                        return
                    if m[0] != P.MSG_STATE and m[0] != P.MSG_RESYNC:
                        continue
                    _kind, t2, ack, _conn, _ops = P.unpack_state(m)
                    for s in list(pending):
                        if s <= ack:
                            stats.lat.append((time.perf_counter() - pending.pop(s)) * 1000.0)
    except Exception:
        return


def _proc_cpu_rss():
    p = psutil.Process(1)
    with p.oneshot():
        return p.cpu_percent(None), p.memory_info().rss / (1024 * 1024)


def _healthz():
    with urllib.request.urlopen("http://127.0.0.1:8000/healthz", timeout=5) as r:
        return __import__("json").loads(r.read())


async def stage(uri: str, n: int, seconds: float) -> dict:
    _cpu, _rss = _proc_cpu_rss()  # prime the interval counter
    h0 = _healthz()
    stats = StageStats()
    t0 = time.time()
    await asyncio.gather(*(
        player(uri, "c%05d" % i, seconds - 0.5, stats) for i in range(n)))
    elapsed = time.time() - t0
    h1 = _healthz()
    dt = max(1e-6, h1["uptime_s"] - h0["uptime_s"])
    egress = max(0, h1["bytes_out"] - h0["bytes_out"]) / dt / 1e6
    cpu, rss = _proc_cpu_rss()
    return {
        "clients": n,
        "p50_ms": round(stats.p(50), 1),
        "p99_ms": round(stats.p(99), 1),
        "n_samples": len(stats.lat),
        "cpu_pct": round(cpu / 100.0, 1),  # psutil returns core-fraction
        "rss_mb": round(rss, 1),
        "egress_mbs": round(egress, 2),
        "tick_rate": h1["tick"] / max(1e-6, dt),
    }


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=10000)
    ap.add_argument("--step", type=int, default=1000)
    ap.add_argument("--stage-sec", type=float, default=30.0)
    ap.add_argument("--host", default="ws://127.0.0.1:8000/ws")
    ap.add_argument("--report", default=None)
    a = ap.parse_args()

    rows = []
    n = a.step
    while n <= a.max:
        row = await stage(a.host, n, a.stage_sec)
        rows.append(row)
        print(row)
        if row["p99_ms"] > 1000:
            print("stopping early: p99 too high")
            break
        n += a.step
    report = ["| clients | p50 ms | p99 ms | samples | cpu % | rss MB | egress MB/s | tick/s |",
              "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        report.append("| %d | %s | %s | %d | %s | %s | %s | %.1f |" % (
            r["clients"], r["p50_ms"], r["p99_ms"], r["n_samples"],
            r["cpu_pct"], r["rss_mb"], r["egress_mbs"], r["tick_rate"]))
    text = "\n".join(report) + "\n"
    print(text)
    if a.report:
        import pathlib
        pathlib.Path(a.report).write_text(
            "# MUD load test report\n\n" + text +
            "\nMeasured in single-process server container.\n")


if __name__ == "__main__":
    asyncio.run(main())
