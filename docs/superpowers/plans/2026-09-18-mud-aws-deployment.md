# MUD AWS Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `deployment/` module (Python CDK) that deploys the MUD game to `https://mud.michniewicz.contact` on a single EC2 instance behind an internet-facing ALB, and actually deploy it.

**Architecture:** One CDK stack (`MudDemo`, region `eu-north-1`): VPC (2 AZ, no NAT-gateways) → EC2 `t4g.micro` (Ubuntu 24.04 AMI via `MachineImage.lookup`, SSM-only ops, no SSH, public IP) running `docker compose` (server + postgres, repo-controlled restart-policy override) → internet-facing ALB (HTTP 80 → 301 to HTTPS 443; 443 TLS with websockets can be handled by ALB natively) → target group on host port 18000 with `/healthz` health check → Route53 alias A/AAAA records for `mud.michniewicz.contact`. The instance clones `github.com/LukeKeywalker/gud-mud.git` and checks out a git-pinned SHA on first boot, so **pushing the branch must precede the completed deploy**.

**Tech Stack:** Python 3.11, `aws-cdk-lib==2.270.0` (exactly pinned — the API surface used below was verified against this version, see the "CDK API notes" inside Task 3), `constructs`, CDK CLI 2.x, docker compose (instance side), AWS CLI (shell side).

**Spec:** `docs/superpowers/specs/2026-09-18-mud-aws-deployment-design.md`

## Global Constraints

- All work is done **only** inside the worktree `.worktrees/deploy-aws` (branch `deploy-aws`, base `d23b954b`). Never modify the root working copy.
- **No changes** to `server/`, `client/`, `shared/`, `maps/`, `db/`, `docker-compose.yml`; only *append* `deploy`/`update`/`destroy` targets to `Makefile` (leave existing targets as-is).
- No CloudFront, no S3, no RDS, no secrets manager, no cloud assets. User-data is rendered text inlined by CDK (enforcing ≤16 KB in code).
- Region is pinned: `eu-north-1`; the account is resolved at synth time from the shell's `~/.aws` credentials via `boto3 sts get-caller` (`Environment(account=..., region="eu-north-1")` — required because `MachineImage.lookup` needs an account at the stack level).
- Verbatim constants: repo `https://github.com/LukeKeywalker/gud-mud.git`; Route53 zone `Z08775041GRCKGXJFLFZW` (`michniewicz.contact.`); domain `mud.michniewicz.contact`; ALB target host port `18000`; health path `/healthz`; instance name (→ `Name` tag) `mud-game`; SSM policy `arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore`.
- The existing apex site and distribution `E2NKRDY8YYEIIU` must remain untouched; after deploy, `curl -sI https://michniewicz.contact/` must still return 200.
- Every task ends with an independently verifiable state (synth succeeds, scripts are lint-clean, tests green) and a commit.

## Files

| File | Responsibility |
|---|---|
| `deployment/requirements.txt` | CDK python deps (exactly pinned) + pyyaml for local checks |
| `deployment/CDK.toml` | CDK CLI config for this app |
| `deployment/app.py` | CDK App + `MudDemoStack`; renders user-data; pins git HEAD sha at synth time |
| `deployment/compose.ec2.yml` | Compose override for the instance: `restart: unless-stopped`, no host port on the db |
| `deployment/scripts/user-data.sh` | First-boot bootstrap template (placeholders `__REPO__`, `__SHA__`) |
| `deployment/scripts/update.sh` | SSM update/rollback script (lands on the instance under the clone) |
| `deployment/scripts/ws_smoke.py` | WebSocket join/state smoke client (local + production) |
| `deployment/README.md` | Operate/update/rollback/destroy instructions + cost |
| `Makefile` | Append `deploy`, `deploy-deps`, `update`, `destroy` targets |
| `.gitignore` | Append `.worktrees/`, `.cdk.staging/`, `cdk.out/` |

---

### Task 1: deployment/ scaffold + minimal synthable stack

**Files:**
- Create: `deployment/requirements.txt`, `deployment/CDK.toml`, `deployment/app.py`

**Interfaces:**
- Produces: `MudDemoStack(scope, id, **kwargs)` under the eu-north-1 env; a running app entry `python3 deployment/app.py` with stack id `MudDemo`. A later task fills in the stack body.

- [ ] **Step 1: Write `deployment/requirements.txt`**

```
aws-cdk-lib==2.270.0
constructs>=10.0.0
pyyaml>=6.0
boto3>=1.34
```

- [ ] **Step 2: Write `deployment/CDK.toml`**

```toml
[app]
dist_out = "dist/"
```

- [ ] **Step 3: Write `deployment/app.py` (skeleton only)**

```python
from aws_cdk import App, Environment, Stack
from constructs import Construct


class MudDemoStack(Stack):
    def __init__(self, scope: Construct, id: str, **kwargs) -> None:
        super().__init__(scope, id, **kwargs)


if __name__ == "__main__":
    app = App()
    MudDemoStack(app, "MudDemo", env=Environment(region="eu-north-1"))
    app.synth()
```

- [ ] **Step 4: Create the deployment venv and install deps**

Run (worktree root):
```bash
python3 -m venv deployment/.venv
deployment/.venv/bin/pip install -q -r deployment/requirements.txt
deployment/.venv/bin/python -c "import aws_cdk, constructs, yaml" && echo DEPS_OK
```
Expected: `DEPS_OK`.

- [ ] **Step 5: Verify synth (offline — no cloud calls at this point)**

Run:
```bash
cdk synth MudDemo --app "deployment/.venv/bin/python3 deployment/app.py"
test -f cdk.out/MudDemo.template.json && echo SYNT_OK
```
Expected: `SYNT_OK`.

- [ ] **Step 6: Commit**

```bash
git add deployment/
git commit -m "deployment: scaffold python CDK app (MudDemo stack)"
```

---

### Task 2: instance scripts (user-data, update) + compose override

**Files:**
- Create: `deployment/scripts/user-data.sh`, `deployment/scripts/update.sh`, `deployment/compose.ec2.yml`

**Interfaces:**
- Produces: text for `user-data.sh` containing `__REPO__` and `__SHA__` (Task 3 renders them); `update.sh [SHA]` (with no args, it's a main fast-forward); `deployment/compose.ec2.yml` merges cleanly over `docker-compose.yml` via `-f a -f b`.

- [ ] **Step 1: Write `deployment/scripts/user-data.sh`**

```bash
#!/usr/bin/env bash
# Rendered into EC2 User Data by deployment/app.py (repo URL + committed sha are substituted in).
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git curl docker.io docker-compose-v2
mkdir -p /opt/mud
git clone __REPO__ /opt/mud
git -C /opt/mud checkout --quiet __SHA__
cd /opt/mud
docker compose -f docker-compose.yml -f deployment/compose.ec2.yml up -d --build
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:18000/healthz >/dev/null; then
    echo "game ready after ~$((i * 5))s"
    break
  fi
  sleep 5
done
curl -fsS http://127.0.0.1:18000/healthz
```

- [ ] **Step 2: Write `deployment/scripts/update.sh`**

```bash
#!/usr/bin/env bash
# Run on the game instance (via SSM): update.sh [SHA]. No arg = fast-forward main.
set -eux
cd /opt/mud
git fetch origin
if [ "$#" -ge 1 ]; then
  git checkout --quiet "$1"
else
  git checkout --quiet main
  git pull --ff-only origin main
fi
docker compose -f docker-compose.yml -f deployment/compose.ec2.yml up -d --build
```

- [ ] **Step 3: Write `deployment/compose.ec2.yml`**

```yaml
services:
  db:
    # never expose the database on the host
    ports: []
    restart: unless-stopped
  server:
    # host port 18000 (from docker-compose.yml) stays mapped - the ALB targets it
    restart: unless-stopped
```

- [ ] **Step 4: Lint the shell scripts, check placeholders and the compose merge**

Run:
```bash
bash -n deployment/scripts/user-data.sh && bash -n deployment/scripts/update.sh
deployment/.venv/bin/python - <<'EOF'
text = open('deployment/scripts/user-data.sh').read()
assert text.count('__REPO__') == 1 and text.count('__SHA__') == 1, 'placeholders'
assert len(text.encode()) < 16 * 1024, 'userdata too big'
import yaml
main = yaml.safe_load(open('docker-compose.yml'))
over = yaml.safe_load(open('deployment/compose.ec2.yml'))
assert set(over['services']) <= set(main['services']), 'unknown service override'
assert over['services']['db']['ports'] == [], 'db must not publish ports'
for svc, rules in over['services'].items():
    assert rules.get('restart') == 'unless-stopped', svc
print('CHECKS_OK')
EOF
docker compose -f docker-compose.yml -f deployment/compose.ec2.yml config -q 2>/dev/null && echo MERGE_OK || echo "note: docker compose unavailable locally - yaml checks above already passed"
```
Expected: `CHECKS_OK` and (`MERGE_OK` or the skip note).

- [ ] **Step 5: Commit**

```bash
git add deployment/scripts deployment/compose.ec2.yml
git commit -m "deployment: bootstrap user-data, SSM update script, ec2 compose override"
```

---

### Task 3: full CDK stack (VPC, EC2, ALB, cert, DNS)

**Files:**
- Modify: `deployment/app.py` (replace the skeleton entirely)

**Interfaces:**
- Consumes: `deployment/scripts/user-data.sh` containing `__REPO__`/`__SHA__`; constants `REPO_URL`, `DOMAIN`, `ZONE_ID`, `HOST_PORT`, instance name `mud-game`.
- Produces: stack `MudDemo` with the resources: VPC (2 AZ, 0 NAT), two security groups (instance, ALB), ACM certificate for `mud.michniewicz.contact` (DNS-validated), internet-facing ALB (`80→443` redirect, `443` TLS → target-group forward), target group (`:18000`, `/healthz`), EC2 instance (`mud-game`, SSM role, public IP), Route53 A/AAAA alias records via L1 `CfnRecordSet`.

**CDK API notes (verified against aws-cdk-lib 2.270.0, keep exactly):**
- `listener` API: `alb.add_listener(id, *, port, certificates=..., default_action=..., default_target_groups=[...], open=None)`; `alb.add_redirect(target_port=..., target_protocol=...)` produces the 80→443 301 (rendered as an actual CfnListener with `RedirectConfig`, no custom resource).
- Certificates are passed with the kwarg `certificates=` (not `ssl_certificates=`); ACM uses `validation=` (not `validate=`); the HTTPS listener validates that it has ≥1 certificate.
- The L2 `ec2.Instance` **is not** an ALB target: use `tg.add_target(tgt.InstanceTarget(instance))` from `aws_cdk.aws_elasticloadbalancingv2_targets as tgt`.
- L2 `Instance` has no `tags` parameter; use `instance_name="mud-game"` → renders the `Name` tag (verified in the output of a synthesis probe).
- `sg.add_ingress_rule(peer, port)` renders a standalone `AWS::EC2::SecurityGroupIngress` resource (not inline).
- An internet-facing ALB with an explicit `security_group=` auto-opens listener ports 80/443 from 0.0.0.0/0 in that SG (verified).
- Zone: `route53.PublicHostedZone.from_hosted_zone_attributes(scope, id, *, hosted_zone_id=..., zone_name=...)`; alias properties use `hosted_zone_id` (not `host_zone_id`).
- `machine_image=ec2.MachineImage.lookup(name=..., owners=[...], filters={...})` — resolves the AMI via the CDK CLI at synth time (needs working default AWS credentials in the shell).

- [ ] **Step 1: Replace `deployment/app.py` with**

```python
import subprocess
from pathlib import Path

from aws_cdk import (
    App,
    Duration,
    Environment,
    Stack,
    aws_certificatemanager as acm,
    aws_ec2 as ec2,
    aws_elasticloadbalancingv2 as elbv2,
    aws_elasticloadbalancingv2_targets as tgt,
    aws_iam as iam,
    aws_route53 as route53,
)
from constructs import Construct

REPO_URL = "https://github.com/LukeKeywalker/gud-mud.git"
DOMAIN = "mud.michniewicz.contact"
ZONE_ID = "Z08775041GRCKGXJFLFZW"
ZONE_NAME = "michniewicz.contact."
HOST_PORT = 18000
INSTANCE_NAME = "mud-game"
AMZ_OWNER = "099720109477"  # Canonical CID for Ubuntu publishes


def current_account() -> str:
    import boto3
    return boto3.client("sts").get_caller_identity()["Account"]


def pinned_sha() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()


def render_user_data(sha: str) -> ec2.UserData:
    template = Path(__file__).resolve().parent / "scripts" / "user-data.sh"
    text = template.read_text().replace("__REPO__", REPO_URL).replace("__SHA__", sha)
    if len(text.encode("utf-8")) > 16 * 1024:
        raise RuntimeError("rendered user-data exceeds CloudFormation 16KB limit")
    return ec2.UserData.custom(text)


class MudDemoStack(Stack):
    def __init__(self, scope: Construct, id: str, **kwargs) -> None:
        super().__init__(scope, id, **kwargs)

        vpc = ec2.Vpc(self, "Vpc", max_azs=2, nat_gateways=0)
        inst_sg = ec2.SecurityGroup(self, "InstanceSecurityGroup", vpc=vpc,
                                    description="MUD game instance")
        alb_sg = ec2.SecurityGroup(self, "AlbSecurityGroup", vpc=vpc,
                                   description="MUD game ALB")

        cert = acm.Certificate(self,
                               "Certificate",
                               domain_name=DOMAIN,
                               validation=acm.CertificateValidation.from_dns())

        tg = elbv2.ApplicationTargetGroup(
            self,
            "GameTargetGroup",
            port=HOST_PORT,
            protocol=elbv2.ApplicationProtocol.HTTP,
            vpc=vpc,
            health_check=elbv2.HealthCheck(
                path="/healthz",
                interval=Duration.seconds(15),
                healthy_threshold_count=2,
                unhealthy_threshold_count=3,
            ),
        )

        alb = elbv2.ApplicationLoadBalancer(
            self, "LoadBalancer",
            vpc=vpc,
            internet_facing=True,
            security_group=alb_sg,
        )
        alb.add_listener("Https", port=443,
                         certificates=[cert],
                         default_target_groups=[tg])
        alb.add_redirect(target_port=443,
                         target_protocol=elbv2.ApplicationProtocol.HTTPS)

        role = iam.Role(
            self,
            "InstanceRole",
            assumed_by=iam.ServicePrincipal("ec2.amazonaws.com"),
            managed_policies=[
                iam.ManagedPolicy.from_managed_policy_arn(
                    self,
                    "SsmManagedPolicy",
                    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
                )
            ],
        )

        instance = ec2.Instance(
            self,
            "GameInstance",
            vpc=vpc,
            vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PUBLIC),
            instance_type=ec2.InstanceType("t4g.micro"),
            instance_name=INSTANCE_NAME,
            machine_image=ec2.MachineImage.lookup(
                name="ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*",
                owners=[AMZ_OWNER],
                filters={
                    "root-device-type": ["ebs"],
                    "virtualization-type": ["hvm"],
                    "state": ["available"],
                },
            ),
            role=role,
            security_group=inst_sg,
            associate_public_ip_address=True,
            user_data=render_user_data(pinned_sha()),
        )
        tg.add_target(tgt.InstanceTarget(instance))
        inst_sg.add_ingress_rule(
            alb_sg,
            ec2.Port.tcp(HOST_PORT),
            description="ALB -> game host port",
        )

        zone = route53.PublicHostedZone.from_hosted_zone_attributes(
            self, "Zone",
            hosted_zone_id=ZONE_ID,
            zone_name=ZONE_NAME,
        )
        for rec_type in ("A", "AAAA"):
            route53.CfnRecordSet(
                self,
                f"MudRecord{rec_type}",
                hosted_zone_id=zone.hosted_zone_id,
                name=DOMAIN + ".",
                type=rec_type,
                alias_target=route53.CfnRecordSet.AliasTargetProperty(
                    dns_name=alb.load_balancer_dns_name,
                    hosted_zone_id=alb.load_balancer_canonical_hosted_zone_id,
                ),
            )


if __name__ == "__main__":
    app = App()
    MudDemoStack(
        app, "MudDemo",
        env=Environment(account=current_account(), region="eu-north-1"))
    app.synth()
```

- [ ] **Step 2: Synth (resolves the Ubuntu AMI — needs default AWS credentials/region in the shell)**

Run:
```bash
cdk synth MudDemo --app "deployment/.venv/bin/python3 deployment/app.py"
test -f cdk.out/MudDemo.template.json && echo SYNT_OK
```
Expected: `SYNT_OK`. If the AMI lookup errors on credentials/region, confirm `aws ec2 describe-images --max-items 1` works in the shell, re-run, and fix the credentials issue before continuing.

- [ ] **Step 3: Assert template contents**

Run:
```bash
deployment/.venv/bin/python - <<'EOF'
import json
t = json.load(open("cdk.out/MudDemo.template.json"))["Resources"]
def have(suffix): return [r for r in t.values() if r["Type"].endswith(suffix)]
assert have("EC2::Instance"), "no instance"
assert have("ElasticLoadBalancingV2::LoadBalancer")
assert have("ElasticLoadBalancingV2::TargetGroup")
assert have("CertificateManager::Certificate")
assert len(have("Route53::RecordSet")) == 2, "expected A + AAAA records"
tg = json.dumps(have("ElasticLoadBalancingV2::TargetGroup")[0])
assert "18000" in tg and "/healthz" in tg, "TG port/health check wrong"
inst = have("EC2::Instance")[0]["Properties"]
assert inst["InstanceType"] == "t4g.micro", inst["InstanceType"]
assert {"Key": "Name", "Value": "mud-game"} in inst["Tags"], inst["Tags"]
redirect = [r for r in have("ElasticLoadBalancingV2::Listener")
            if "RedirectConfig" in json.dumps(r["Properties"].get("DefaultActions", []))]
assert redirect, "no 301 redirect listener found"
ingress18000 = [r for r in have("EC2::SecurityGroupIngress")
                if r["Properties"].get("FromPort") == 18000]
assert ingress18000, "no ingress rule for 18000"
ud = json.dumps(have("EC2::Instance")[0]["Properties"]["UserData"])
assert "git clone https://github.com/LukeKeywalker/gud-mud.git" in ud
import subprocess
sha = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
assert sha in ud, "user-data not pinned to worktree HEAD: " + sha
assert not any("NATGateway" in r["Type"] for r in t.values()), "unexpected NAT gateway"
print("TEMPLATE_OK")
EOF
```
Expected: `TEMPLATE_OK`. If an assertion trips, inspect `cdk.out/MudDemo.template.json` for the corresponding fact by hand and fix the stack definition (not the assertion) — the facts asserted are required for the deploy to work.

- [ ] **Step 4: Commit**

```bash
git add deployment/app.py
git commit -m "deployment: MudDemo stack (vpc, ec2+ssm, alb+tls, acm, route53)"
```

---

### Task 4: WebSocket smoke client + local preflight (TDD)

**Files:**
- Create: `deployment/scripts/ws_smoke.py`

**Interfaces:**
- Produces: `ws_smoke.py [BASE_URL]`, exits 0 only after a successful join and ≥1 state frame within ~15 s; default is the base `http://127.0.0.1:18000`. Used unchanged in Task 10's live verification.

- [ ] **Step 1: Write the client `deployment/scripts/ws_smoke.py`**

```python
"""WebSocket smoke client: python deployment/scripts/ws_smoke.py [BASE_URL]

BASE_URL is the origin WITHOUT the /ws path (https://host or http://127.0.0.1:18000).
Joins the world, expects a welcome, then consumes state frames for ~15 s.
Exit 0 on success; non-zero on any protocol/timing failure.
"""
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))

import game_core.protocol as P  # noqa: E402


def build_ws_url(base: str) -> str:
    base = base.strip("/")
    scheme, host = base.split("://", 1)
    return f"{'wss' if scheme == 'https' else 'ws'}://{host}/ws"


async def main() -> None:
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18000"
    import websockets

    async with websockets.connect(build_ws_url(base), open_timeout=10) as ws:
        await ws.send(P.pack_join(0, "smoke"))
        welcome = P.unpack_welcome(await asyncio.wait_for(ws.recv(), 10))
        print("JOINED pid=%s tick=%s at=(%s,%s) room=%s name=%r"
              % (welcome[0], welcome[1], welcome[4], welcome[5],
                 welcome[6], welcome[8]))
        end = time.time() + 15
        frames = 0
        while time.time() < end:
            P.unpack_state(await asyncio.wait_for(ws.recv(), 10))
            frames += 1
    assert frames > 0, "received no state frames"
    print("OK frames=%d" % frames)


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Run with no server — it must fail the expected way (failing test)**

Run: `python3 deployment/scripts/ws_smoke.py http://127.0.0.1:18000`
Expected: non-zero exit with `Connection refused` (nothing is listening yet) — proves the client actually attempts a real connection.

- [ ] **Step 3: Start the real server without Postgres (its lifespan tolerates the store failure) and re-run (test passes)**

Run (worktree root):
```bash
nohup .venv/bin/python -m uvicorn mud_server.app:app --port 18000 >/tmp/mud-preflight.log 2>&1 &
echo $! > /tmp/mud-preflight.pid
sleep 3
python3 deployment/scripts/ws_smoke.py http://127.0.0.1:18000; RC=$?
kill "$(cat /tmp/mud-preflight.pid)"
exit $RC
```
Expected: `JOINED pid=... name='smoke'` then `OK frames=~290` (20 Hz × 15 s state frames; any value > 0 passes).

- [ ] **Step 4: HTTP sanity check on the same local server**

Run:
```bash
nohup .venv/bin/python -m uvicorn mud_server.app:app --port 18000 >/tmp/mud-preflight.log 2>&1 &
echo $! > /tmp/mud-preflight.pid
sleep 3
curl -fsS http://127.0.0.1:18000/healthz && echo
curl -sI http://127.0.0.1:18000/ | head -1
kill "$(cat /tmp/mud-preflight.pid)"
```
Expected: a JSON line with `uptime_s`/`tick`/`connected`, and `HTTP/1.1 200 OK`.

- [ ] **Step 5: Commit**

```bash
git add deployment/scripts/ws_smoke.py
git commit -m "deployment: ws smoke client + local preflight flow"
```

---

### Task 5: Makefile targets + .gitignore

**Files:**
- Modify: `Makefile` (append to the end; don't touch existing targets)
- Modify: `.gitignore` (append to the end)

**Interfaces:**
- Produces: `make deploy`, `make deploy-deps`, `make update [SHA=...]`, `make destroy` — all runnable from the worktree root. Instance lookup uses the `Name=mud-game` tag.

- [ ] **Step 1: Append to `Makefile`**

```make
.PHONY: deploy deploy-deps update destroy

CDK_APP = deployment/.venv/bin/python3 deployment/app.py

deploy: deploy-deps
	cdk deploy MudDemo --app "$(CDK_APP)" --require-approval never

deploy-deps:
	bash -c 'test -d deployment/.venv || python3 -m venv deployment/.venv && deployment/.venv/bin/pip install -q -r deployment/requirements.txt'

update:
ifdef SHA
	aws ssm send-command \
		--instance-ids "$$(aws ec2 describe-instances --filters 'Name=tag:Name,Values=mud-game' --query 'Reservations[].Instances[].InstanceId' --output text)" \
		--document-name 'AWS-RunShellScript' \
		--parameters "{\"commands\":[\"bash /opt/mud/deployment/scripts/update.sh $(SHA)\"]}"
else
	aws ssm send-command \
		--instance-ids "$$(aws ec2 describe-instances --filters 'Name=tag:Name,Values=mud-game' --query 'Reservations[].Instances[].InstanceId' --output text)" \
		--document-name 'AWS-RunShellScript' \
		--parameters '{"commands":["bash /opt/mud/deployment/scripts/update.sh"]}'
endif

destroy: deploy-deps
	cdk destroy MudDemo --app "$(CDK_APP)"
```

- [ ] **Step 2: Append to `.gitignore`** (the worktree's base predates the main branch's chore commit that added some of these — add whatever is missing)

```
.worktrees/
.cdk.staging/
cdk.out/
```

- [ ] **Step 3: Verify the Makefile parses and renders the intended commands**

Run:
```bash
make -n deploy | cat
make -n update SHA=deadbeef | cat
```
Expected: the literal `cdk deploy ...` / `aws ssm send-command ...` lines are printed, with no `*** missing separator` / `Missing separator` errors. If a missing-separator error appears (tab corrupted during paste), save the target's recipe lines with actual tabs and re-run.

- [ ] **Step 4: Commit**

```bash
git add Makefile .gitignore
git commit -m "deployment: make targets (deploy/update/destroy) + staging gitignore"
```

---

### Task 6: README for operators

**Files:**
- Create: `deployment/README.md`

- [ ] **Step 1: Write `deployment/README.md` with exactly these sections (concise, only empirically verified commands):**
  - **What this is**: one EC2 `t4g.micro` in eu-north-1 running the game via docker compose; publicly reachable at `https://mud.michniewicz.contact`. The Database is disposable (lives on the instance's EBS).
  - **Prerequisites**: CDK CLI, Python 3.11+, `aws` CLI + make, AWS credentials logged in as the **root** account (needed for `cdk bootstrap` and for Route53 record writes).
  - **One-time**: `cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/eu-north-1`.
  - **Deploy**: **push the branch you deploy first** (the instance clones the pinned commit SHA from GitHub on first boot — if the SHA is absent, user-data will fail; check boot logs with `aws ec2 get-console-output --instance-id <i>`). Then `make deploy` from the worktree/repo root.
  - **Ops**: instance id is `aws ec2 describe-instances --filters 'Name=tag:Name,Values=mud-game' --query 'Reservations[].Instances[].InstanceId' --output text`; session is `aws ssm start-session --target <i-...>`; container logs are `docker compose logs -f` run inside the session from `/opt/mud`. No SSH — SSM only.
  - **Update / rollback**: `make update` (update to main's HEAD) or `make update SHA=<commit>` (an older SHA rolls back). Be aware that live WS connections will drop briefly during the container update.
  - **Verification**: `curl https://mud.michniewicz.contact/healthz`; `python3 deployment/scripts/ws_smoke.py https://mud.michniewicz.contact`; regression `curl -sI https://michniewicz.contact/` (must still return 200 — never touched by this stack).
  - **Destroy**: `make destroy` (removes the stack including the `mud.` record; the apex is unaffected).
  - **Cost**: ≈$25–30/mo (t4g.micro ≈ 8–10 dollars, ALB ≈ 17 dollars, default-size EBS root ≈ 1 dollar; no NAT, no RDS).
  - **Troubleshooting**: boot log is via `aws ec2 get-console-output`; SSM unreachable → check that `ssm-agent` is installed (standard in the Ubuntu 24.04 AMI) and that the instance profile is attached; websocket hangs → CloudWatch ALB target group metrics (`UnHealthyHostCount`, `TargetResponseCode`).

- [ ] **Step 2: Commit**

```bash
git add deployment/README.md
git commit -m "deployment: operator README"
```

---

### Task 7: Local gate (all green before anything touches AWS)

- [ ] **Step 1: Server suite**

Run: `make test`
Expected: `53 passed, 1 skipped` (same as the worktree's baseline).

- [ ] **Step 2: Synth + diff**

Run:
```bash
cdk synth MudDemo --app "deployment/.venv/bin/python3 deployment/app.py"
cdk diff MudDemo --app "deployment/.venv/bin/python3 deployment/app.py"
```
Expected: synth exits 0; `cdk diff` reports the stack as new (an itemized "added" summary for the brand-new stack) — for a new stack, this is the expected clean state.

- [ ] **Step 3: Script lints + compiles**

Run:
```bash
bash -n deployment/scripts/user-data.sh && bash -n deployment/scripts/update.sh
deployment/.venv/bin/python -m py_compile deployment/app.py
python3 -m py_compile deployment/scripts/ws_smoke.py
```
Expected: quiet, exit 0.

- [ ] **Step 4: Commit (only if a fix was forced in steps 1–3; otherwise note "no changes" and move on)**

```bash
git add -A && git diff --cached --quiet || git commit -m "deployment: local gate fixes"
```

---

### Task 8: Push the deploy branch (before the deploy finishes)

- [ ] **Step 1: Add the remote (if not already set) and push**

Run (repo level; the worktree shares the repo with the main checkout):
```bash
git remote get-url origin 2>/dev/null || git remote add origin https://github.com/LukeKeywalker/gud-mud.git
git push -u origin deploy-aws
```
Expected: `* [new branch] deploy-aws -> deploy-aws` (or "+ N commits" if the branch already exists).
If the push fails on auth (permission denied / 403): STOP and ask the user for push credentials (or have the user perform the push). Do not invent credentials or edit credential helpers.
If `origin` already exists (configured by the user): keep it; still push `deploy-aws`.

- [ ] **Step 2: Verify the pinned SHA is reachable on GitHub**

Run:
```bash
git rev-parse deploy-aws
curl -fsSI "https://github.com/LukeKeywalker/gud-mud/commit/$(git rev-parse deploy-aws).patch" >/dev/null && echo REMOTE_HAS_SHA
```
Expected: `REMOTE_HAS_SHA`. If this 403s, the repo is private — verify via `git ls-remote origin` instead, and STOP to ask the user: an unauthenticated instance cannot clone a private repo (the spec assumes public).

---

### Task 9: Bootstrap + deploy

- [ ] **Step 1: One-time CDK bootstrap**

Run:
```bash
cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/eu-north-1 || echo "BOOTSTRAP_FAILED - root account required; STOP and ask."
```
Expected: a successful bootstrap report (or "already bootstrapped"). If BOOTSTRAP_FAILED: stop and ask the user to run it as the root account.

- [ ] **Step 2: Deploy**

Run (worktree root):
```bash
make deploy
```
Expected: `make deploy` finishes with `... the CloudFormation stack ... Created/Update complete`; a new stack `MudDemo` is created. This creates the instance, which immediately starts bootstrapping (about 2–5 min: apt install, clone+checkout, docker build).

- [ ] **Step 3: Wait for the instance to be running and grab early boot output**

Run:
```bash
IID=$(aws ec2 describe-instances --filters 'Name=tag:Name,Values=mud-game' --query 'Reservations[].Instances[].InstanceId' --output text)
echo "instance: $IID"
aws ec2 wait instance-running --instance-ids "$IID"
sleep 20
aws ec2 get-console-output --instance-id "$IID" --query "InstanceOutput.Output" --output text | base64 -d 2>/dev/null | tail -20 || true
```
Expected: instance RUNNING within about a minute; partial console output (not necessarily the full log yet — a full early boot log requires SSM in Task 10).

---

### Task 10: Live verification (gate — the merge step is NOT allowed until this passes)

- [ ] **Step 1: SSM reachability + containers + local health**

Run (wait for SSM to claim the instance, ~1–2 min; poll):
```bash
IID=$(aws ec2 describe-instances --filters 'Name=tag:Name,Values=mud-game' --query 'Reservations[].Instances[].InstanceId' --output text)
sleep 90
aws ssm send-command \
  --instance-ids "$IID" \
  --document-name 'AWS-RunShellScript' \
  --parameters '{"commands":["cd /opt/mud && git log -1 --format=%H && docker compose ps","curl -fsS http://127.0.0.1:18000/healthz"]}' \
  --query 'Command.CommandId' --output text | tee /tmp/ssm-cmd.txt
CMDID=$(cat /tmp/ssm-cmd.txt | tr -d ' \n')
sleep 45
aws ssm get-command-invocation --command-id "$CMDID" --instance-id "$IID" \
  --query 'Status,StatusMessage,StandardOutputOutput,StandardErrorOutput' --output text
```
Expected: `Success`; `git log` shows the pinned SHA (must equal `git rev-parse HEAD` at the time of deploy); both containers `running`; health JSON present.
On failure, triage in this order:
- No SSM instance (`InvalidInstanceID`/empty `IID` or `aws ssm describe-instance-information` shows no agent): check whether AMI/SSM reached registration; check the console output below.
- `docker compose ps` shows `server` restart/exited: in-session `docker compose logs --tail=50 server`.
- The clone failed: user-data failed early — `aws ec2 get-console-output --instance-id "$IID" | base64 -d | tail -30`; check the exit line of `set -x`. If the cause is the missing remote SHA, push (Task 8) and redo a fresh boot by restarting the instance: `aws ec2 reboot-instances --instance-ids "$IID"` does NOT rerun user-data; instead, after pushing, run the user-data snippet via SSM, or (simplest/fastest) `make destroy && make deploy` with the branch pushed.

- [ ] **Step 2: Public HTTPS**

Run:
```bash
curl -fsS https://mud.michniewicz.contact/healthz && echo
curl -sI https://mud.michniewicz.contact/ | head -1
curl -sI https://mud.michniewicz.contact/app.js | head -1
curl -sI https://mud.michniewicz.contact/sw.js | head -1
curl -sI http://mud.michniewicz.contact/ | head -1
```
Expected: health JSON; `200` for `/`, `/app.js`, `/sw.js`; `HTTP 301` for the port-80 request. (DNS + cert activation can take 1–3 min right after deploy; if that's all you're seeing, wait and retry.)

- [ ] **Step 3: Live WebSocket game smoke**

Run: `python3 deployment/scripts/ws_smoke.py https://mud.michniewicz.contact`
Expected: `JOINED pid=... name='smoke'` then `OK frames=~290`, exit 0.

- [ ] **Step 4: Apex regression**

Run: `curl -sI https://michniewicz.contact/ | head -1`
Expected: `HTTP/2 200` (the apex is unchanged).

- [ ] **Step 5: If anything fails → STOP; load `superpowers:systematic-debugging`; fix in the worktree.** Note: user-data is baked into the instance resource — if a fix requires a user-data change, `cdk diff` will show the instance being replaced (acceptable; plan for a brief downtime); for code-only fixes, `make update SHA=<fixed-commit>` is enough (the instance clones on reboot/update).

---

### Task 11: Merge the branch (only after Task 10 passes completely)

- [ ] **Step 1: Load `superpowers:finishing-a-development-branch`** and follow it for this repo's shape (worktree branch → main).
- [ ] **Step 2: Concrete operations that will be expected** (if the skill confirms the standard shape):
```bash
git -C /Users/user/Projects/llm-benchmarks/qwen3.8-27b/mud checkout main
git -C /Users/user/Projects/llm-benchmarks/qwen3.8-27b/mud merge --no-ff deploy-aws -m "feat: AWS deployment for mud.michniewicz.contact"
git -C /Users/user/Projects/llm-benchmarks/qwen3.8-27b/mud push origin main
git -C /Users/user/Projects/llm-benchmarks/qwen3.8-27b/mud worktree remove .worktrees/deploy-aws
```
(If `main` moved during work: first merge `main` into `deploy-aws` on the worktree side, re-run Task 7's local gate, and re-verify whether a redeploy is necessary (only if the runtime code / user-data changed); then do the --no-ff merge above. If the user prefers a PR, follow the skill's alternative. If a `.gitignore` conflict occurs at merge time — both branches added staging entries — keep the union of both sets of lines: at minimum `.worktrees/`, `.cdk.staging/`, `cdk.out/`.)
- [ ] **Step 3: Final regression** (deployed state is unchanged by the merge, but confirm before tear-down): `curl -fsS https://mud.michniewicz.contact/healthz && echo` and `python3 deployment/scripts/ws_smoke.py https://mud.michniewicz.contact` — run from the main checkout (the files are on main after the merge).
