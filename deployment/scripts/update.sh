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
