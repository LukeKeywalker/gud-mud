# MUD — AWS Deployment Design (mud.michniewicz.contact)

Date: 2026-09-18
Status: approved in chat (user said "Looks good, make it so!") on 2026-09-18
Base commit for this work: `d23b954b` (worktree `.worktrees/deploy-aws`, branch `deploy-aws`)

## Purpose

Deploy the Eye-of-the-Beholder MUD (server + client, currently run via
`docker-compose.yml` locally) to AWS so the game is publicly reachable at

```
https://mud.michniewicz.contact/
```

A new `deployment/` module contains Python CDK code that owns the whole
deployment; deploying is a single invocation run from this repo.

The original request targeted `https://michniewicz.contact/demo/mud`; the
approved design moves the game to the dedicated subdomain
`mud.michniewicz.contact`. The existing apex site (hand-managed CloudFront
distribution `E2NKRDY8YYEIIU` → S3 website + API Gateway) is **not touched
at all** — no new distribution at the apex, no DNS A-record change at the
apex, no behavior edits on the existing distribution.

## Environment facts (verified, 2026-09-18)

- The shell's AWS account has a Route53 hosted zone
  `Z08775041GRCKGXJFLFZW` (`michniewicz.contact.`), default region
  `eu-north-1` (AWS CLI config).
- Apex + `lukasz.` subdomains are ALIAS records to
  `d1unabms3uygb9.cloudfront.net` (pre-existing distribution; out of scope).
- Repo had no git remote; user stated the deploy source is
  `https://github.com/LukeKeywalker/gud-mud.git` (assumed **public** — a
  private repo would require a deploy key on the instance).
- Local tooling: Docker 27.4 (not needed at deploy time — the instance
  builds the image), CDK CLI 2.1033.0, Python 3.11.11.
- Game constraints that shape the design:
  - `server/src/mud_server/app.py` is a single **stateful** process (20 Hz
    tick loop, in-memory world, WebSocket handler at `/ws`, serves the
    static client at `/`, `GET /healthz` endpoint).
  - Postgres schema is self-created by
    `PostgresStore.ensure_schema()` (`server/src/mud_server/persistence.py`)
    — no init-SQL bootstrap step needed.
  - Client connects to `(https→wss|http→ws) + location.host + "/ws"`
    (`client/static/app.js`); service worker registered relatively as
    `sw.js`. => serving the app at the **root** of a subdomain works with
    **zero game-code changes**.
  - `docker-compose.yml` maps server to host `18000:8000` and db to
    `5433:5432`; env is configured inside the compose file (DSN
    `postgresql://mud:mud@db:5432/mud`).

## Approved choices (consulted)

| Decision | Choice | Note |
|---|---|---|
| Edge for the game | New subdomain, no CloudFront | ALB does TLS + websockets directly |
| Existing dist | Do not modify | Only new subdomain record is added |
| Compute | EC2 all-in-one (no RDS) | `docker-compose.yml` runs as-is; world/player data is disposable (lives on instance EBS). Cheapest option, accepted |
| Code delivery to EC2 | `git clone` from GitHub at a pinned SHA | Repo pushed to `github.com/LukeKeywalker/gud-mud.git` before the instance boots |
| Post-verify integration | Merge `deploy-aws` → `main` + push, then remove worktree | Only after live verification passes |

## Architecture

```
                        Internet
                          |   :443 (TLS) / :80 (301→443), WS upgrade
                        ALB (internet-facing, eu-north-1, 2 public subnets)
                          |   target group: instance host port 18000,
                          |   health check GET /healthz
                        EC2 t4g.micro (Ubuntu 24.04, SSM, public IPv4,
                                      10 GB gp3 root, no SSH ingress)
                          |   docker compose (restart: unless-stopped)
                            ├─ mud-server   uvicorn :8000  (WS /ws, static /, /healthz)
                            └─ postgres:16  :5432 (named volume `pgdata`, disposable)
```

- **ALB** `mud-alb`: listener 443 (SSL, cert `mud.michniewicz.contact`) →
  target group (HTTP, port **18000**, health check: path `/healthz`,
  matcher 200, interval 15 s, healthy threshold 2, unhealthy threshold
  3); listener 80 → 301 https. ALB natively supports WebSocket upgrade on
  HTTP targets.
- **ACM certificate** for `mud.michniewicz.contact`, DNS-validated against
  the in-account hosted zone.
- **Route53** alias records A + AAAA `mud.michniewicz.contact` → ALB.
- **VPC**: small CDK `Vpc(max_azs=2, nat_gateways=0)`; instance and ALB in
  the two public subnets (outbound internet via IGW — needed for apt/docker
  pulls; no NAT required, no cost for NAT gateway).
- **Security groups**:
  - ALB SG: TCP 80, 443 from 0.0.0.0/0.
  - Instance SG: TCP 18000 from the ALB SG only. No SSH; operations go
    through SSM Session Manager / `aws ssm send-command`.
- **Instance role**: minimal role with the managed policy
  `AmazonSSMManagedInstanceCore` (SSM Session Manager / `send-command` is
  the only ops path — no SSH ingress). No other IAM.
- **Sizing**: `t4g.micro` (Graviton2, 1 GB RAM) runs the two containers
  comfortably for a demo player count; fall back to `t3.micro` if
  availability is an issue in `eu-north-1`.

## Code delivery and lifecycle on the instance

- **First boot** (user-data, ≤ 16 KB, rendered by CDK):
  1. `apt-get` install `docker.io` + `docker-compose-v2`.
  2. `git clone https://github.com/LukeKeywalker/gud-mud.git /opt/mud`.
  3. `git checkout <PINNED_SHA>` (the exact commit of this repo at CDK
     synth time; `app.py` resolves it with `git rev-parse HEAD` and renders
     it into user-data — matching "use the latest commit, not the
     uncommitted working copy").
  4. `docker compose -f docker-compose.yml -f deployment/compose.ec2.yml
     up -d --build`.
- **`deployment/compose.ec2.yml`** (new file, repo-controlled override):
  adds `restart: unless-stopped` to `db` and `server`, and empties the
  `db` host `ports` (the `5433:5432` local mapping is never needed on the
  instance; the server reaches postgres via the compose network). The
  `server` `18000:8000` mapping is required for the ALB target.
  `restart: unless-stopped` also makes containers come back automatically
  on daemon start after an instance reboot — no per-boot user-data
  re-run needed (EC2 user-data only runs on first launch).
- **Update/rollback** (run via SSM from any machine):
  `bash /opt/mud/deployment/scripts/update.sh [SHA]` — fetches, checks out
  SHA (no argument = HEAD of the remote's default branch), rebuilds,
  `up -d`; re-running with an older SHA rolls back. Container recreation
  briefly drops live WebSocket connections — acceptable for a demo.

## `deployment/` module layout

```
deployment/
  app.py                  # CDK App + MudDemoStack (eu-north-1); pins git HEAD sha
  requirements.txt        # aws-cdk-lib, constructs
  CDK.toml                # app="python3 deployment/app.py"
  compose.ec2.yml         # restart-policy DB override for the EC2 run
  scripts/
    user-data.sh          # template rendered into EC2 UserData by CDK
    update.sh             # SSM update/rollback script (lands on the instance)
    ws_smoke.py           # small client: joins over wss, expects state frames (~15 s)
  README.md               # first-time bootstrap, deploy, update, ops, cost, rollback
```

- No changes to `server/`, `client/`, `shared/` — the subdomain serves the
  app at root, so `location.host + "/ws"`, the root `StaticFiles` mount and
  the relative `sw.js` scope all work unchanged.
- Root `Makefile`: add `deploy` target (creates `deployment/.venv` if
  absent, then `cdk deploy "MudDemo" --app "python3 deployment/app.py"
  --require-approval never`), plus optional `update` target for SSM update
  with a SHA.
- Root `.gitignore` already receives (on main, chore commit):
  `.worktrees/`, `.cdk.staging/`, `cdk.out/`.

## Data flow

1. Browser fetches `https://mud.michniewicz.contact/` → ALB 443 → EC2
   18000 → uvicorn static client (index references same-origin
   `app.js`/`styles.css`/`sw.js` + same-origin `game_core/` Python modules
   executed by Pyodide, unchanged from local dev).
2. Browser opens `wss://mud.michniewicz.contact/ws` → ALB WebSocket
   upgrade → uvicorn `ws_handler` → 20 Hz tick game loop → binary state
   frames; world/player state persisted to the local postgres named
   volume; disposable by design.
3. Health: ALB probes `GET http://<ec2>:18000/healthz` (returns uptime,
   tick, connected counts).

## Deployment procedure (operator steps)

1. One time: `cdk bootstrap aws://<ACCOUNT>/eu-north-1` (root AWS user;
   current shell credentials).
2. From the worktree: `make deploy`.
   - CDK synth resolves `git rev-parse HEAD` (worktree) → the user-data
     pins that SHA.
3. Push the exact branch/SHA: add remote `github.com/LukeKeywalker/gud-mud`,
   push `deploy-aws` (and after verification, `main`) **before** the
   instance finishes bootstrapping (instance starts immediately on
   deploy).
4. Wait (~5–10 min: AMI boot, apt, clone, build).

S3/asset note: no cloud assets required — user-data is small text inlined
by CDK; code comes from GitHub.

## Verification plan

Pre-deploy (local):

- `cdk synth` and `cdk diff` succeed (template sanity, IAM/policy lint by
  review of the synthesized template).
- `make test` (server suite) still green — no game code changes expected.
- `bash -n deployment/scripts/user-data.sh` (shell lint) and `python3 -m
  py_compile deployment/app.py`.

Post-deploy (live):

1. SSM: instance running, both containers up (`docker compose ps`),
   `curl -s http://127.0.0.1:18000/healthz` from the instance.
2. `curl -s https://mud.michniewicz.contact/healthz` → JSON with
   `uptime_s/tick/connected`.
3. `curl -sI https://mud.michniewicz.contact/` → 200 `text/html`;
   `curl -sI https://mud.michniewicz.contact/app.js` → 200;
   `curl -sI https://mud.michniewicz.contact/sw.js` → 200.
4. WebSocket game smoke: `deployment/scripts/ws_smoke.py
   wss://mud.michniewicz.contact` — join → welcome → receive state frames
   for ~15 s → clean close (reuses `shared/game_core` protocol packing).
5. Regression guard: `curl -sI https://michniewicz.contact/` → still 200
   (must be structurally true — no shared resources — but checked anyway).

Go/no-go: all of the above pass before the merge step.

## Rollback

- **Game only**: `cdk destroy MudDemo` (removes ALB, instance, VPC, ACM
  certificate, and the `mud.` records) — apex site unaffected by
  construction.
- **Code only**: `update.sh <previous-sha>` via SSM.
- **DNS-only emerg**: delete the `mud.` alias record → subdomain NXDOMAIN,
  nothing else changes.

## Cost estimate (eu-north-1, on-demand)

| Item | Est. |
|---|---|
| EC2 t4g.micro | ~$8–10/mo (75 h free-tier may cover) |
| EBS 10 GB gp3 | ~$1.15/mo |
| ALB (LB-hour + ~1 LCU) | ~$17/mo |
| ACM, Route53, SSM, data out (game is small) | ~$0–2/mo |
| **Total** | **≈ $25–30/mo** |

## Risks / mitigations

- GitHub repo private or SHA missing when instance clones → clone fails,
  container never starts. Mitigation: push before deploy; SSM logs user-data
  on failure; redeploy (or SSM re-run of the bootstrap snippet) after push.
- `t4g.micro` RAM spikes during docker build → build OOM. Mitigation:
  compose build is a Python `pip install` image (~small); fallback
  `t4g.small`/`t3.small`.
- `docker-compose-v2` package name varies by Ubuntu release → pin ubuntu
  24.04 LTS AMI in user-data retrieval; if the apt package is absent, fall
  back to the `get.docker.com` installer (noted in README troubleshooting).
- Disposable DB: a redeploy/instance-replacement wipes world/player data.
  Accepted in trade-off analysis.
- `main` moves while deploying (active development) → the pinned SHA
  records exactly what went out; the push + merge ordering means the live
  SHA is always a real pushed commit.

## Explicit non-goals

- No scaling beyond a single instance; no CI/CD pipeline; no monitoring
beyond ALB target-group health + CloudWatch basics; no autoscaling, no
backups, no multi-AZ, no CloudFront, no S3, no RDS, no secrets manager,
no game-code changes.
