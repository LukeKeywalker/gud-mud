#!/usr/bin/env bash
# Operator-side `make update`: send update.sh to the game instance via SSM and wait for the
# result. Fails loudly if the remote update fails or times out. Usage: update_remote.sh [SHA]
set -uo pipefail

SHA="${1:-}"
CMD="bash /opt/mud/deployment/scripts/update.sh${SHA:+ $SHA}"

IID=$(aws ec2 describe-instances --filters 'Name=tag:Name,Values=mud-game' \
  --query 'Reservations[].Instances[].InstanceId' --output text)
[ -n "${IID:-}" ] || { echo "no instance tagged Name=mud-game" >&2; exit 1; }

CID=$(aws ssm send-command --instance-ids "$IID" \
  --document-name 'AWS-RunShellScript' \
  --parameters "$(printf '{"commands":["%s"]}' "$CMD")" \
  --timeout '{"DurationSeconds": 1800}' \
  --query 'Command.CommandId' --output text) || { echo "failed to send SSM command" >&2; exit 1; }
echo "sent SSM command $CID to $IID: $CMD (30m timeout)"

OUT=""
STATUS=""
for _ in $(seq 1 190); do
  OUT=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$IID" 2>/dev/null)
  STATUS=$(printf '%s' "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Status","Pending"))' 2>/dev/null)
  [ "$STATUS" = "Pending" ] || [ "$STATUS" = "InProgress" ] || break
  sleep 10
done

printf '%s' "$OUT" | python3 -c '
import json, sys
inv = json.load(sys.stdin)
print(inv.get("StandardOutputContent", "").rstrip())
err = inv.get("StandardErrorContent", "").strip()
if err:
    print("stderr:", err, file=sys.stderr)
sys.exit(0 if inv.get("Status") == "Success" else 1)
' && echo "update OK" || { echo "update FAILED (status: ${STATUS:-unknown})" >&2; exit 1; }
