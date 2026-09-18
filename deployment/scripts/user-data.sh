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
