Hardware: arm64, Darwin 25.5.0 (kernel 25.5.0, xnu-12377.121.6~2/RELEASE_ARM64_T6041)
Date: Fri Sep 18 06:04:42 CEST 2026

# MUD load test report

| clients | p50 ms | p99 ms | samples | cpu % | rss MB | egress MB/s | tick/s |
|---|---|---|---|---|---|---|---|
| 1000 | 208.9 | 266.0 | 18075 | 0.0 | 146.3 | 1.07 | 69.8 |
| 2000 | 0.0 | 0.0 | 0 | 0.0 | 234.1 | 0.3 | 51.6 |
| 3000 | 6452.0 | 24706.1 | 180889 | 0.0 | 310.7 | 1.01 | 33.5 |

Measured in single-process server container.

## Verdict

Measured single-process ceiling on this VM-class node: with zero clients the
sustained tick rate was 19.13 Hz (own probe: 287 ticks / 15 s; 16.80 Hz after
the ramp). Under the 1000-client stage the tick rate fell to 13.0 Hz then
9.0 Hz (external healthz tick deltas), with input-ACK p50 208.9 ms / p99
266.0 ms in that row. At 2000 clients the harness recorded 0 ACK samples —
every input went unacknowledged — and the server failed to answer /healthz
during that and the 3000 stage (event-loop saturation; one sampled delta was
3.4 Hz). The harness stopped at 3000 by its own p99 > 1000 ms rule
(p50 6.45 s / p99 24.7 s), so 2000+ was not viable to claim. Honest ceiling:
~1000 simultaneous clients with a degraded-but-functional tick and
centisecond-scale p99; the true cutoff lies between 1000 and 3000, and the
2000 stage was functionally dead (the early-stop rule only fires on a
nonzero p99, which an empty sample cannot produce).

Dominant cost (per Task 9 analysis): `_delta_ops` runs per client per tick
(`server/src/mud_server/game_loop.py:139-161`) and calls
`V.visible_entities`, a GLOBAL scan of `world.entity_order` (O(N·E)) that
sorts every visible entity with a per-target BFS room-distance key, applying
`MAX_VISIBLE` only after the sort — ~O(N²) tick work
(`shared/game_core/visibility.py:7-36`). Compounding: one shared 32-deep
queue per client for both input and send frames (`connections.py:18`),
`_pump` sleeping a full tick per input frame, drop-oldest at both enqueue
points, and a 2 s congestion kick (`game_loop.py:163-207`,
`server/src/mud_server/app.py:84-85`). All synthetic players spawn in room A,
maximizing per-frame ops.

Sharding call: **not yet.** The measured ceiling (~1000 concurrent, degraded
tick) meets the browser-demo reference scale but is far short of the plan's
10k theoretical target. Trigger condition: revisit at N > 1000 as a product
target — then first scale the per-tick math (per-room entity index to kill
the global scan, precomputed room-distance table to kill the BFS-in-sort,
apply MAX_VISIBLE before the expensive sort, separate input vs send queues),
and only after that consider world sharding, which the schema already
supports (`world_id`, one container per world).

Measurement caveats: the `tick/s` column is the harness's absolute-counter
formula (t/dt drift — ignore; use healthz `(h1-h0).tick/dt` deltas quoted
above). The `cpu%` column printed 0.0 (core-fraction/100, unreliable on this
VM) and `egress` is the engine enqueue counter, a slight overstatement under
drop-backpressure.
