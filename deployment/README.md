# AWS deployment

One EC2 `t4g.micro` in `eu-north-1` running the game via docker compose, publicly reachable at
`https://mud.michniewicz.contact`. The database is disposable and lives on the instance's EBS
volume — destroying the stack throws game state away (intentional).

## Prerequisites

- CDK CLI, Python 3.11+
- `aws` CLI + `make`
- AWS credentials logged in as the **root** account (needed for `cdk bootstrap` and Route53 record writes)

## One-time bootstrap

```bash
cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/eu-north-1
```

## Deploy

**Push the branch you deploy first.** The instance clones the pinned commit SHA from GitHub on
first boot — if the SHA isn't on the remote, user-data fails. Check boot logs with
`aws ec2 get-console-output --instance-id <i-...>`.

```bash
make deploy   # run from the worktree/repo root
```

## Ops

No SSH — SSM only.

```bash
# instance id
aws ec2 describe-instances --filters 'Name=tag:Name,Values=mud-game' \
  --query 'Reservations[].Instances[].InstanceId' --output text

# shell in
aws ssm start-session --target i-...

# on the instance
cd /opt/mud && docker compose -f docker-compose.yml -f deployment/compose.ec2.yml logs -f
```

## Update / rollback

```bash
make update              # checkout main and fast-forward it; rebuild containers
make update SHA=<commit> # run an older commit (rollback)
```

Live WebSocket connections drop briefly during the container update.

## Verification

```bash
curl https://mud.michniewicz.contact/healthz
python3 deployment/scripts/ws_smoke.py https://mud.michniewicz.contact
curl -sI https://michniewicz.contact/   # must still be 200; this stack never touches the apex
```

## Destroy

```bash
make destroy   # removes the stack including the mud. records; apex unaffected
```

## Cost

≈$25–30/mo: t4g.micro ≈ $8–10, ALB ≈ $17, default-size EBS root ≈ $1. No NAT, no RDS.

## Troubleshooting

- Boot failures: `aws ec2 get-console-output --instance-id i-...` (e.g. the pinned SHA was missing from GitHub).
- SSM unreachable: confirm `ssm-agent` installed (standard in the Ubuntu 24.04 AMI) and the instance profile attached.
- WebSocket hangs: CloudWatch ALB target-group metrics (`UnHealthyHostCount`, `TargetResponseCode`).
